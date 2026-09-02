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
    execution_class: "external-unverified",
    benchmark_eligible: false,
    created_at: "2026-08-01T10:00:00.000Z",
    duration_ms: 600000,
    win_threshold: 10
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
  assert.equal(listed.total, 1, "External run must be counted in total");
  assert.equal(listed.runs.length, 1, "External run must be present in paginated list");
  const runCard = listed.runs[0];
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
  assert.equal(service.listRuns().total, 0, "Runs list must be empty after deletion");

  console.log("external-runs-display tests passed");
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_e) {}
}
