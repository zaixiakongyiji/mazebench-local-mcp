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
      this.groups.set(manifest.group_id, {
        groupDir,
        manifest,
        result
      });
    }
  }

  create(manifest) {
    if (!this.validateManifest(manifest)) {
      throw new Error(`Invalid run group manifest: ${JSON.stringify(this.validateManifest.errors)}`);
    }
    const groupDir = path.join(this.groupsDir, manifest.group_id);
    fs.mkdirSync(groupDir, { recursive: false });
    writeJsonAtomic(path.join(groupDir, "manifest.json"), manifest);
    const record = { groupDir, manifest, result: null };
    this.groups.set(manifest.group_id, record);
    return record;
  }

  remove(groupId) {
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
    return {
      entry_id: entry.entry_id,
      run_id: entry.run_id,
      model_name: run?.modelName || summary?.declared_model || null,
      harness: run?.harnessName || run?.declaredCli || summary?.declared_cli || null,
      status: run?.status || "missing",
      outcome: run?.outcome || summary?.outcome || null,
      started_at: run?.startedAt || summary?.started_at || null,
      ended_at: run?.endedAt || summary?.ended_at || null,
      rooms_visited: Number(summary?.rooms_visited) || 0,
      gems_collected: Number(summary?.gems_collected) || 0,
      actions_total: Number(summary?.actions_total ?? run?.lastActionSeq) || 0,
      novelty: run ? getRunFinalNovelty(run.runDir, summary) : 0,
      replay_url: `/external-play/${encodeURIComponent(entry.run_id)}`
    };
  }

  describe(groupId) {
    const record = this.get(groupId);
    if (!record) return null;
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
    const status = allTerminal ? "completed" : (anyStarted ? "running" : "awaiting_claim");
    return {
      ...record.manifest,
      status,
      entries,
      result: record.result
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
    const group = this.describe(groupId);
    if (!group || group.status !== "completed") return null;

    const result = {
      schema_version: 1,
      group_id: groupId,
      mode: group.mode,
      completed_at: new Date().toISOString(),
      entries: group.entries,
      ranking: group.mode === "competition" ? rankCompetitionEntries(group.entries) : null
    };
    if (!this.validateResult(result)) {
      throw new Error(`Invalid run group result: ${JSON.stringify(this.validateResult.errors)}`);
    }
    writeJsonAtomic(path.join(record.groupDir, "result.json"), result);
    record.result = result;
    return result;
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
