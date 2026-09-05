const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-ext-test-"));
const extDataHome = path.join(tempRoot, "data-home");
const extRunsDir = path.join(extDataHome, "external-runs");
process.env.MAZEBENCH_DATA_HOME = extDataHome;

const testRunId = "ext-12345678-abcd-ef01-2345-6789abcdef01";
const testRunDir = path.join(extRunsDir, testRunId);
fs.mkdirSync(testRunDir, { recursive: true });

fs.writeFileSync(
  path.join(testRunDir, "manifest.json"),
  JSON.stringify({
    run_id: testRunId,
    run_kind: "external_play",
    execution_class: "external",
    benchmark_eligible: false,
    created_at: "2026-08-01T10:00:00.000Z",
    duration_ms: 600000,
    win_threshold: 10,
    group_id: "grp-12345678-abcd-ef01-2345-6789abcdef01",
    entry_id: "entry-1",
    group_mode: "concurrent"
  })
);

fs.writeFileSync(
  path.join(testRunDir, "summary.json"),
  JSON.stringify({
    summary_schema_version: 1,
    run_id: testRunId,
    outcome: "won",
    is_partial: false,
    started_at: "2026-08-01T10:00:01.000Z",
    ended_at: "2026-08-01T10:05:00.000Z",
    elapsed_seconds: 299,
    gems_collected: 5,
    gems_total: 10,
    rooms_visited: 3,
    rooms_total: 100,
    actions_total: 88,
    declared_cli: "antigravity-mcp",
    declared_model: "custom-model",
    route: ["level_HxI", "level_HxH", "level_GxH"],
    progress_curve: []
  })
);

const legacyRunId = "ext-legacy-12345678-abcd-ef01-23456789";
const legacyRunDir = path.join(extRunsDir, legacyRunId);
fs.mkdirSync(legacyRunDir, { recursive: true });
const legacyManifest = JSON.parse(fs.readFileSync(path.join(testRunDir, "manifest.json"), "utf8"));
const legacySummary = JSON.parse(fs.readFileSync(path.join(testRunDir, "summary.json"), "utf8"));
fs.writeFileSync(path.join(legacyRunDir, "manifest.json"), JSON.stringify({
  ...legacyManifest,
  run_id: legacyRunId,
  execution_class: "external-unverified",
  created_at: "2026-07-31T10:00:00.000Z"
}));
fs.writeFileSync(path.join(legacyRunDir, "summary.json"), JSON.stringify({
  ...legacySummary,
  run_id: legacyRunId,
  declared_model: "legacy-model"
}));

const loadJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
};

const service = createAgentRunService({
  agentEnvironment: () => ({ docker: false, docker_installed: false }),
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => ({ id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } }),
  buildWorlds: { countWorldGems: () => 0 },
  loadJson,
  rootDir: tempRoot,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});

try {
  // 1. Test listRuns() includes external runs with accurate fields
  const listed = service.listRuns();
  assert.equal(listed.total, 2, "New and legacy external runs must be counted in total");
  assert.equal(listed.runs.length, 2, "External runs must be present in paginated list");
  const runCard = listed.runs.find((run) => run.id === testRunId);
  assert.equal(runCard.id, testRunId);
  assert.equal(runCard.kind, "external");
  assert.equal(runCard.turns, 88);
  assert.equal(runCard.moves, 88);
  assert.equal(runCard.gem_count, 5);
  assert.equal(runCard.room_count, 3);
  assert.equal(runCard.model_name, "custom-model");
  assert.equal(runCard.harness_label, "antigravity-mcp");
  assert.equal(runCard.status, "finished");
  assert.equal(runCard.url, `/external-play/${encodeURIComponent(testRunId)}`);
  assert.equal(runCard.unverified, false, "New external records must not show the legacy unverified label");
  assert.equal(
    listed.runs.find((run) => run.id === legacyRunId).unverified,
    true,
    "Legacy external-unverified records must remain readable"
  );

  // 2. Test summarizeRun for single external run
  const summarized = service.summarizeRun(testRunId);
  assert.ok(summarized, "summarizeRun must return summary object for external run");
  assert.equal(summarized.id, testRunId);
  assert.equal(summarized.turns, 88);
  assert.equal(summarized.gem_count, 5);

  // 3. Test favorite toggling for external run
  assert.equal(summarized.favorited, false);
  const favorited = service.setRunFavorite(testRunId, true);
  assert.equal(favorited.favorited, true, "External run must support favoriting");
  assert.equal(service.summarizeRun(testRunId).favorited, true);

  const unfavorited = service.setRunFavorite(testRunId, false);
  assert.equal(unfavorited.favorited, false, "External run must support unfavoriting");
  assert.equal(service.summarizeRun(testRunId).favorited, false);

  // 4. Test deleteRun for external run
  const deleteResult = service.deleteRun(testRunId);
  assert.equal(deleteResult.deleted, true, "External run deletion must succeed");
  assert.equal(fs.existsSync(testRunDir), false, "External run directory must be deleted");
  assert.equal(service.listRuns().total, 1, "Deleting a new run must not affect legacy history");
  service.deleteRun(legacyRunId);
  assert.equal(service.listRuns().total, 0, "Runs list must be empty after both deletions");

  // 5. Test active claimed run without summary preserves model identity and running status
  const activeRunId = "ext-active-12345678-abcd-ef01-23456789";
  const activeRunDir = path.join(extRunsDir, activeRunId);
  fs.mkdirSync(activeRunDir, { recursive: true });
  fs.writeFileSync(path.join(activeRunDir, "manifest.json"), JSON.stringify({
    run_id: activeRunId,
    run_kind: "external_play",
    execution_class: "external",
    benchmark_eligible: false,
    created_at: "2026-08-02T10:00:00.000Z"
  }));
  const journalLines = [
    JSON.stringify({
      journal_seq: 1,
      timestamp: "2026-08-02T10:00:00.000Z",
      run_id: activeRunId,
      type: "run_armed",
      manifest: { run_id: activeRunId }
    }),
    JSON.stringify({
      journal_seq: 2,
      timestamp: "2026-08-02T10:00:01.000Z",
      run_id: activeRunId,
      type: "run_started",
      started_at: "2026-08-02T10:00:01.000Z",
      model_name: "gemini-2.5-pro",
      declared_cli: "my-custom-cli",
      controller_id: "my-custom-cli-abcd1234",
      lease_id: "lease-1",
      lease_epoch: 1,
      lease_expires_at: new Date(Date.now() + 60000).toISOString()
    }),
    JSON.stringify({
      journal_seq: 3,
      timestamp: "2026-08-02T10:00:02.000Z",
      run_id: activeRunId,
      type: "action_committed",
      action_seq: 3,
      event_id: 1,
      viewer_state_hash: "0".repeat(64),
      action_record: { seq: 3, message: { action: "right" } }
    })
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(activeRunDir, "journal.jsonl"), journalLines, "utf8");

  const activeCard = service.summarizeRun(activeRunId);
  assert.equal(activeCard.model_name, "gemini-2.5-pro");
  assert.equal(activeCard.harness_label, "my-custom-cli");
  assert.equal(activeCard.status, "running");
  assert.equal(activeCard.turns, 3);
  service.deleteRun(activeRunId);

  console.log("external-runs-display tests passed");
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_e) {}
}
