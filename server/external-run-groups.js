const fs = require("fs");
const path = require("path");
const { getRunFinalNovelty, rankCompetitionEntries } = require("./run-rankings");

const TERMINAL_STATUSES = new Set(["won", "action_limit", "timed_out", "cancelled", "failed"]);

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

class ExternalRunGroupStore {
  constructor({ groupsDir, getRun, validateManifest, validateResult }) {
    this.groupsDir = groupsDir;
    this.getRun = getRun;
    this.validateManifest = validateManifest;
    this.validateResult = validateResult;
    this.groups = new Map();
    this.retryTimers = new Map();
  }

  initialize() {
    fs.mkdirSync(this.groupsDir, { recursive: true });
    for (const entry of fs.readdirSync(this.groupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const groupDir = path.join(this.groupsDir, entry.name);
      const manifest = readJson(path.join(groupDir, "manifest.json"));
      if (!manifest || !this.validateManifest(manifest)) continue;
      const candidateResult = readJson(path.join(groupDir, "result.json"));
      const result = candidateResult
        && this.validateResult(candidateResult)
        && candidateResult.group_id === manifest.group_id
        && candidateResult.mode === manifest.mode
        ? candidateResult
        : null;
      const seatFailures = readJson(path.join(groupDir, "seat-failures.json"), {}) || {};
      this.groups.set(manifest.group_id, {
        groupDir,
        manifest,
        result,
        seatFailures
      });
    }
  }

  cleanup() {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  scheduleSettlementRetry(groupId, delayMs = 1000) {
    if (this.retryTimers.has(groupId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(groupId);
      try {
        this.maybeFinalize(groupId);
      } catch (err) {
        console.error(`Retry settlement failed for run group ${groupId}:`, err);
        const record = this.get(groupId);
        if (record && !record.result) {
          const nextDelay = Math.min(10000, delayMs * 2);
          this.scheduleSettlementRetry(groupId, nextDelay);
        }
      }
    }, delayMs);
    if (timer.unref) timer.unref();
    this.retryTimers.set(groupId, timer);
  }

  create(manifest) {
    if (!this.validateManifest(manifest)) {
      throw new Error(`Invalid run group manifest: ${JSON.stringify(this.validateManifest.errors)}`);
    }
    const groupDir = path.join(this.groupsDir, manifest.group_id);
    fs.mkdirSync(groupDir, { recursive: false });
    writeJsonAtomic(path.join(groupDir, "manifest.json"), manifest);
    const record = { groupDir, manifest, result: null, seatFailures: {} };
    this.groups.set(manifest.group_id, record);
    return record;
  }

  remove(groupId) {
    if (this.retryTimers.has(groupId)) {
      clearTimeout(this.retryTimers.get(groupId));
      this.retryTimers.delete(groupId);
    }
    const record = this.groups.get(groupId);
    this.groups.delete(groupId);
    const groupDir = record?.groupDir || path.join(this.groupsDir, groupId);
    if (fs.existsSync(groupDir)) {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  }

  get(groupId) {
    return this.groups.get(groupId) || null;
  }

  getSeatFailure(runId) {
    for (const record of this.groups.values()) {
      if (record.seatFailures && record.seatFailures[runId]) {
        return record.seatFailures[runId];
      }
    }
    return null;
  }

  markEntryFailed(runId, { outcome = "failed", status = "failed" } = {}) {
    for (const record of this.groups.values()) {
      const entry = record.manifest.entries.find((e) => e.run_id === runId);
      if (entry) {
        if (!record.seatFailures) record.seatFailures = {};
        record.seatFailures[runId] = {
          entry_id: entry.entry_id,
          run_id: runId,
          model_name: null,
          harness: null,
          status,
          outcome,
          started_at: null,
          ended_at: new Date().toISOString(),
          rooms_visited: 0,
          gems_collected: 0,
          actions_total: 0,
          novelty: 0,
          replay_url: `/external-play/${encodeURIComponent(runId)}`
        };
        writeJsonAtomic(path.join(record.groupDir, "seat-failures.json"), record.seatFailures);
        return record.manifest.group_id;
      }
    }
    return null;
  }

  claimableRunIds(groupId) {
    const record = this.get(groupId);
    if (!record) return [];
    return record.manifest.entries
      .map((entry) => this.getRun(entry.run_id))
      .filter((run) => run?.status === "armed")
      .map((run) => run.runId);
  }

  activeClaimGroupId() {
    return [...this.groups.values()]
      .filter((record) => this.claimableRunIds(record.manifest.group_id).length > 0)
      .sort((left, right) => String(left.manifest.created_at).localeCompare(String(right.manifest.created_at)))[0]
      ?.manifest.group_id || null;
  }

  entryResult(entry) {
    const run = this.getRun(entry.run_id);
    const summary = run ? readJson(run.summaryPath) : null;
    const failure = this.getSeatFailure(entry.run_id);
    if (!run && !summary && failure) {
      return {
        entry_id: entry.entry_id,
        run_id: entry.run_id,
        model_name: failure.model_name || null,
        harness: failure.harness || null,
        status: failure.status || "failed",
        outcome: failure.outcome || "failed",
        started_at: failure.started_at || null,
        ended_at: failure.ended_at || null,
        rooms_visited: Number(failure.rooms_visited) || 0,
        gems_collected: Number(failure.gems_collected) || 0,
        actions_total: Number(failure.actions_total) || 0,
        novelty: Number(failure.novelty) || 0,
        replay_url: failure.replay_url || `/external-play/${encodeURIComponent(entry.run_id)}`
      };
    }

    let roomsVisited = 0;
    let gemsCollected = 0;
    if (summary) {
      roomsVisited = Number(summary.rooms_visited) || 0;
      gemsCollected = Number(summary.gems_collected) || 0;
    } else if (run) {
      if (run.startedAt) {
        roomsVisited = run.gameSession?.visitedLevels ? run.gameSession.visitedLevels.size : 1;
        gemsCollected = run.gameSession?.collectedGemIds ? run.gameSession.collectedGemIds.size : 0;
      }
    }

    return {
      entry_id: entry.entry_id,
      run_id: entry.run_id,
      model_name: run?.modelName || summary?.declared_model || failure?.model_name || null,
      harness: run?.harnessName || run?.declaredCli || summary?.declared_cli || failure?.harness || null,
      status: run?.status || failure?.status || "missing",
      outcome: run?.outcome || summary?.outcome || failure?.outcome || null,
      started_at: run?.startedAt || summary?.started_at || failure?.started_at || null,
      ended_at: run?.endedAt || summary?.ended_at || failure?.ended_at || null,
      rooms_visited: roomsVisited,
      gems_collected: gemsCollected,
      actions_total: Number(summary?.actions_total ?? run?.lastActionSeq ?? failure?.actions_total) || 0,
      novelty: run ? getRunFinalNovelty(run.runDir, summary) : (Number(failure?.novelty) || 0),
      replay_url: `/external-play/${encodeURIComponent(entry.run_id)}`
    };
  }

  describe(groupId) {
    const record = this.get(groupId);
    if (!record) return null;
    if (!record.result) {
      const currentEntries = record.manifest.entries.map((entry) => this.entryResult(entry));
      const allTerminal = currentEntries.every((entry) => TERMINAL_STATUSES.has(entry.status));
      if (allTerminal) {
        try {
          this.maybeFinalize(groupId);
        } catch (_err) {
          // Keep status as 'finalizing' while write fails
        }
      }
    }
    if (record.result) {
      return {
        ...record.manifest,
        status: "completed",
        entries: record.result.entries,
        result: record.result
      };
    }
    const entries = record.manifest.entries.map((entry) => this.entryResult(entry));
    const allTerminal = entries.every((entry) => TERMINAL_STATUSES.has(entry.status));
    const anyStarted = entries.some((entry) => entry.status !== "armed");
    const status = allTerminal ? "finalizing" : (anyStarted ? "running" : "awaiting_claim");
    return {
      ...record.manifest,
      status,
      entries,
      result: null
    };
  }

  list() {
    return [...this.groups.keys()]
      .map((groupId) => this.describe(groupId))
      .filter(Boolean)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  }

  maybeFinalize(groupId) {
    const record = this.get(groupId);
    if (!record || record.result) return record?.result || null;
    const entries = record.manifest.entries.map((entry) => this.entryResult(entry));
    const allTerminal = entries.every((entry) => TERMINAL_STATUSES.has(entry.status));
    if (!allTerminal) return null;

    const result = {
      schema_version: 1,
      group_id: groupId,
      mode: record.manifest.mode,
      completed_at: new Date().toISOString(),
      entries,
      ranking: record.manifest.mode === "competition" ? rankCompetitionEntries(entries) : null
    };
    if (!this.validateResult(result)) {
      throw new Error(`Invalid run group result: ${JSON.stringify(this.validateResult.errors)}`);
    }
    try {
      writeJsonAtomic(path.join(record.groupDir, "result.json"), result);
      record.result = result;
      if (this.retryTimers.has(groupId)) {
        clearTimeout(this.retryTimers.get(groupId));
        this.retryTimers.delete(groupId);
      }
      return result;
    } catch (err) {
      this.scheduleSettlementRetry(groupId);
      throw err;
    }
  }

  onRunChanged(runId) {
    for (const record of this.groups.values()) {
      if (record.manifest.entries.some((entry) => entry.run_id === runId)) {
        return this.maybeFinalize(record.manifest.group_id);
      }
    }
    return null;
  }
}

module.exports = {
  ExternalRunGroupStore,
  TERMINAL_STATUSES
};
