const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  validateJournalRecord,
  validateActionRecord,
  validateViewerState,
  validateSummary,
  validateSSEEvent,
  validateManifest,
  validateMcpCallResult,
  validateActionMessage,
  validateSanitizedStatus,
  validateFinalResponse,
  validateErrorPayload,
  computeViewerStateHash,
  canonicalizeJson
} = require("../shared/validators.standalone");

function getBridge() {
  return require("../scripts/maze-bridge");
}

const ROOT_DIR = path.resolve(__dirname, "..");
const MAX_WAL_LINE_BYTES = 65536; // 64KB hard limit
const LEASE_TTL_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 10000;
const PROJECTION_WAIT_TIMEOUT_MS = 500;
const CONTROLLER_TOKEN_TTL_MS = 24 * 3600 * 1000; // 24 hours
const VIEWER_TOKEN_TTL_MS = 2 * 3600 * 1000; // 2 hours

function resolveDataHome() {
  const custom = process.env.MAZEBENCH_DATA_HOME || process.env.MAZEBENCH_HOME;
  if (custom) {
    return path.resolve(custom.replace(/^~(?=$|\/|\\)/, os.homedir()));
  }
  return path.join(os.homedir(), ".mazebench");
}

function assertIsolation(targetPath, dataHome) {
  let resolved = path.resolve(targetPath);
  let resolvedDataHome = path.resolve(dataHome);
  let resolvedRepo = path.resolve(ROOT_DIR);

  try {
    if (fs.existsSync(resolved)) resolved = fs.realpathSync(resolved);
  } catch (_e) {}
  try {
    if (fs.existsSync(resolvedDataHome)) resolvedDataHome = fs.realpathSync(resolvedDataHome);
  } catch (_e) {}
  try {
    if (fs.existsSync(resolvedRepo)) resolvedRepo = fs.realpathSync(resolvedRepo);
  } catch (_e) {}

  const relDataHome = path.relative(resolvedDataHome, resolved);
  if (relDataHome.startsWith("..") || path.isAbsolute(relDataHome)) {
    throw new Error(`Isolation assertion failed: ${resolved} is not inside MAZEBENCH_DATA_HOME (${resolvedDataHome})`);
  }

  const relRepo = path.relative(resolvedRepo, resolved);
  if (!relRepo.startsWith("..") && !path.isAbsolute(relRepo)) {
    throw new Error(`Isolation assertion failed: ${resolved} is inside the Git repo root (${resolvedRepo})`);
  }
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "EPERM") return true;
    return false;
  }
}

class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this._queue.push(() => {
        this._locked = true;
        resolve(() => this.release());
      });
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }

  async withLock(fn) {
    const unlock = await this.acquire();
    try {
      return await fn();
    } finally {
      unlock();
    }
  }
}

class ExternalPlayService {
  constructor(options = {}) {
    this.options = options || {};
    this.dataHome = options.dataHome || resolveDataHome();
    this.runsDir = path.join(this.dataHome, "external-runs");
    this.quarantineDir = path.join(this.dataHome, "external-quarantine");
    this.serverJsonPath = path.join(this.dataHome, "server.json");
    this.serverLockPath = path.join(this.dataHome, "server.lock");
    this.viewerKeyPath = path.join(this.dataHome, "viewer-signing.key");

    this.worldBundleProvider = options.worldBundleProvider || null;

    this.serviceState = "INITIALIZING";
    this.instanceId = options.instanceId || `srv-${crypto.randomUUID()}`;
    this.activeRunId = null;

    this.controllerTokens = new Map(); // token -> { instanceId, controllerId, declaredCli, createdAt }
    this.viewerKey = null;

    this.mcpBootstrapNonce = crypto.randomBytes(32).toString("hex");

    this.admissionMutex = new AsyncMutex();
    this.credentialMutex = new AsyncMutex();

    // Map of runId -> RunInstance
    this.runs = new Map();

    this.serverPort = options.port || 3000;
    this.serverHost = options.host || "127.0.0.1";
    this.defaultMaxActions = options.defaultMaxActions || 256;
  }

  async initialize() {
    this.dataHome = this.options.dataHome || resolveDataHome();
    this.runsDir = path.join(this.dataHome, "external-runs");
    this.quarantineDir = path.join(this.dataHome, "external-quarantine");
    this.serverJsonPath = path.join(this.dataHome, "server.json");
    this.serverLockPath = path.join(this.dataHome, "server.lock");
    this.viewerKeyPath = path.join(this.dataHome, "viewer-signing.key");

    this.serviceState = "INITIALIZING";

    // 1. Assert isolations
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.quarantineDir, { recursive: true });
    assertIsolation(this.runsDir, this.dataHome);
    assertIsolation(this.quarantineDir, this.dataHome);
    assertIsolation(this.serverLockPath, this.dataHome);
    assertIsolation(this.serverJsonPath, this.dataHome);
    assertIsolation(this.viewerKeyPath, this.dataHome);

    // 2. Acquire server.lock
    this._acquireServerLock();

    // 3. Initialize viewer signing key
    this._loadOrGenerateViewerKey();

    // 4. Scan & Recover existing runs
    await this._recoverRuns();

    // 5. Recover an existing non-terminal run without creating a new record
    await this._selectActiveRun();

    // 6. Mark READY and write initial server.json
    this.serviceState = "READY";
    this._writeServerJson();
  }

  _acquireServerLock() {
    if (fs.existsSync(this.serverLockPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(this.serverLockPath, "utf8"));
        if (pidAlive(content.pid) && content.pid !== process.pid) {
          throw new Error(`Another MazeBench instance is running with PID ${content.pid}. Stop it before starting a new one.`);
        }
      } catch (err) {
        if (err.message.includes("Another MazeBench instance")) throw err;
      }
      fs.rmSync(this.serverLockPath, { force: true });
    }

    const lockData = {
      pid: process.pid,
      instance_id: this.instanceId,
      locked_at: new Date().toISOString()
    };
    fs.writeFileSync(this.serverLockPath, JSON.stringify(lockData, null, 2), { flag: "wx" });
  }

  _releaseServerLock() {
    try {
      if (fs.existsSync(this.serverLockPath)) {
        const content = JSON.parse(fs.readFileSync(this.serverLockPath, "utf8"));
        if (content.pid === process.pid) {
          fs.rmSync(this.serverLockPath, { force: true });
        }
      }
    } catch (_e) {}
  }

  _loadOrGenerateViewerKey() {
    if (fs.existsSync(this.viewerKeyPath)) {
      this.viewerKey = fs.readFileSync(this.viewerKeyPath, "utf8").trim();
    } else {
      this.viewerKey = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(this.viewerKeyPath, this.viewerKey, "utf8");
    }
  }

  _writeServerJson() {
    const displayHost = this.serverHost === "0.0.0.0" || this.serverHost === "::" ? "localhost" : this.serverHost;
    const url = `http://${displayHost}:${this.serverPort}`;
    const payload = {
      pid: process.pid,
      instance_id: this.instanceId,
      host: this.serverHost,
      port: this.serverPort,
      url,
      active_run_id: this.activeRunId,
      mcp_bootstrap_nonce: this.mcpBootstrapNonce,
      started_at: new Date().toISOString()
    };

    const tempPath = `${this.serverJsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tempPath, this.serverJsonPath);
  }

  _clearServerJson() {
    try {
      if (fs.existsSync(this.serverJsonPath)) {
        const content = JSON.parse(fs.readFileSync(this.serverJsonPath, "utf8"));
        if (content.pid === process.pid) {
          fs.rmSync(this.serverJsonPath, { force: true });
        }
      }
    } catch (_e) {}
  }

  async _recoverRuns() {
    const entries = fs.readdirSync(this.runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      const runDir = path.join(this.runsDir, runId);
      const manifestPath = path.join(runDir, "manifest.json");
      const journalPath = path.join(runDir, "journal.jsonl");

      if (!fs.existsSync(manifestPath) || !fs.existsSync(journalPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const runInstance = new RunInstance(this, runId, runDir, manifest);
        await runInstance.replayJournal();
        this.runs.set(runId, runInstance);
      } catch (err) {
        console.error(`Failed to recover run ${runId}, isolating:`, err);
        const qTarget = path.join(this.quarantineDir, runId);
        fs.renameSync(runDir, qTarget);
      }
    }
  }

  async _selectActiveRun() {
    const nonTerminalRuns = [];
    for (const [runId, run] of this.runs.entries()) {
      if (["armed", "active", "finalizing"].includes(run.status)) {
        nonTerminalRuns.push(run);
      }
    }

    if (nonTerminalRuns.length === 1) {
      const run = nonTerminalRuns[0];
      this.activeRunId = run.runId;
      await run.handleServerRestart();
    } else if (nonTerminalRuns.length > 1) {
      // Pick latest started_at / created_at
      nonTerminalRuns.sort((a, b) => {
        const tA = Date.parse(a.startedAt || a.manifest.created_at || 0);
        const tB = Date.parse(b.startedAt || b.manifest.created_at || 0);
        return tB - tA;
      });
      const selected = nonTerminalRuns[0];
      this.activeRunId = selected.runId;
      await selected.handleServerRestart();

      for (let i = 1; i < nonTerminalRuns.length; i++) {
        const stale = nonTerminalRuns[i];
        console.warn(`Quarantining conflicting non-terminal run ${stale.runId}`);
        this.runs.delete(stale.runId);
        const target = path.join(this.quarantineDir, stale.runId);
        fs.renameSync(stale.runDir, target);
      }
    }
  }

  _clearActiveRun(runId) {
    if (this.activeRunId !== runId) return;
    this.activeRunId = null;
    if (this.serviceState === "READY") this._writeServerJson();
  }

  async _createArmedRunInternal(options = {}) {
    const runId = `ext-${crypto.randomUUID()}`;
    const runDir = path.join(this.runsDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, "blobs"), { recursive: true });

    const usesLegacyDuration = options.durationMs !== undefined && options.maxActions === undefined;
    const durationMs = usesLegacyDuration ? options.durationMs : null;
    const maxActions = usesLegacyDuration ? null : (options.maxActions || this.defaultMaxActions);
    const winThreshold = options.winThreshold || null;
    const modelName = options.modelName || null;
    const harnessName = options.harnessName || null;

    // Freeze world bundle at armed time
    const rawBundle = this.worldBundleProvider ? this.worldBundleProvider() : { worldRevision: "0".repeat(64) };
    const worldBundleStr = JSON.stringify(rawBundle, null, 2);
    const worldDigest = rawBundle.worldRevision || crypto.createHash("sha256").update(worldBundleStr, "utf8").digest("hex");
    fs.writeFileSync(path.join(runDir, "world-bundle.json"), worldBundleStr, "utf8");

    const manifest = {
      run_id: runId,
      run_kind: "external_play",
      execution_class: "external-unverified",
      benchmark_eligible: false,
      created_at: new Date().toISOString(),
      ...(maxActions ? { max_actions: maxActions } : { duration_ms: durationMs }),
      ...(winThreshold ? { win_threshold: winThreshold } : {})
    };

    if (!validateManifest(manifest)) {
      throw new Error("Invalid manifest: " + JSON.stringify(validateManifest.errors));
    }

    const manifestStr = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(runDir, "manifest.json"), manifestStr, "utf8");
    const manifestDigest = crypto.createHash("sha256").update(manifestStr, "utf8").digest("hex");

    // Create base session to get base viewer state
    const baseBridgeSession = getBridge().createSession({
      gameId: "maze",
      gameWonGemCount: 100,
      levelId: "level_HxI",
      pitch: 1,
      yaw: 0,
      observationMode: "text"
    });

    const baseViewerState = extractViewerState(baseBridgeSession, 0, worldDigest);
    const baseViewerStateHash = computeViewerStateHash(baseViewerState);

    const baseViewerStateStr = JSON.stringify(baseViewerState, null, 2);
    fs.writeFileSync(path.join(runDir, "base-viewer-state.json"), baseViewerStateStr, "utf8");

    const runInstance = new RunInstance(this, runId, runDir, manifest, {
      worldBundleDigest: worldDigest,
      baseViewerStateDigest: baseViewerStateHash,
      baseViewerState,
      durationMs,
      maxActions,
      winThreshold,
      modelName,
      harnessName
    });
    runInstance.gameSession = baseBridgeSession;

    // Write initial run_armed journal entry
    const armedRecord = {
      journal_seq: 1,
      timestamp: manifest.created_at,
      run_id: runId,
      type: "run_armed",
      manifest,
      manifest_digest: manifestDigest,
      world_bundle_digest: worldDigest,
      base_viewer_state_digest: baseViewerStateHash,
      ...(maxActions ? { max_actions: maxActions } : { duration_ms: durationMs }),
      ...(winThreshold ? { win_threshold: winThreshold } : {}),
      model_name: modelName,
      harness_name: harnessName
    };

    await runInstance.appendJournalRecord(armedRecord);
    this.runs.set(runId, runInstance);
    return runInstance;
  }

  // HTTP & Admission Handlers

  async handleControllerSession(nonce, clientInfo = {}) {
    return await this.credentialMutex.withLock(async () => {
      if (!nonce || nonce !== this.mcpBootstrapNonce) {
        throw { status: 403, code: "FORBIDDEN", message: "Invalid mcp bootstrap nonce" };
      }
      // Generate new nonce immediately for subsequent clients/restarts
      this.mcpBootstrapNonce = crypto.randomBytes(32).toString("hex");
      this._writeServerJson();

      const controllerId = clientInfo.name ? `${clientInfo.name}-${crypto.randomUUID().slice(0, 8)}` : `ctrl-${crypto.randomUUID()}`;
      const token = `mcp_${crypto.randomBytes(32).toString("hex")}`;
      this.controllerTokens.set(token, {
        instanceId: this.instanceId,
        controllerId,
        declaredCli: clientInfo.name || "unknown",
        createdAt: Date.now()
      });

      return {
        controller_token: token,
        controller_id: controllerId,
        instance_id: this.instanceId
      };
    });
  }

  validateControllerToken(authHeader) {
    if (!authHeader) return null;
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const info = this.controllerTokens.get(token);
    if (!info) return null;
    if (info.instanceId !== this.instanceId) return null;
    if (Date.now() - info.createdAt > CONTROLLER_TOKEN_TTL_MS) {
      this.controllerTokens.delete(token);
      return null;
    }
    return info;
  }

  generateViewerToken(runId) {
    const payload = {
      sub: "viewer",
      run_id: runId,
      instance_id: this.instanceId,
      exp: Date.now() + VIEWER_TOKEN_TTL_MS
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", this.viewerKey).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  validateViewerToken(token, runId) {
    if (!token) return false;
    const cleanToken = token.replace(/^Bearer\s+/i, "").trim();
    const parts = cleanToken.split(".");
    if (parts.length !== 2) return false;
    const [body, sig] = parts;
    const expectedSig = crypto.createHmac("sha256", this.viewerKey).update(body).digest("base64url");
    if (sig !== expectedSig) return false;

    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (payload.sub !== "viewer") return false;
      if (payload.run_id !== runId) return false;
      if (payload.instance_id !== this.instanceId) return false;
      if (Date.now() > payload.exp) return false;
      return true;
    } catch (_e) {
      return false;
    }
  }

  async createRun(options = {}) {
    let durationMs;
    if (options.durationMs !== undefined) {
      if (!Number.isSafeInteger(options.durationMs) || options.durationMs < 60000 || options.durationMs > 21600000) {
        throw { status: 400, code: "INVALID_ARGUMENT", message: "duration_ms must be an integer between 60000 and 21600000 (60s to 6h)" };
      }
      durationMs = options.durationMs;
    }

    let maxActions = this.defaultMaxActions;
    if (options.maxActions !== undefined) {
      if (!Number.isSafeInteger(options.maxActions) || options.maxActions < 1 || options.maxActions > 100000) {
        throw { status: 400, code: "INVALID_ARGUMENT", message: "max_actions must be an integer between 1 and 100000" };
      }
      maxActions = options.maxActions;
    } else if (durationMs !== undefined) {
      // Backward-compatible service API for persisted legacy timed runs and old callers.
      maxActions = undefined;
    }

    let winThreshold;
    if (options.winThreshold !== undefined) {
      if (!Number.isSafeInteger(options.winThreshold) || options.winThreshold < 1 || options.winThreshold > 100) {
        throw { status: 400, code: "INVALID_ARGUMENT", message: "win_threshold must be an integer between 1 and 100" };
      }
      winThreshold = options.winThreshold;
    }

    return await this.admissionMutex.withLock(async () => {
      for (const [, run] of this.runs.entries()) {
        if (run.finalizeReason === "reconfigured_before_start" || ["won", "action_limit", "timed_out", "cancelled", "failed"].includes(run.status)) {
          continue;
        }
        if (["active", "finalizing"].includes(run.status)) {
          throw { status: 409, code: "RUN_ACTIVE", message: `A run (${run.runId}) is currently ${run.status}` };
        }
        if (run.status === "armed") {
          await run.sessionMutex.withLock(async () => {
            if (run.status !== "armed" || run.startedAt || run.lastActionSeq > 0 || run.currentLease) {
              throw { status: 409, code: "RUN_ALREADY_CLAIMED", message: `Run ${run.runId} has already been claimed by a controller` };
            }
            await run._startFinalize("cancelled", "reconfigured_before_start");
            run.cleanup();
          });
        }
      }

      const run = await this._createArmedRunInternal({
        durationMs,
        maxActions,
        winThreshold,
        modelName: options.modelName || null,
        harnessName: options.harnessName || null
      });
      this.activeRunId = run.runId;
      this._writeServerJson();
      return run;
    });
  }

  getRun(runId) {
    return this.runs.get(runId) || null;
  }

  listRuns() {
    const result = [];
    for (const [runId, run] of this.runs.entries()) {
      result.push({
        run_id: runId,
        status: run.status,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        outcome: run.outcome,
        manifest: run.manifest
      });
    }
    return result;
  }

  shutdown() {
    this.serviceState = "SHUTDOWN";
    for (const [, run] of this.runs.entries()) {
      run.cleanup();
    }
    this._releaseServerLock();
    this._clearServerJson();
  }
}

class RunInstance {
  constructor(service, runId, runDir, manifest, initialOpts = {}) {
    this.service = service;
    this.runId = runId;
    this.runDir = runDir;
    this.manifest = manifest;

    this.journalPath = path.join(runDir, "journal.jsonl");
    this.actionsPath = path.join(runDir, "actions.jsonl");
    this.baseViewerStatePath = path.join(runDir, "base-viewer-state.json");
    this.manifestPath = path.join(runDir, "manifest.json");
    this.summaryPath = path.join(runDir, "summary.json");
    this.worldBundlePath = path.join(runDir, "world-bundle.json");
    this.blobsDir = path.join(runDir, "blobs");

    this.status = "armed"; // armed | active | finalizing | won | action_limit | timed_out | cancelled | failed
    this.outcome = null;
    this.startedAt = null;
    this.deadlineAt = null;
    this.deadlineMonotonicMs = null;
    this.endedAt = null;
    this.durationMs = manifest.duration_ms || null;
    this.maxActions = manifest.max_actions || null;
    this.winThreshold = manifest.win_threshold || null;
    this.declaredCli = null;
    this.modelName = initialOpts.modelName || null;
    this.harnessName = initialOpts.harnessName || null;

    this.worldBundleDigest = initialOpts.worldBundleDigest || null;
    this.baseViewerStateDigest = initialOpts.baseViewerStateDigest || null;
    this.baseViewerState = initialOpts.baseViewerState || null;

    this.currentViewerState = this.baseViewerState;
    this.currentViewerStateHash = this.baseViewerStateDigest;

    this.lastJournalSeq = 0;
    this.projectedJournalSeq = 0;
    this.lastActionSeq = 0;
    this.lastEventId = 0;
    this.maxLeaseEpoch = 0;
    this.currentLease = null; // { controllerId, leaseId, leaseEpoch, expiresAt }

    this.finalizeSeq = 0;
    this.targetOutcome = null;
    this.finalizeStartedAt = null;
    this.finalizeReason = null;
    this.endedEventId = null;
    this.summaryDigest = null;
    this.finalResponse = null;

    // Mutexes
    this.sessionMutex = new AsyncMutex();
    this.projectionMutex = new AsyncMutex();

    // In-memory runtime session
    this.gameSession = null;
    this.subscribers = new Set(); // SSE subscribers: res objects
    this.watermarkWaiters = []; // { targetSeq, resolve }

    this.leaseTimer = null;
    this.deadlineTimer = null;

    this.operationIndex = new Map(); // operation_id -> final record / response
  }

  async appendJournalRecord(record) {
    if (!validateJournalRecord(record)) {
      throw new Error(`Invalid journal record (${record.type}): ` + JSON.stringify(validateJournalRecord.errors));
    }

    const line = JSON.stringify(record) + "\n";
    const byteLength = Buffer.byteLength(line, "utf8");
    if (byteLength > MAX_WAL_LINE_BYTES) {
      throw new Error(`Journal record exceeded 64KB hard limit (${byteLength} bytes)`);
    }

    const fd = fs.openSync(this.journalPath, "a");
    try {
      fs.writeSync(fd, line, null, "utf8");
      try {
        fs.fdatasyncSync(fd);
      } catch (_e) {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }

    // Append to actions.jsonl if action_committed
    if (record.type === "action_committed" && record.action_record) {
      const actionLine = JSON.stringify(record.action_record) + "\n";
      fs.appendFileSync(this.actionsPath, actionLine, "utf8");
    }

    this.lastJournalSeq = record.journal_seq;

    // Index operation for idempotency
    if (record.operation_id) {
      this.operationIndex.set(record.operation_id, record);
    }

    // Apply to in-memory state and projection
    this._applyJournalRecord(record);
    this._publishJournalRecord(record);
  }

  _writeImmutableBlob(digest, content) {
    const blobPath = path.join(this.blobsDir, `${digest}.json`);
    if (fs.existsSync(blobPath)) {
      if (fs.readFileSync(blobPath, "utf8") !== content) {
        throw new Error(`Content-addressed blob ${digest} already exists with different bytes`);
      }
      return;
    }

    const tempPath = `${blobPath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
    try {
      fs.renameSync(tempPath, blobPath);
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  }

  _writeSummaryAtomically(content) {
    if (fs.existsSync(this.summaryPath) && fs.readFileSync(this.summaryPath, "utf8") === content) {
      return;
    }
    const tempPath = `${this.summaryPath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
    try {
      fs.renameSync(tempPath, this.summaryPath);
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  }

  _applyJournalRecord(record) {
    switch (record.type) {
      case "run_armed":
        this.status = "armed";
        this.worldBundleDigest = record.world_bundle_digest;
        this.baseViewerStateDigest = record.base_viewer_state_digest;
        this.durationMs = record.duration_ms || null;
        this.maxActions = record.max_actions || null;
        this.winThreshold = record.win_threshold || null;
        break;

      case "run_started":
        this.status = "active";
        this.startedAt = record.started_at;
        this.deadlineAt = record.deadline_at || null;
        this.maxLeaseEpoch = record.lease_epoch;
        this.declaredCli = record.declared_cli || record.controller_id?.split("-")[0] || "stdio-mcp";
        this.currentLease = {
          controllerId: record.controller_id,
          declaredCli: this.declaredCli,
          leaseId: record.lease_id,
          leaseEpoch: record.lease_epoch,
          expiresAt: Date.parse(record.lease_expires_at)
        };
        this._armDeadlineTimer();
        this._armLeaseTimer();
        break;

      case "lease_attached":
        this.maxLeaseEpoch = record.lease_epoch;
        this.declaredCli = record.declared_cli || record.controller_id?.split("-")[0] || this.declaredCli || "stdio-mcp";
        this.currentLease = {
          controllerId: record.controller_id,
          declaredCli: this.declaredCli,
          leaseId: record.lease_id,
          leaseEpoch: record.lease_epoch,
          expiresAt: Date.parse(record.lease_expires_at)
        };
        this._armLeaseTimer();
        break;

      case "lease_revoked":
        this.currentLease = null;
        if (this.leaseTimer) {
          clearTimeout(this.leaseTimer);
          this.leaseTimer = null;
        }
        break;

      case "action_committed":
        this.lastActionSeq = record.action_seq;
        this.lastEventId = record.event_id;
        this.currentViewerStateHash = record.viewer_state_hash;
        break;

      case "action_rejected":
        this.lastEventId = record.event_id;
        break;

      case "finalize_intent":
        this.status = "finalizing";
        this.targetOutcome = record.target_outcome;
        this.finalizeSeq = record.finalize_seq;
        this.finalizeStartedAt = record.finalize_started_at;
        this.finalizeReason = record.reason;
        if (this.leaseTimer) clearTimeout(this.leaseTimer);
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        break;

      case "run_finalized":
        this.status = record.outcome;
        this.outcome = record.outcome;
        this.endedAt = record.timestamp;
        this.summaryDigest = record.summary_digest;
        this.finalResponse = record.final_response;
        this.lastEventId = record.ended_event_id;
        this.endedEventId = record.ended_event_id;
        // Do NOT call cleanup() immediately here, let _publishJournalRecord broadcast ended event first!
        break;

      case "run_failed":
        this.status = "failed";
        this.outcome = "failed";
        this.endedAt = record.failed_at;
        this.finalResponse = record.final_response;
        this.lastEventId = record.ended_event_id;
        this.endedEventId = record.ended_event_id;
        // Do NOT call cleanup() immediately here, let _publishJournalRecord broadcast ended event first!
        break;
    }
  }

  _publishJournalRecord(record) {
    this.projectedJournalSeq = record.journal_seq;

    // Wake up watermark waiters
    const remaining = [];
    for (const waiter of this.watermarkWaiters) {
      if (this.projectedJournalSeq >= waiter.targetSeq) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.watermarkWaiters = remaining;

    // Broadcast SSE events if applicable
    if (record.type === "run_started") {
      const sseData = {
        event_id: this.lastEventId || 1,
        type: "started",
        started_at: record.started_at,
        ...(this.maxActions
          ? { max_actions: this.maxActions }
          : { deadline_at: record.deadline_at, duration_ms: this.durationMs }),
        controller_id: record.controller_id,
        declared_cli: record.declared_cli
      };
      this._broadcastSSE(sseData);
    } else if (record.type === "action_committed") {
      const sseData = {
        event_id: record.event_id,
        type: "action",
        action_seq: record.action_seq,
        tool: record.action_record.tool,
        action_record: record.action_record
      };
      this._broadcastSSE(sseData);
    } else if (record.type === "action_rejected") {
      const sseData = {
        event_id: record.event_id,
        type: "action_rejected",
        action_seq: this.lastActionSeq,
        tool: record.tool,
        error: record.error_payload.message
      };
      this._broadcastSSE(sseData);
    } else if (record.type === "run_finalized" || record.type === "run_failed") {
      const sseData = {
        event_id: record.ended_event_id,
        type: "ended",
        action_seq: this.lastActionSeq,
        outcome: record.outcome,
        summary_digest: record.summary_digest || record.partial_summary_digest || null,
        summary_url: record.final_response?.summary_url || null
      };
      // Broadcast ended event to all subscribers before closing connections
      this._broadcastSSE(sseData);

      // Gracefully close all subscriber streams after end event
      for (const subscriber of this.subscribers) {
        try {
          subscriber.end();
        } catch (_e) {}
      }
      this.subscribers.clear();
      this.cleanup();
    }
  }

  _broadcastSSE(eventData) {
    if (!validateSSEEvent(eventData)) {
      console.error("Invalid SSE event:", validateSSEEvent.errors);
      return;
    }
    const payload = `id: ${eventData.event_id}\nevent: ${eventData.type}\ndata: ${JSON.stringify(eventData)}\n\n`;
    for (const subscriber of this.subscribers) {
      try {
        subscriber.write(payload);
        if (typeof subscriber.flush === "function") subscriber.flush();
      } catch (_e) {
        this.subscribers.delete(subscriber);
      }
    }
  }

  async waitForWatermark(targetSeq, timeoutMs = PROJECTION_WAIT_TIMEOUT_MS) {
    if (this.projectedJournalSeq >= targetSeq) return true;
    return new Promise((resolve) => {
      let timer = null;
      const waiter = {
        targetSeq,
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve(true);
        }
      };
      this.watermarkWaiters.push(waiter);
      timer = setTimeout(() => {
        const idx = this.watermarkWaiters.indexOf(waiter);
        if (idx >= 0) this.watermarkWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
    });
  }

  _armLeaseTimer() {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (!this.currentLease) return;
    const delay = Math.max(100, this.currentLease.expiresAt - Date.now());
    this.leaseTimer = setTimeout(() => this._handleLeaseTimeout(), delay);
  }

  _armDeadlineTimer() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (!this.deadlineAt) return;
    const remaining = Date.parse(this.deadlineAt) - Date.now();
    this.deadlineMonotonicMs = Number(process.hrtime.bigint() / 1000000n) + Math.max(0, remaining);
    if (remaining <= 0) {
      setTimeout(() => this._handleDeadlineTimeout(), 0);
    } else {
      this.deadlineTimer = setTimeout(() => this._handleDeadlineTimeout(), remaining);
    }
  }

  async _handleLeaseTimeout() {
    await this.sessionMutex.withLock(async () => {
      if (this.status !== "active" || !this.currentLease) return;
      if (Date.now() >= this.currentLease.expiresAt) {
        const revokeRecord = {
          journal_seq: this.lastJournalSeq + 1,
          timestamp: new Date().toISOString(),
          run_id: this.runId,
          type: "lease_revoked",
          operation_id: `timeout-revoke-${crypto.randomUUID()}`,
          request_fingerprint: "0".repeat(64),
          controller_id: this.currentLease.controllerId,
          lease_id: this.currentLease.leaseId,
          lease_epoch: this.currentLease.leaseEpoch,
          reason: "heartbeat_timeout",
          sanitized_result: {
            resultType: "complete",
            content: [{ type: "text", text: "Lease timed out" }],
            isError: true
          }
        };
        await this.appendJournalRecord(revokeRecord);
      }
    });
  }

  async _handleDeadlineTimeout() {
    await this.sessionMutex.withLock(async () => {
      if (this.status !== "active") return;
      if (Date.now() >= Date.parse(this.deadlineAt)) {
        await this._startFinalize("timed_out", "Session reached wall-clock time limit");
      } else {
        // A timer can wake early after a wall-clock adjustment.  The persisted
        // UTC deadline remains authoritative; re-arm the monotonic wake-up.
        this._armDeadlineTimer();
      }
    });
  }

  async replayJournal() {
    if (!fs.existsSync(this.journalPath)) return;
    const content = fs.readFileSync(this.journalPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    const actionRecords = [];
    let expectedSeq = 1;
    for (const line of lines) {
      const record = JSON.parse(line);
      if (!validateJournalRecord(record)) {
        throw new Error(`Corrupt journal record at seq ${expectedSeq}: ` + JSON.stringify(validateJournalRecord.errors));
      }
      if (record.journal_seq !== expectedSeq) {
        throw new Error(`Non-contiguous journal seq: expected ${expectedSeq}, got ${record.journal_seq}`);
      }

      this.lastJournalSeq = record.journal_seq;
      this.projectedJournalSeq = record.journal_seq;

      if (record.operation_id) {
        this.operationIndex.set(record.operation_id, record);
      }

      if (record.type === "action_committed" && record.action_record) {
        actionRecords.push(record.action_record);
      }

      this._applyJournalRecord(record);
      expectedSeq += 1;
    }

    // Always reconcile actions.jsonl against authoritative WAL actionRecords
    let isActionsValid = false;
    if (fs.existsSync(this.actionsPath)) {
      try {
        const content = fs.readFileSync(this.actionsPath, "utf8");
        if (actionRecords.length === 0 && content.trim().length === 0) {
          isActionsValid = true;
        } else if (content.endsWith("\n")) {
          const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);
          if (lines.length === actionRecords.length) {
            let allMatch = true;
            for (let i = 0; i < lines.length; i++) {
              const parsed = JSON.parse(lines[i]);
              const authoritativeLine = JSON.stringify(actionRecords[i]);
              if (!parsed || parsed.seq !== actionRecords[i].seq || lines[i] !== authoritativeLine) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              isActionsValid = true;
            }
          }
        }
      } catch (_e) {
        isActionsValid = false;
      }
    }
    if (!isActionsValid) {
      const tmpPath = `${this.actionsPath}.tmp-${Date.now()}`;
      const actionContent = actionRecords.length > 0
        ? actionRecords.map((a) => JSON.stringify(a)).join("\n") + "\n"
        : "";
      fs.writeFileSync(tmpPath, actionContent, "utf8");
      fs.renameSync(tmpPath, this.actionsPath);
    }

    // Reconstruct or restore base viewer state
    if (fs.existsSync(this.baseViewerStatePath)) {
      try {
        this.baseViewerState = JSON.parse(fs.readFileSync(this.baseViewerStatePath, "utf8"));
        this.baseViewerStateDigest = computeViewerStateHash(this.baseViewerState);
      } catch (_e) {}
    }
    if (!this.baseViewerState) {
      const baseSession = getBridge().createSession({
        gameId: "maze",
        gameWonGemCount: this.winThreshold,
        levelId: "level_HxI",
        pitch: 1,
        yaw: 0,
        observationMode: "text"
      });
      this.baseViewerState = extractViewerState(baseSession, 0, this.worldBundleDigest);
      this.baseViewerStateDigest = computeViewerStateHash(this.baseViewerState);
      fs.writeFileSync(this.baseViewerStatePath, JSON.stringify(this.baseViewerState, null, 2), "utf8");
    }

    // Reconstruct game session
    this._reconstructGameSession();
  }

  _reconstructGameSession() {
    this.gameSession = getBridge().createSession({
      gameId: "maze",
      gameWonGemCount: this.winThreshold,
      levelId: "level_HxI",
      pitch: 1,
      yaw: 0,
      observationMode: "text"
    });

    if (!fs.existsSync(this.journalPath)) return;
    const content = fs.readFileSync(this.journalPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const record = JSON.parse(line);
      if (record.type === "action_committed") {
        const msg = record.action_record.message;
        getBridge().handleCommand(this.gameSession, msg);
        const reconstructedState = extractViewerState(
          this.gameSession,
          record.action_seq,
          this.worldBundleDigest
        );
        const reconstructedHash = computeViewerStateHash(reconstructedState);
        if (
          reconstructedHash !== record.viewer_state_hash
          || reconstructedHash !== record.action_record.after_state_hash
        ) {
          throw new Error(`Projection reconciliation failed at action ${record.action_seq}`);
        }
      }
    }

    this.currentViewerState = extractViewerState(this.gameSession, this.lastActionSeq, this.worldBundleDigest);
    this.currentViewerStateHash = computeViewerStateHash(this.currentViewerState);
  }

  async handleServerRestart() {
    await this.sessionMutex.withLock(async () => {
      if (this.status === "active") {
        // If there was an active lease, revoke it due to restart
        if (this.currentLease) {
          const revokeRecord = {
            journal_seq: this.lastJournalSeq + 1,
            timestamp: new Date().toISOString(),
            run_id: this.runId,
            type: "lease_revoked",
            operation_id: `restart-revoke-${crypto.randomUUID()}`,
            request_fingerprint: "0".repeat(64),
            controller_id: this.currentLease.controllerId,
            lease_id: this.currentLease.leaseId,
            lease_epoch: this.currentLease.leaseEpoch,
            reason: "server_restart",
            sanitized_result: {
              resultType: "complete",
              content: [{ type: "text", text: "Server restarted" }],
              isError: true
            }
          };
          await this.appendJournalRecord(revokeRecord);
        }

        // Complete a run that crashed after committing its final allowed action.
        if (this.maxActions && this.lastActionSeq >= this.maxActions) {
          await this._startFinalize("action_limit", `Run reached the ${this.maxActions}-action limit`);
        } else if (this.deadlineAt && Date.now() >= Date.parse(this.deadlineAt)) {
          await this._startFinalize("timed_out", "Deadline passed during server downtime");
        } else {
          this._armDeadlineTimer();
        }
      } else if (this.status === "finalizing") {
        // Resume finalize worker with preserved target outcome
        this._runFinalizeWorker(this.targetOutcome || (this.maxActions ? "action_limit" : "timed_out"));
      }
    });
  }

  // MCP & Action Protocol Implementation

  async startOrAttach(controllerInfo, operationId = null, abortSignal = null) {
    return await this.sessionMutex.withLock(async () => {
      if (abortSignal?.aborted) {
        throw { status: 499, code: "REQUEST_CANCELLED", message: "Request cancelled before WAL commit" };
      }
      const opId = operationId || `op-start-${crypto.randomUUID()}`;
      const fingerprint = crypto.createHash("sha256").update(opId).digest("hex");

      if (this.operationIndex.has(opId)) {
        const cached = this.operationIndex.get(opId);
        const currentObs = this.gameSession ? sanitizeObservationForMcp(getBridge().sessionSnapshot(this.gameSession)) : {};
        return {
          run_id: this.runId,
          status: this.status,
          lease_id: cached.lease_id,
          lease_epoch: cached.lease_epoch,
          lease_expires_at: cached.lease_expires_at,
          started_at: this.startedAt,
          ...(this.maxActions ? { max_actions: this.maxActions } : { deadline_at: this.deadlineAt }),
          observation: cached.observation || currentObs,
          sanitized_result: cached.initial_sanitized_result || cached.sanitized_result
        };
      }

      if (this.status === "armed") {
        const leaseId = `lease-${crypto.randomUUID()}`;
        const startedAt = new Date().toISOString();
        const deadlineAt = this.maxActions ? null : new Date(Date.now() + this.durationMs).toISOString();
        const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
        const declaredCli = controllerInfo?.declaredCli || controllerInfo?.name || "stdio-mcp";
        this.declaredCli = declaredCli;

        const initialObs = this.gameSession ? sanitizeObservationForMcp(getBridge().sessionSnapshot(this.gameSession)) : {};
        const sanitizedResult = {
          resultType: "complete",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                run_id: this.runId,
                status: "active",
                action_seq: 0,
                observation: initialObs,
                game_won: false,
                ended: false,
                ...(this.maxActions ? { max_actions: this.maxActions, actions_remaining: this.maxActions } : {})
              })
            }
          ],
          isError: false
        };

        const startedRecord = {
          journal_seq: this.lastJournalSeq + 1,
          timestamp: startedAt,
          run_id: this.runId,
          type: "run_started",
          operation_id: opId,
          request_fingerprint: fingerprint,
          controller_id: controllerInfo.controllerId,
          declared_cli: declaredCli,
          lease_id: leaseId,
          lease_epoch: 1,
          started_at: startedAt,
          ...(this.maxActions ? { max_actions: this.maxActions } : { deadline_at: deadlineAt }),
          lease_expires_at: expiresAt,
          initial_sanitized_result: sanitizedResult
        };

        await this.appendJournalRecord(startedRecord);

        return {
          run_id: this.runId,
          status: "active",
          lease_id: leaseId,
          lease_epoch: 1,
          lease_expires_at: expiresAt,
          started_at: startedAt,
          ...(this.maxActions ? { max_actions: this.maxActions } : { deadline_at: deadlineAt }),
          observation: initialObs,
          sanitized_result: sanitizedResult
        };
      }

      if (this.status === "active") {
        // If current lease is active and held by another controller, 409
        if (this.currentLease && this.currentLease.expiresAt > Date.now()) {
          if (this.currentLease.controllerId !== controllerInfo.controllerId) {
            throw { status: 409, code: "CONFLICT", message: "Run is actively leased by another controller" };
          }
          // Same controller re-attaches
          const currentObs = this.gameSession ? sanitizeObservationForMcp(getBridge().sessionSnapshot(this.gameSession)) : {};
          return {
            run_id: this.runId,
            status: "active",
            lease_id: this.currentLease.leaseId,
            lease_epoch: this.currentLease.leaseEpoch,
            lease_expires_at: new Date(this.currentLease.expiresAt).toISOString(),
            started_at: this.startedAt,
            ...(this.maxActions ? { max_actions: this.maxActions } : { deadline_at: this.deadlineAt }),
            observation: currentObs
          };
        }

        // The timer may be queued behind this same mutation lock.  Close an
        // expired lease in the WAL before attaching its successor so recovery
        // never observes two lease lifecycles joined without a revocation.
        if (this.currentLease) {
          const expiredLease = this.currentLease;
          const revokeRecord = {
            journal_seq: this.lastJournalSeq + 1,
            timestamp: new Date().toISOString(),
            run_id: this.runId,
            type: "lease_revoked",
            operation_id: `attach-expired-revoke-${crypto.randomUUID()}`,
            request_fingerprint: "0".repeat(64),
            controller_id: expiredLease.controllerId,
            lease_id: expiredLease.leaseId,
            lease_epoch: expiredLease.leaseEpoch,
            reason: "heartbeat_timeout",
            sanitized_result: {
              resultType: "complete",
              content: [{ type: "text", text: "Expired lease revoked before controller attach" }],
              isError: true
            }
          };
          await this.appendJournalRecord(revokeRecord);
        }

        // Attach with new epoch
        const nextEpoch = this.maxLeaseEpoch + 1;
        const leaseId = `lease-${crypto.randomUUID()}`;
        const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
        const declaredCli = controllerInfo?.declaredCli || controllerInfo?.name || this.declaredCli || "stdio-mcp";
        this.declaredCli = declaredCli;

        const attachedRecord = {
          journal_seq: this.lastJournalSeq + 1,
          timestamp: new Date().toISOString(),
          run_id: this.runId,
          type: "lease_attached",
          operation_id: opId,
          request_fingerprint: fingerprint,
          controller_id: controllerInfo.controllerId,
          declared_cli: declaredCli,
          lease_id: leaseId,
          lease_epoch: nextEpoch,
          lease_expires_at: expiresAt,
          sanitized_result: {
            resultType: "complete",
            content: [{ type: "text", text: `Lease attached at epoch ${nextEpoch}` }],
            isError: false
          }
        };

        await this.appendJournalRecord(attachedRecord);

        const currentObs = this.gameSession ? sanitizeObservationForMcp(getBridge().sessionSnapshot(this.gameSession)) : {};
        return {
          run_id: this.runId,
          status: "active",
          lease_id: leaseId,
          lease_epoch: nextEpoch,
          lease_expires_at: expiresAt,
          started_at: this.startedAt,
          ...(this.maxActions ? { max_actions: this.maxActions } : { deadline_at: this.deadlineAt }),
          observation: currentObs
        };
      }

      throw { status: 409, code: "CONFLICT", message: `Cannot start or attach to run in status ${this.status}` };
    });
  }

  async heartbeat(controllerInfo, leaseId, leaseEpoch) {
    return await this.sessionMutex.withLock(async () => {
      if (this.status !== "active") {
        throw { status: 409, code: "CONFLICT", message: `Run is ${this.status}, cannot heartbeat` };
      }
      if (
        !this.currentLease ||
        this.currentLease.controllerId !== controllerInfo.controllerId ||
        this.currentLease.leaseId !== leaseId ||
        this.currentLease.leaseEpoch !== leaseEpoch
      ) {
        throw { status: 409, code: "CONFLICT", message: "Invalid or expired lease epoch/id" };
      }

      const newExpiresAt = Date.now() + LEASE_TTL_MS;
      this.currentLease.expiresAt = newExpiresAt;
      this._armLeaseTimer();

      return {
        ok: true,
        lease_expires_at: new Date(newExpiresAt).toISOString()
      };
    });
  }

  async detach(controllerInfo, leaseId, leaseEpoch) {
    return await this.sessionMutex.withLock(async () => {
      if (
        this.currentLease &&
        this.currentLease.controllerId === controllerInfo.controllerId &&
        this.currentLease.leaseId === leaseId &&
        this.currentLease.leaseEpoch === leaseEpoch
      ) {
        const revokeRecord = {
          journal_seq: this.lastJournalSeq + 1,
          timestamp: new Date().toISOString(),
          run_id: this.runId,
          type: "lease_revoked",
          operation_id: `detach-${crypto.randomUUID()}`,
          request_fingerprint: "0".repeat(64),
          controller_id: controllerInfo.controllerId,
          lease_id: leaseId,
          lease_epoch: leaseEpoch,
          reason: "controller_detach",
          sanitized_result: {
            resultType: "complete",
            content: [{ type: "text", text: "Controller detached cleanly" }],
            isError: false
          }
        };
        await this.appendJournalRecord(revokeRecord);
      }
      return { ok: true };
    });
  }

  async observe() {
    // Two-phase lock-free observe protocol
    let currentJ = 0;
    await this.sessionMutex.withLock(async () => {
      if (this.status !== "active" && this.status !== "finalizing") {
        throw { status: 409, code: "CONFLICT", message: `Run is ${this.status}, cannot observe` };
      }
      currentJ = this.lastJournalSeq;
    });

    const caughtUp = await this.waitForWatermark(currentJ);
    if (!caughtUp) {
      throw { status: 503, code: "PROJECTION_LAG", message: "Projection lag: state not caught up to current journal watermark" };
    }

    return await this.projectionMutex.withLock(async () => {
      const snap = this.gameSession ? getBridge().sessionSnapshot(this.gameSession) : {};
      return {
        run_id: this.runId,
        status: this.status,
        action_seq: this.lastActionSeq,
        ended: this.status !== "active",
        ...(this.maxActions
          ? { max_actions: this.maxActions, actions_remaining: Math.max(0, this.maxActions - this.lastActionSeq) }
          : {}),
        viewer_state_hash: this.currentViewerStateHash,
        observation: sanitizeObservationForMcp(snap)
      };
    });
  }

  async executeAction(controllerInfo, leaseId, leaseEpoch, tool, args = {}, operationId = null, abortSignal = null) {
    return await this.sessionMutex.withLock(async () => {
      if (abortSignal?.aborted) {
        throw { status: 499, code: "REQUEST_CANCELLED", message: "Request cancelled before WAL commit" };
      }
      const opId = operationId || `op-${crypto.randomUUID()}`;
      const fingerprint = crypto.createHash("sha256").update(opId).digest("hex");

      if (this.operationIndex.has(opId)) {
        const cached = this.operationIndex.get(opId);
        return cached.sanitized_result || cached.final_response;
      }

      // Check Active & Lease
      if (this.status !== "active") {
        throw { status: 409, code: "CONFLICT", message: `Run is ${this.status}, cannot execute actions` };
      }
      if (
        !this.currentLease ||
        this.currentLease.controllerId !== controllerInfo.controllerId ||
        this.currentLease.leaseId !== leaseId ||
        this.currentLease.leaseEpoch !== leaseEpoch
      ) {
        throw { status: 409, code: "CONFLICT", message: "Invalid lease credentials or epoch" };
      }

      if (this.maxActions && this.lastActionSeq >= this.maxActions) {
        await this._startFinalize("action_limit", `Run reached the ${this.maxActions}-action limit`);
        return {
          content: [{ type: "text", text: JSON.stringify({ outcome: "action_limit", ended: true, action_seq: this.lastActionSeq }) }],
          isError: false
        };
      }

      // Legacy timed runs retain their persisted deadline behavior.
      if (this.deadlineAt && Date.now() >= Date.parse(this.deadlineAt)) {
        await this._startFinalize("timed_out", "Deadline reached before action execution");
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Session timed out", outcome: "timed_out", ended: true }) }],
          isError: true
        };
      }

      // Map tool to game command
      const mapped = mapToolToMessage(tool, args);
      const nextEventId = this.lastEventId + 1;

      if (!mapped.ok) {
        // Record action_rejected
        const rejectedRecord = {
          journal_seq: this.lastJournalSeq + 1,
          timestamp: new Date().toISOString(),
          run_id: this.runId,
          type: "action_rejected",
          operation_id: opId,
          request_fingerprint: fingerprint,
          controller_id: controllerInfo.controllerId,
          lease_id: leaseId,
          lease_epoch: leaseEpoch,
          event_id: nextEventId,
          tool,
          arguments: args || {},
          error_payload: {
            code: "INVALID_ARGUMENT",
            message: mapped.error
          }
        };
        await this.appendJournalRecord(rejectedRecord);

        return {
          content: [{ type: "text", text: JSON.stringify({ error: mapped.error, ok: false, ended: false }) }],
          isError: true
        };
      }

      const beforeState = extractViewerState(this.gameSession, this.lastActionSeq, this.worldBundleDigest);
      const beforeStateHash = computeViewerStateHash(beforeState);

      let bridgeResult;
      try {
        bridgeResult = getBridge().handleCommand(this.gameSession, mapped.message);
      } catch (err) {
        // Bridge gameplay rejection (e.g. death or invalid jump)
        const rejectedRecord = {
          journal_seq: this.lastJournalSeq + 1,
          timestamp: new Date().toISOString(),
          run_id: this.runId,
          type: "action_rejected",
          operation_id: opId,
          request_fingerprint: fingerprint,
          controller_id: controllerInfo.controllerId,
          lease_id: leaseId,
          lease_epoch: leaseEpoch,
          event_id: nextEventId,
          tool,
          arguments: args || {},
          error_payload: {
            code: "INVALID_ARGUMENT",
            message: err.message
          }
        };
        await this.appendJournalRecord(rejectedRecord);

        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, ok: false, ended: false }) }],
          isError: true
        };
      }

      const nextActionSeq = this.lastActionSeq + 1;
      const afterState = extractViewerState(this.gameSession, nextActionSeq, this.worldBundleDigest);
      const afterStateHash = computeViewerStateHash(afterState);

      this.currentViewerState = afterState;
      this.currentViewerStateHash = afterStateHash;

      const viewerTransition = buildViewerTransition(beforeState, afterState, tool, bridgeResult);
      const sanitizedStatus = buildSanitizedStatus(this.gameSession);

      // Build Action Record V1 with 64KB blob overflow protection
      let finalViewerTransition = viewerTransition;
      let transitionDigest = null;
      const transitionStr = JSON.stringify(viewerTransition);
      if (Buffer.byteLength(transitionStr, "utf8") > 32000) {
        transitionDigest = crypto.createHash("sha256").update(transitionStr, "utf8").digest("hex");
        this._writeImmutableBlob(transitionDigest, transitionStr);
        finalViewerTransition = null;
      }

      let finalPostViewerState = afterState;
      let postViewerStateDigest = null;
      const postStateStr = JSON.stringify(afterState);
      if (Buffer.byteLength(postStateStr, "utf8") > 32000) {
        postViewerStateDigest = crypto.createHash("sha256").update(postStateStr, "utf8").digest("hex");
        this._writeImmutableBlob(postViewerStateDigest, postStateStr);
        finalPostViewerState = null;
      }

      const actionRecord = {
        schema_version: 1,
        seq: nextActionSeq,
        turn: nextActionSeq,
        tool,
        command_text: JSON.stringify(mapped.message),
        message: mapped.message,
        valid: true,
        accepted: true,
        error: null,
        sanitized_status: sanitizedStatus,
        viewer_transition: finalViewerTransition,
        transition_digest: transitionDigest,
        post_viewer_state: finalPostViewerState,
        post_viewer_state_digest: postViewerStateDigest,
        before_state_hash: beforeStateHash,
        after_state_hash: afterStateHash
      };

      const reachedActionLimit = Boolean(this.maxActions && nextActionSeq >= this.maxActions);
      const ended = reachedActionLimit;
      const mcpResult = {
        resultType: "complete",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              run_id: this.runId,
              status: ended ? "finalizing" : "active",
              action_seq: nextActionSeq,
              observation: sanitizeObservationForMcp(bridgeResult),
              game_won: false,
              ended,
              ...(this.maxActions
                ? { max_actions: this.maxActions, actions_remaining: Math.max(0, this.maxActions - nextActionSeq) }
                : {})
            })
          }
        ],
        isError: false
      };

      const committedRecord = {
        journal_seq: this.lastJournalSeq + 1,
        timestamp: new Date().toISOString(),
        run_id: this.runId,
        type: "action_committed",
        operation_id: opId,
        request_fingerprint: fingerprint,
        controller_id: controllerInfo.controllerId,
        lease_id: leaseId,
        lease_epoch: leaseEpoch,
        action_seq: nextActionSeq,
        event_id: nextEventId,
        action_record: actionRecord,
        sanitized_result: mcpResult,
        viewer_state_hash: afterStateHash
      };

      await this.appendJournalRecord(committedRecord);

      if (reachedActionLimit) {
        await this._startFinalize("action_limit", `Run reached the ${this.maxActions}-action limit`);
      }

      return mcpResult;
    });
  }

  async cancel() {
    return this.cancelRun();
  }

  async cancelRun() {
    return await this.sessionMutex.withLock(async () => {
      if (["won", "action_limit", "timed_out", "cancelled", "failed"].includes(this.status)) {
        return this.finalResponse || { run_id: this.runId, outcome: this.status, ended: true };
      }
      if (this.status === "finalizing") {
        return { run_id: this.runId, status: "finalizing" };
      }
      await this._startFinalize("cancelled", "User requested manual cancellation");
      return { run_id: this.runId, status: "finalizing" };
    });
  }

  async _startFinalize(outcome, reason) {
    this.status = "finalizing";
    this.targetOutcome = outcome;
    this.finalizeSeq += 1;
    const finalizeStartedAt = new Date().toISOString();
    this.finalizeStartedAt = finalizeStartedAt;
    this.finalizeReason = reason;

    const opId = `finalize-intent-${this.finalizeSeq}`;
    const fingerprint = crypto.createHash("sha256").update(opId).digest("hex");

    const intentRecord = {
      journal_seq: this.lastJournalSeq + 1,
      timestamp: finalizeStartedAt,
      run_id: this.runId,
      type: "finalize_intent",
      operation_id: opId,
      request_fingerprint: fingerprint,
      target_outcome: outcome,
      finalize_seq: this.finalizeSeq,
      finalize_started_at: finalizeStartedAt,
      reason
    };

    await this.appendJournalRecord(intentRecord);
    this._runFinalizeWorker(outcome);
  }

  async _runFinalizeWorker(outcome) {
    // Run asynchronously
    setImmediate(async () => {
      try {
        // Build summary
        const summary = SummaryBuilder.buildSummary(this, outcome);
        const summaryStr = JSON.stringify(summary, null, 2);
        this._writeSummaryAtomically(summaryStr);
        const summaryDigest = crypto.createHash("sha256").update(summaryStr, "utf8").digest("hex");

        const finalResponse = {
          run_id: this.runId,
          outcome,
          ended: true,
          summary_digest: summaryDigest,
          summary_url: `/api/external-play/runs/${encodeURIComponent(this.runId)}/summary`
        };

        await this.sessionMutex.withLock(async () => {
          if (["won", "action_limit", "timed_out", "cancelled", "failed"].includes(this.status)) return;

          const endedEventId = this.lastEventId + 1;
          const opId = `finalize-${outcome}-${this.finalizeSeq}`;
          const fingerprint = crypto.createHash("sha256").update(opId).digest("hex");

          const finalizeRecord = {
            journal_seq: this.lastJournalSeq + 1,
            timestamp: new Date().toISOString(),
            run_id: this.runId,
            type: "run_finalized",
            outcome,
            ended_event_id: endedEventId,
            summary_digest: summaryDigest,
            operation_id: opId,
            request_fingerprint: fingerprint,
            final_response: finalResponse
          };

          await this.appendJournalRecord(finalizeRecord);
          this.service._clearActiveRun(this.runId);
        });
      } catch (err) {
        console.error("Finalize worker failed:", err);
        await this._recordFinalizeFailure(err);
      }
    });
  }

  async _recordFinalizeFailure(error) {
    try {
      let partialSummaryDigest = null;
      let summaryAvailable = false;
      if (this.startedAt) {
        let partialSummary;
        try {
          partialSummary = SummaryBuilder.buildSummary(this, "failed");
        } catch (_summaryError) {
          partialSummary = {
            summary_schema_version: 1,
            run_id: this.runId,
            outcome: "failed",
            is_partial: true,
            started_at: this.startedAt,
            ended_at: this.finalizeStartedAt || new Date().toISOString(),
            elapsed_seconds: Math.max(0, (Date.parse(this.finalizeStartedAt || new Date().toISOString()) - Date.parse(this.startedAt)) / 1000),
            gems_collected: 0,
            gems_total: 100,
            rooms_visited: 1,
            rooms_total: 100,
            actions_total: 0,
            declared_cli: this.declaredCli || "unknown",
            declared_model: null,
            route: ["level_HxI"],
            progress_curve: [{ action_seq: 0, gems: 0, rooms: 1 }]
          };
        }
        const partialSummaryStr = JSON.stringify(partialSummary, null, 2);
        partialSummaryDigest = crypto.createHash("sha256").update(partialSummaryStr, "utf8").digest("hex");
        try {
          this._writeSummaryAtomically(partialSummaryStr);
          summaryAvailable = true;
        } catch (_writeError) {}
      }

      await this.sessionMutex.withLock(async () => {
        if (["won", "action_limit", "timed_out", "cancelled", "failed"].includes(this.status)) return;
        const failedAt = new Date().toISOString();
        const endedEventId = this.lastEventId + 1;
        const opId = `finalize-failed-${this.finalizeSeq}`;
        const finalResponse = {
          run_id: this.runId,
          outcome: "failed",
          ended: true,
          summary_digest: partialSummaryDigest,
          summary_url: summaryAvailable
            ? `/api/external-play/runs/${encodeURIComponent(this.runId)}/summary`
            : null
        };
        const failedRecord = {
          journal_seq: this.lastJournalSeq + 1,
          timestamp: failedAt,
          run_id: this.runId,
          type: "run_failed",
          outcome: "failed",
          failed_at: failedAt,
          error: {
            code: "INTERNAL_ERROR",
            message: String(error?.message || "Finalize worker failed").slice(0, 512)
          },
          ended_event_id: endedEventId,
          partial_summary_digest: partialSummaryDigest,
          operation_id: opId,
          request_fingerprint: crypto.createHash("sha256").update(opId).digest("hex"),
          final_response: finalResponse
        };
        await this.appendJournalRecord(failedRecord);
        this.service._clearActiveRun(this.runId);
      });
    } catch (fatalError) {
      console.error("Failed to persist run_failed terminal record:", fatalError);
    }
  }

  cleanup() {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = null;
    }
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    this.deadlineMonotonicMs = null;
  }
}

class SummaryBuilder {
  static buildSummary(run, outcome) {
    const isPartial = outcome === "cancelled" || outcome === "failed";
    const startedAt = run.startedAt || null;
    const endedAt = run.finalizeStartedAt || new Date().toISOString();

    let elapsedSeconds = null;
    if (startedAt) {
      elapsedSeconds = Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
      elapsedSeconds = Math.round(elapsedSeconds * 100) / 100;
    }

    const session = run.gameSession;
    const gemsCollected = !startedAt ? 0 : (session?.collectedGemIds ? session.collectedGemIds.size : 0);
    const gemsTotal = 100;
    const roomsVisited = !startedAt ? 0 : (session?.visitedLevels ? session.visitedLevels.size : 1);
    const roomsTotal = 100;
    const actionsTotal = run.lastActionSeq || 0;

    // Progress Curve calculation
    const progressCurve = [];
    if (!startedAt) {
      progressCurve.push({ action_seq: 0, gems: 0, rooms: 0 });
    } else {
      progressCurve.push({ action_seq: 0, gems: 0, rooms: 1 });
      if (actionsTotal > 0) {
        progressCurve.push({ action_seq: actionsTotal, gems: gemsCollected, rooms: roomsVisited });
      }
    }

    const route = !startedAt ? [] : (session?.visitedLevels ? Array.from(session.visitedLevels) : ["level_HxI"]);

    const summary = {
      summary_schema_version: 1,
      run_id: run.runId,
      outcome,
      is_partial: isPartial,
      started_at: startedAt,
      ended_at: endedAt,
      elapsed_seconds: elapsedSeconds,
      gems_collected: gemsCollected,
      gems_total: gemsTotal,
      rooms_visited: roomsVisited,
      rooms_total: roomsTotal,
      actions_total: actionsTotal,
      declared_cli: run.declaredCli || run.currentLease?.declaredCli || run.currentLease?.controllerId || "unknown",
      declared_model: null,
      route,
      progress_curve: progressCurve
    };

    if (!validateSummary(summary)) {
      throw new Error("Invalid generated summary: " + JSON.stringify(validateSummary.errors));
    }
    assertSummaryInvariants(summary);

    return summary;
  }
}

function assertSummaryInvariants(summary) {
  if (!Number.isInteger(summary.gems_collected) || !Number.isInteger(summary.gems_total)
      || summary.gems_collected < 0 || summary.gems_collected > summary.gems_total) {
    throw new Error("Summary invariant failed: gems_collected must be between 0 and gems_total");
  }
  if (!Number.isInteger(summary.rooms_visited) || summary.rooms_visited < 0
      || !Number.isInteger(summary.actions_total) || summary.actions_total < 0) {
    throw new Error("Summary invariant failed: room and action totals must be non-negative integers");
  }

  const curve = summary.progress_curve;
  if (!Array.isArray(curve) || curve.length === 0) {
    throw new Error("Summary invariant failed: progress_curve must contain an initial point");
  }
  for (let index = 0; index < curve.length; index += 1) {
    const point = curve[index];
    if (!Number.isInteger(point.action_seq) || !Number.isInteger(point.gems) || !Number.isInteger(point.rooms)) {
      throw new Error("Summary invariant failed: progress points must contain integer counters");
    }
    if (index > 0) {
      const previous = curve[index - 1];
      if (point.action_seq <= previous.action_seq || point.gems < previous.gems || point.rooms < previous.rooms) {
        throw new Error("Summary invariant failed: progress_curve must be strictly ordered and monotonic");
      }
    }
  }

  const expectedInitialRooms = summary.started_at ? 1 : 0;
  const first = curve[0];
  if (first.action_seq !== 0 || first.gems !== 0 || first.rooms !== expectedInitialRooms) {
    throw new Error("Summary invariant failed: invalid zero-action initial point");
  }
  const last = curve[curve.length - 1];
  if (summary.actions_total === 0) {
    if (curve.length !== 1 || summary.gems_collected !== 0 || summary.rooms_visited !== expectedInitialRooms) {
      throw new Error("Summary invariant failed: zero-action totals do not match the initial point");
    }
  } else if (
    last.action_seq !== summary.actions_total
    || last.gems !== summary.gems_collected
    || last.rooms !== summary.rooms_visited
  ) {
    throw new Error("Summary invariant failed: final progress point must match totals");
  }

  if (summary.started_at) {
    const startedMs = Date.parse(summary.started_at);
    const endedMs = Date.parse(summary.ended_at);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) {
      throw new Error("Summary invariant failed: ended_at must not precede started_at");
    }
    const expectedElapsed = (endedMs - startedMs) / 1000;
    if (!Number.isFinite(summary.elapsed_seconds) || Math.abs(summary.elapsed_seconds - expectedElapsed) >= 1) {
      throw new Error("Summary invariant failed: elapsed_seconds does not match timestamps");
    }
  } else if (summary.elapsed_seconds !== null) {
    throw new Error("Summary invariant failed: elapsed_seconds must be null before start");
  }

  return true;
}

function sanitizeObservationForMcp(obs) {
  if (!obs) return {};
  const {
    current_room = "",
    current_view = "",
    yaw = 0,
    gem_count = 0,
    visited_levels = [],
    player_dead = false,
    game_won = false,
    game_lost = false,
    level = "",
    json_observation = null,
    player = null,
    moved = undefined,
    death_message = "",
    allowed_commands = []
  } = obs;

  const result = {
    observation_mode: json_observation ? "json" : "ascii",
    current_room: String(current_room || ""),
    current_view: String(current_view || ""),
    yaw: Number.isInteger(yaw) ? yaw : 0,
    gem_count: Math.max(0, Number(gem_count) || 0),
    visited_levels: Array.isArray(visited_levels) ? visited_levels.map(String) : [],
    player_dead: Boolean(player_dead),
    game_won: false,
    game_lost: Boolean(game_lost)
  };

  if (level) {
    result.level = String(level);
  }
  if (json_observation) {
    result.json_observation = json_observation;
  }
  if (player) {
    result.player = player;
  }
  if (moved !== undefined) {
    result.moved = Boolean(moved);
  }
  if (result.player_dead) {
    result.death_message = String(death_message || "The player died, you must now undo or reset or go to a level.");
    result.allowed_commands = Array.isArray(allowed_commands) ? allowed_commands.map(String) : ["undo", "reset", "go to level X Y"];
  }

  return result;
}

function round4(v) {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function extractViewerState(session, actionSeq, worldBundleDigest) {
  if (!session || !session.context) {
    return {
      v: 1,
      action_seq: actionSeq || 0,
      current_room: "level_HxI",
      player: { x: 0, y: 0, elevation: 0, viewer_actor_index: 0 },
      pitch: 1,
      yaw: 0,
      actors: [],
      gems: [],
      collected_gems: [],
      terrain_overrides: [],
      world_bundle_digest: worldBundleDigest || "0".repeat(64)
    };
  }

  const context = session.context;
  let player = null;
  const actors = [];
  const gems = [];

  for (let i = 0; i < context.engine.actorCount; i++) {
    const viewerActorIndex = context.engine.viewerActorIndices?.[i];
    if (!Number.isInteger(viewerActorIndex) || viewerActorIndex < 0) {
      throw new Error(`Engine is missing immutable viewer actor identity for actor ${i}`);
    }
    const type = context.engine.actorTypes[i] || context.playData.actors[i]?.type || "unknown";
    const x = round4(context.state.actorX[i] ?? context.playData.actors[i]?.x ?? 0);
    const y = round4(context.state.actorY[i] ?? context.playData.actors[i]?.y ?? 0);
    const elevation = round4(context.state.actorElevation[i] ?? context.playData.actors[i]?.elevation ?? 0);
    const removed = Boolean(context.state.actorRemoved[i]);

    if (i === context.engine.playerActorIndex || type === "player" || type === "character" || type === "circle_player") {
      player = { x, y, elevation, viewer_actor_index: viewerActorIndex };
    }

    if (type === "gem") {
      const origX = round4(context.playData.actors[i]?.x ?? x);
      const origY = round4(context.playData.actors[i]?.y ?? y);
      const origElev = round4(context.playData.actors[i]?.elevation ?? 0);
      const gemId = `${context.level.id}:gem:${origX},${origY},${origElev}`;
      const collected = session.collectedGemIds ? session.collectedGemIds.has(gemId) : false;
      gems.push({
        id: gemId,
        collected,
        removed: removed || collected,
        elevation: origElev,
        viewer_actor_index: viewerActorIndex
      });
    } else if (i !== context.engine.playerActorIndex && type !== "player" && type !== "character" && type !== "circle_player") {
      const actorId = `${context.level.id}:actor:${viewerActorIndex}`;
      actors.push({
        id: actorId,
        type,
        x,
        y,
        elevation,
        removed,
        viewer_actor_index: viewerActorIndex
      });
    }
  }

  // Sort actors and gems stably
  actors.sort((a, b) => a.id.localeCompare(b.id));
  gems.sort((a, b) => a.id.localeCompare(b.id));

  const collectedGems = Array.from(session.collectedGemIds || []).sort();

  // Extract terrain overrides using engine terrain mapping
  const terrainOverrides = [];
  const typeNames = Object.fromEntries(
    Object.entries(context.engine.terrainTypes || {}).map(([name, value]) => [value, name])
  );
  const initialTerrain = context.engine.initialState?.terrain || [];

  for (let index = 0; index < context.state.terrain.length; index += 1) {
    const currentType = typeNames[context.state.terrain[index]] || "empty";
    const initialType = typeNames[initialTerrain[index]] || "empty";
    const raised = Boolean(context.state.liftRaised[index]);
    const initiallyRaised = Boolean(context.engine.initialState?.liftRaised?.[index]);
    if (currentType !== initialType || raised !== initiallyRaised) {
      terrainOverrides.push({ index, type: currentType, raised });
    }
  }
  terrainOverrides.sort((a, b) => a.index - b.index);

  return {
    v: 1,
    action_seq: actionSeq,
    current_room: context.level.id,
    player: player || { x: 0, y: 0, elevation: 0, viewer_actor_index: 0 },
    pitch: Math.max(0, Math.min(4, parseInt(context.options.pitch, 10) || 0)),
    yaw: Math.max(0, Math.min(3, parseInt(context.options.yaw, 10) || 0)),
    actors,
    gems,
    collected_gems: collectedGems,
    terrain_overrides: terrainOverrides,
    world_bundle_digest: worldBundleDigest || "0".repeat(64)
  };
}

function buildViewerTransition(beforeState, afterState, tool, bridgeResult) {
  const durationMs = 250;
  const beforeHash = computeViewerStateHash(beforeState);
  const afterHash = computeViewerStateHash(afterState);
  const transSource = bridgeResult?._transition_source || {};

  // 1. Compute actor deltas (including player)
  const actorDeltas = [];

  if (Array.isArray(transSource.moves) && transSource.moves.length > 0) {
    // Authoritative mapping from engine moves
    for (const move of transSource.moves) {
      const isPlayer = move.actorIndex === (beforeState.player?.viewer_actor_index ?? 0) || move.actorType === "player" || move.actorType === "circle_player";
      const viewerActorIndex = isPlayer
        ? afterState.player?.viewer_actor_index
        : move.actorIndex;
      const actorId = `${afterState.current_room}:actor:${viewerActorIndex}`;
      const actorType = isPlayer ? "player" : (move.actorType || "box");
      const isFall = Boolean(move.toRemoved || move.holeFall || move.edgeFall);
      const actionType = isFall ? "fall" : (isPlayer ? "move" : "push");

      actorDeltas.push({
        id: actorId,
        type: actorType,
        room: afterState.current_room,
        before: {
          x: round4(move.fromX ?? 0),
          y: round4(move.fromY ?? 0),
          elevation: round4(move.fromElevation ?? 0),
          removed: Boolean(move.fromRemoved)
        },
        after: {
          x: round4(move.toX ?? 0),
          y: round4(move.toY ?? 0),
          elevation: round4(move.toElevation ?? 0),
          removed: isFall || (isPlayer && Boolean(bridgeResult?.player_dead))
        },
        action: actionType,
        start_time_ratio: 0.0,
        end_time_ratio: 1.0
      });
    }
  } else {
    // Fallback: Compute deltas between before and after states
    if (beforeState.player && afterState.player) {
      if (
        beforeState.player.x !== afterState.player.x ||
        beforeState.player.y !== afterState.player.y ||
        beforeState.player.elevation !== afterState.player.elevation
      ) {
        actorDeltas.push({
          id: `${afterState.current_room}:actor:${afterState.player.viewer_actor_index}`,
          type: "player",
          room: afterState.current_room,
          before: {
            x: beforeState.player.x,
            y: beforeState.player.y,
            elevation: beforeState.player.elevation,
            removed: false
          },
          after: {
            x: afterState.player.x,
            y: afterState.player.y,
            elevation: afterState.player.elevation,
            removed: Boolean(bridgeResult?.player_dead)
          },
          action: "move",
          start_time_ratio: 0.0,
          end_time_ratio: 1.0
        });
      }
    }

    const beforeActorsMap = new Map((beforeState.actors || []).map((a) => [a.id, a]));
    for (const afterActor of afterState.actors || []) {
      const beforeActor = beforeActorsMap.get(afterActor.id);
      if (beforeActor) {
        if (
          beforeActor.x !== afterActor.x ||
          beforeActor.y !== afterActor.y ||
          beforeActor.elevation !== afterActor.elevation ||
          beforeActor.removed !== afterActor.removed
        ) {
          let actionType = "move";
          if (afterActor.removed && !beforeActor.removed) {
            actionType = "fall";
          } else if (bridgeResult?.pushes_this_action && bridgeResult.pushes_this_action > 0) {
            actionType = "push";
          }

          actorDeltas.push({
            id: afterActor.id,
            type: afterActor.type,
            room: afterState.current_room,
            before: {
              x: beforeActor.x,
              y: beforeActor.y,
              elevation: beforeActor.elevation,
              removed: beforeActor.removed
            },
            after: {
              x: afterActor.x,
              y: afterActor.y,
              elevation: afterActor.elevation,
              removed: afterActor.removed
            },
            action: actionType,
            start_time_ratio: 0.0,
            end_time_ratio: 1.0
          });
        }
      }
    }
  }

  // 2. Compute gem deltas
  const gemDeltas = [];
  const beforeGemsMap = new Map((beforeState.gems || []).map((g) => [g.id, g]));
  for (const afterGem of afterState.gems || []) {
    const beforeGem = beforeGemsMap.get(afterGem.id);
    if (beforeGem && !beforeGem.collected && afterGem.collected) {
      const fromElev = round4(afterGem.elevation ?? beforeGem.elevation ?? 0);
      const toElev = round4(fromElev + 1);
      gemDeltas.push({
        id: afterGem.id,
        action: "collect",
        from_elevation: fromElev,
        to_elevation: toElev,
        start_time_ratio: 0.0,
        end_time_ratio: 1.0
      });
    }
  }

  // 3. Compute terrain deltas (lifts / orange walls)
  const terrainDeltas = [];
  const beforeRaisedMap = new Map((beforeState.terrain_overrides || []).map((t) => [t.index, t]));
  const afterRaisedMap = new Map((afterState.terrain_overrides || []).map((t) => [t.index, t]));
  const allTerrainIndices = new Set([...beforeRaisedMap.keys(), ...afterRaisedMap.keys()]);
  for (const idx of allTerrainIndices) {
    const beforeT = beforeRaisedMap.get(idx);
    const afterT = afterRaisedMap.get(idx);
    const wasRaised = Boolean(beforeT?.raised);
    const isRaised = Boolean(afterT?.raised);
    const type = afterT?.type || beforeT?.type || "lift";
    if (wasRaised !== isRaised) {
      terrainDeltas.push({
        index: idx,
        type,
        before_raised: wasRaised,
        after_raised: isRaised,
        start_time_ratio: 0.0,
        end_time_ratio: 1.0
      });
    }
  }

  // 4. Compute camera delta
  let cameraDelta = null;
  if (beforeState.pitch !== afterState.pitch || beforeState.yaw !== afterState.yaw) {
    cameraDelta = {
      from_pitch: beforeState.pitch,
      to_pitch: afterState.pitch,
      from_yaw: beforeState.yaw,
      to_yaw: afterState.yaw
    };
  }

  // 5. Compute world transition (cross-room double scene digests)
  let worldTransition = null;
  if (beforeState.current_room !== afterState.current_room) {
    worldTransition = {
      source_room: beforeState.current_room,
      target_room: afterState.current_room,
      direction: tool,
      outgoing_scene_digest: beforeHash,
      incoming_scene_digest: afterHash
    };
  }

  let transitionType = "move";
  if (tool.startsWith("rotate_camera")) transitionType = "rotate";
  else if (tool === "reset") transitionType = "reset";
  else if (tool === "undo") transitionType = "slide";
  else if (tool === "go_to_level" || tool === "goto_level") transitionType = "teleport";

  const keyframes = [
    { time_ratio: 0.0, viewer_state: beforeState, viewer_state_hash: beforeHash },
    { time_ratio: 1.0, viewer_state: afterState, viewer_state_hash: afterHash }
  ];

  return {
    v: 1,
    type: transitionType,
    duration_ms: durationMs,
    room: afterState.current_room,
    actor_deltas: actorDeltas,
    gem_deltas: gemDeltas,
    terrain_deltas: terrainDeltas,
    camera_delta: cameraDelta,
    world_transition: worldTransition,
    keyframes
  };
}

function buildSanitizedStatus(session) {
  if (!session || !session.context) {
    return {
      ok: true,
      action_count: 0,
      current_room: "level_HxI",
      collected_gems_count: 0,
      game_won: false,
      player_dead: false
    };
  }
  const context = session.context;
  return {
    ok: true,
    action_count: session.actionCount || 0,
    current_room: context.level.id,
    collected_gems_count: session.collectedGemIds ? session.collectedGemIds.size : 0,
    game_won: false,
    player_dead: Boolean(context.state.playerDead)
  };
}

function mapToolToMessage(tool, args = {}) {
  const ALLOWED_TOOLS = new Set([
    "start", "observe", "up", "down", "left", "right",
    "rotate_camera_up", "rotate_camera_down", "rotate_camera_left", "rotate_camera_right",
    "undo", "reset", "go_to_level"
  ]);

  if (!ALLOWED_TOOLS.has(tool)) {
    return { ok: false, error: `Unknown tool: ${tool}` };
  }

  if (tool === "up" || tool === "down" || tool === "left" || tool === "right") {
    return { ok: true, message: { command: "move", direction: tool } };
  }
  if (tool === "rotate_camera_up") {
    return { ok: true, message: { command: "rotate_camera", direction: "up" } };
  }
  if (tool === "rotate_camera_down") {
    return { ok: true, message: { command: "rotate_camera", direction: "down" } };
  }
  if (tool === "rotate_camera_left") {
    return { ok: true, message: { command: "rotate_camera", direction: "left" } };
  }
  if (tool === "rotate_camera_right") {
    return { ok: true, message: { command: "rotate_camera", direction: "right" } };
  }
  if (tool === "undo") {
    return { ok: true, message: { command: "undo" } };
  }
  if (tool === "reset") {
    return { ok: true, message: { command: "reset_level" } };
  }
  if (tool === "go_to_level") {
    if (!args.x || !args.y || !/^[A-Za-z]$/.test(args.x) || !/^[A-Za-z]$/.test(args.y)) {
      return { ok: false, error: "go_to_level requires single letter x and y coordinates" };
    }
    return { ok: true, message: { command: "goto_level", x: args.x.toUpperCase(), y: args.y.toUpperCase() } };
  }

  return { ok: false, error: `Tool ${tool} cannot be mapped to an action command` };
}

module.exports = {
  ExternalPlayService,
  RunInstance,
  SummaryBuilder,
  assertSummaryInvariants,
  resolveDataHome,
  assertIsolation,
  mapToolToMessage,
  sanitizeObservationForMcp,
  extractViewerState,
  buildViewerTransition,
  buildSanitizedStatus
};
