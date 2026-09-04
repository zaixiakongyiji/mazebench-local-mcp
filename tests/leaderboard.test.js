const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-leaderboard-test-"));
const extDataHome = path.join(tempRoot, "data-home");
const extRunsDir = path.join(extDataHome, "external-runs");
process.env.MAZEBENCH_DATA_HOME = extDataHome;

function createTestExternalRun(runId, data) {
  const runDir = path.join(extRunsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify({
      run_id: runId,
      run_kind: "external_play",
      execution_class: "external-unverified",
      benchmark_eligible: false,
      created_at: data.created_at || "2026-08-01T10:00:00.000Z",
      duration_ms: 600000,
      win_threshold: 10,
      model_name: data.model_name || undefined,
      max_actions: data.max_actions !== undefined ? data.max_actions : 256
    })
  );

  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({
      summary_schema_version: 1,
      run_id: runId,
      outcome: data.outcome || "won",
      is_partial: false,
      started_at: data.created_at || "2026-08-01T10:00:01.000Z",
      ended_at: "2026-08-01T10:05:00.000Z",
      elapsed_seconds: 299,
      gems_collected: data.gems || 0,
      gems_total: 10,
      rooms_visited: data.rooms || 1,
      rooms_total: 100,
      actions_total: data.actions || 50,
      novelty: data.novelty !== undefined ? data.novelty : 0,
      max_actions: data.max_actions !== undefined ? data.max_actions : 256,
      declared_cli: data.harness || "antigravity-mcp",
      declared_model: data.model_name || undefined,
      route: Array.from({ length: data.rooms || 1 }, (_, i) => `level_room_${i}`),
      progress_curve: []
    })
  );
}

// 1. 创建未命名/默认占位符的运行 (应被排行榜过滤)
createTestExternalRun("ext-anon-1", {
  rooms: 10,
  gems: 10,
  actions: 100,
  model_name: undefined // fallback to External MCP
});

createTestExternalRun("ext-anon-2", {
  rooms: 15,
  gems: 15,
  actions: 100,
  model_name: "External MCP" // generic placeholder
});

// 2. 创建真实模型名称的标准 256 步测试运行
// Model A: Claude 3.7 Sonnet (run 1: 8 rooms, 5 gems, 200 actions)
createTestExternalRun("ext-claude-1", {
  model_name: "Claude 3.7 Sonnet",
  rooms: 8,
  gems: 5,
  actions: 200,
  max_actions: 256,
  created_at: "2026-08-01T10:00:00.000Z"
});

// Model A: Claude 3.7 Sonnet (run 2: 12 rooms, 8 gems, 256 actions) - Claude 自身最佳
createTestExternalRun("ext-claude-2", {
  model_name: "Claude 3.7 Sonnet",
  rooms: 12,
  gems: 8,
  actions: 256,
  max_actions: 256,
  created_at: "2026-08-01T11:00:00.000Z"
});

// Model B: Gemini 2.5 Flash (run 1: 9 rooms, 16 gems, 240 actions) - 宝石第一
createTestExternalRun("ext-gemini-1", {
  model_name: "Gemini 2.5 Flash",
  rooms: 9,
  gems: 16,
  actions: 240,
  max_actions: 256,
  novelty: 50,
  created_at: "2026-08-01T12:00:00.000Z"
});

// Model D: DeepSeek V4 Flash (2 rooms, 0 gems, 256 actions, novelty 30)
createTestExternalRun("ext-deepseek-flash", {
  model_name: "DeepSeek V4 Flash",
  rooms: 2,
  gems: 0,
  actions: 256,
  max_actions: 256,
  novelty: 30,
  created_at: "2026-08-01T08:00:00.000Z"
});

// Model E: DeepSeek V4 Pro (2 rooms, 0 gems, 256 actions, novelty 12, created_at 更晚)
createTestExternalRun("ext-deepseek-pro", {
  model_name: "DeepSeek V4 Pro",
  rooms: 2,
  gems: 0,
  actions: 256,
  max_actions: 256,
  novelty: 12,
  created_at: "2026-08-01T09:00:00.000Z"
});

// Model C: GPT-4o (run 1: 超长非标准 1000 步场次, 20 rooms, 20 gems, 500 actions)
createTestExternalRun("ext-gpt4o-long", {
  model_name: "GPT-4o",
  rooms: 20,
  gems: 20,
  actions: 500,
  max_actions: 1000,
  created_at: "2026-08-01T13:00:00.000Z"
});

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
  const leaderboard = service.getLeaderboard();

  // 1. 验证总有效模型运行数 (应排除 ext-anon-1 和 ext-anon-2, 共 6 个有效运行)
  assert.equal(leaderboard.total_named_runs, 6, "Should only count runs with a valid declared model name");

  // 2. 验证标准 256 步过滤 (GPT-4o 设了 1000 步且用了 500 步，不应出现在 standard 榜中)
  const standardRoomsPerModel = leaderboard.standard.by_rooms.per_model;
  const standardGemsPerModel = leaderboard.standard.by_gems.per_model;
  assert.equal(standardRoomsPerModel.length, 4, "Standard 256 steps per-model should have Claude, Gemini, DeepSeek Flash, DeepSeek Pro");
  assert.equal(standardGemsPerModel.length, 4, "Standard 256 steps per-model should have Claude, Gemini, DeepSeek Flash, DeepSeek Pro");

  // 3. 验证标准 256 步下的最多房间榜 (Claude 最佳为 12 房间，应排名第一)
  assert.equal(standardRoomsPerModel[0].rank, 1);
  assert.equal(standardRoomsPerModel[0].model_name, "Claude 3.7 Sonnet");
  assert.equal(standardRoomsPerModel[0].model_family, "claude");
  assert.equal(typeof standardRoomsPerModel[0].room_percentage, "number");
  assert.equal(typeof standardRoomsPerModel[0].gem_percentage, "number");
  assert.equal(standardRoomsPerModel[0].room_count, 12);
  assert.equal(standardRoomsPerModel[0].gem_count, 8);
  assert.equal(standardRoomsPerModel[0].id, "ext-claude-2");

  assert.equal(standardRoomsPerModel[1].rank, 2);
  assert.equal(standardRoomsPerModel[1].model_name, "Gemini 2.5 Flash");
  assert.equal(standardRoomsPerModel[1].room_count, 9);
  assert.equal(standardRoomsPerModel[1].gem_count, 16);

  // 验证房间数打平且宝石/步数相同时，看棋盘新颖度 (DeepSeek Flash 30% > DeepSeek Pro 12%)
  assert.equal(standardRoomsPerModel[2].rank, 3);
  assert.equal(standardRoomsPerModel[2].model_name, "DeepSeek V4 Flash");
  assert.equal(standardRoomsPerModel[2].novelty, 30);
  assert.equal(standardRoomsPerModel[2].id, "ext-deepseek-flash");

  assert.equal(standardRoomsPerModel[3].rank, 4);
  assert.equal(standardRoomsPerModel[3].model_name, "DeepSeek V4 Pro");
  assert.equal(standardRoomsPerModel[3].novelty, 12);
  assert.equal(standardRoomsPerModel[3].id, "ext-deepseek-pro");

  // 4. 验证标准 256 步下的最多宝石榜 (Gemini 为 16 颗宝石，应排名第一)
  assert.equal(standardGemsPerModel[0].rank, 1);
  assert.equal(standardGemsPerModel[0].model_name, "Gemini 2.5 Flash");
  assert.equal(standardGemsPerModel[0].gem_count, 16);
  assert.equal(standardGemsPerModel[0].room_count, 9);
  assert.equal(standardGemsPerModel[0].id, "ext-gemini-1");

  assert.equal(standardGemsPerModel[1].rank, 2);
  assert.equal(standardGemsPerModel[1].model_name, "Claude 3.7 Sonnet");
  assert.equal(standardGemsPerModel[1].gem_count, 8);
  assert.equal(standardGemsPerModel[1].id, "ext-claude-2");

  // 最多宝石榜中，两者宝石均为0，房间数同为2，总步数同为256，看新颖度 (Flash 30% > Pro 12%)
  assert.equal(standardGemsPerModel[2].rank, 3);
  assert.equal(standardGemsPerModel[2].model_name, "DeepSeek V4 Flash");
  assert.equal(standardGemsPerModel[2].novelty, 30);
  assert.equal(standardGemsPerModel[2].id, "ext-deepseek-flash");

  assert.equal(standardGemsPerModel[3].rank, 4);
  assert.equal(standardGemsPerModel[3].model_name, "DeepSeek V4 Pro");
  assert.equal(standardGemsPerModel[3].novelty, 12);
  assert.equal(standardGemsPerModel[3].id, "ext-deepseek-pro");

  // 5. 验证全部记录 (all_runs) 榜单保留所有满足条件的记录
  const standardRoomsAllRuns = leaderboard.standard.by_rooms.all_runs;
  assert.equal(standardRoomsAllRuns.length, 5, "All runs in standard should contain 2 Claude runs, 1 Gemini run, and 2 DeepSeek runs");
  assert.equal(standardRoomsAllRuns[0].id, "ext-claude-2");
  assert.equal(standardRoomsAllRuns[1].id, "ext-gemini-1");
  assert.equal(standardRoomsAllRuns[2].id, "ext-claude-1");
  assert.equal(standardRoomsAllRuns[3].id, "ext-deepseek-flash");
  assert.equal(standardRoomsAllRuns[4].id, "ext-deepseek-pro");

  // 6. 验证全步数 (all steps) 榜单包含长局 (GPT-4o 20 房间排第一)
  const allRoomsPerModel = leaderboard.all.by_rooms.per_model;
  assert.equal(allRoomsPerModel[0].model_name, "GPT-4o");
  assert.equal(allRoomsPerModel[0].room_count, 20);
  assert.equal(allRoomsPerModel[0].id, "ext-gpt4o-long");

  console.log("Leaderboard unit tests passed successfully!");
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_e) {}
}
