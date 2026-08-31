const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const { createPrimeIntegration } = require("../server/integrations/prime");
const primeCatalog = require("../server/integrations/prime/catalog");
const primeRunner = require("../server/integrations/prime/runner");
const primeResume = require("../server/integrations/prime/resume");
const { createAgentRunService } = require("../server/agent-runs");
const { createTrainingService } = require("../server/training");
const { createServerApp } = require("../server/app");

const rootDir = path.resolve(__dirname, "..");

async function testPrimeIntegrationModule() {
  console.log("Section 1: Prime standalone integration module tests...");

  const integration = createPrimeIntegration({ rootDir });
  assert(integration, "createPrimeIntegration should return an instance");

  const harnesses = integration.listHarnesses();
  assert(Array.isArray(harnesses), "listHarnesses should return an array");
  assert(harnesses.length > 0, "listHarnesses should contain harness definitions");

  const primeAgent = harnesses.find((h) => h.id === "mazebench_prime_agent");
  assert(primeAgent, "mazebench_prime_agent harness should exist in catalog");
  assert.strictEqual(primeAgent.launchable, true);

  const reasoningLevels = primeCatalog.primeReasoningLevels("openai/gpt-5-nano");
  assert(Array.isArray(reasoningLevels), "primeReasoningLevels should return array");

  const compatible = primeCatalog.primeHarnessModelCompatible("openai/gpt-5-nano", "codex");
  assert.strictEqual(compatible, true, "openai/gpt-5-nano should be compatible with codex harness");

  const text = "sandbox 1234567890123456 up and sandbox-job-abcdef1234567890 for agent.";
  const ids = primeRunner.primeSandboxIdsFromText(text);
  assert.deepStrictEqual(ids, ["1234567890123456", "abcdef1234567890"], "primeSandboxIdsFromText should extract ids");

  const schema = { type: "integer" };
  assert.strictEqual(primeCatalog.primeHarnessConfigValueValid(5, schema), true);
  assert.strictEqual(primeCatalog.primeHarnessConfigValueValid(5.5, schema), false);
  assert.strictEqual(primeCatalog.primeHarnessConfigValueValid("invalid", schema), false);

  const enumSchema = { enum: ["a", "b"] };
  assert.strictEqual(primeCatalog.primeHarnessConfigValueValid("a", enumSchema), true);
  assert.strictEqual(primeCatalog.primeHarnessConfigValueValid("c", enumSchema), false);

  console.log("  ✓ Prime integration module passed");
}

async function testAgentRunServiceDisabledMode() {
  console.log("Section 2: Agent run service in disabled mode (primeIntegration = null)...");

  const service = createAgentRunService({
    agentEnvironment: () => ({}),
    agentEnvironmentAsync: async () => ({}),
    primeIntegration: null,
    ensureDirectory: () => {},
    getGame: () => ({ id: "maze", worldMap: {} }),
    buildWorlds: { countWorldGems: () => 100 },
    loadJson: () => ({}),
    rootDir,
    worldMaps: {}
  });

  const harnessList = service.listPrimeHarnesses();
  assert.deepStrictEqual(harnessList.harnesses, [], "listPrimeHarnesses should return empty array when disabled");

  assert.throws(
    () => {
      service.syncPrimeEvaluation("nonexistent-run");
    },
    /Prime integration is disabled/,
    "syncPrimeEvaluation should throw disabled error"
  );

  console.log("  ✓ Agent run service disabled mode passed");
}

async function testTrainingServiceDisabledMode() {
  console.log("Section 3: Training service disabled mode...");

  const training = createTrainingService({
    buildWorlds: { countWorldGems: () => 100 },
    getGame: () => ({ id: "maze" }),
    rootDir,
    worldMaps: { defaultLevelIdForGame: () => "level_HxI" },
    primeIntegration: null,
    enabled: false
  });

  const bootstrap = training.bootstrap();
  assert.strictEqual(bootstrap.readiness.ready, false);
  assert.strictEqual(bootstrap.readiness.issue, "Prime integration is disabled.");
  assert.deepStrictEqual(bootstrap.models, []);

  const bootstrapAsync = await training.bootstrapAsync();
  assert.strictEqual(bootstrapAsync.readiness.ready, false);
  assert.strictEqual(bootstrapAsync.readiness.issue, "Prime integration is disabled.");

  const runs = training.listRuns();
  assert.deepStrictEqual(runs, { runs: [], total: 0 });

  const runsAsync = await training.listRunsAsync();
  assert.deepStrictEqual(runsAsync, { runs: [], total: 0 });

  assert.throws(
    () => {
      training.launch({});
    },
    /Prime integration is disabled|Choose an available Hosted Training model/,
    "training.launch should reject when disabled"
  );

  console.log("  ✓ Training service disabled mode passed");
}

async function testServerCapabilitiesAndRoutes() {
  console.log("Section 4: Server capabilities and HTTP route gating...");

  // Start server in default mode (enablePrime: false)
  const app = createServerApp({
    rootDir,
    enablePrime: false
  });

  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/capabilities
    const capRes = await fetch(`${baseUrl}/api/capabilities`);
    assert.strictEqual(capRes.status, 200);
    const capJson = await capRes.json();
    assert.deepStrictEqual(capJson.capabilities, {
      external_play: true,
      local_mcp: true,
      prime_integration: false,
      training: false
    });

    // 2. GET /api/agent/harnesses
    const harnessRes = await fetch(`${baseUrl}/api/agent/harnesses`);
    assert.strictEqual(harnessRes.status, 200);
    const harnessJson = await harnessRes.json();
    assert.deepStrictEqual(harnessJson.harnesses, []);

    // 3. GET /api/train/bootstrap
    const trainBootRes = await fetch(`${baseUrl}/api/train/bootstrap`);
    assert.strictEqual(trainBootRes.status, 400);
    const trainBootJson = await trainBootRes.json();
    assert.strictEqual(trainBootJson.code, "INTEGRATION_DISABLED");

    // 4. POST /api/train/runs
    const trainRunRes = await fetch(`${baseUrl}/api/train/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.strictEqual(trainRunRes.status, 400);
    const trainRunJson = await trainRunRes.json();
    assert.strictEqual(trainRunJson.code, "INTEGRATION_DISABLED");

    // 5. POST /api/agent/runs/some-id/prime-sync
    const syncRes = await fetch(`${baseUrl}/api/agent/runs/some-id/prime-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    assert.strictEqual(syncRes.status, 400);
    const syncJson = await syncRes.json();
    assert.strictEqual(syncJson.code, "INTEGRATION_DISABLED");

    // 6. Home page HTML should not include Train card when training capability is false
    const homeRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(homeRes.status, 200);
    const homeHtml = await homeRes.text();
    assert(!homeHtml.includes('href="/train"'), "Home page should not render /train link when disabled");
    assert(homeHtml.includes('href="/external-play"'), "Home page should render /external-play link");

    console.log("  ✓ Server route gating passed (default disabled mode)");
  } finally {
    server.close();
  }

  // Start server in enabled mode (enablePrime: true)
  const appEnabled = createServerApp({
    rootDir,
    enablePrime: true
  });

  const serverEnabled = http.createServer(appEnabled.handleRequest);
  await new Promise((resolve) => serverEnabled.listen(0, "127.0.0.1", resolve));
  const portEnabled = serverEnabled.address().port;
  const baseUrlEnabled = `http://127.0.0.1:${portEnabled}`;

  try {
    const capRes = await fetch(`${baseUrlEnabled}/api/capabilities`);
    assert.strictEqual(capRes.status, 200);
    const capJson = await capRes.json();
    assert.strictEqual(capJson.capabilities.prime_integration, true);
    assert.strictEqual(capJson.capabilities.training, true);

    const harnessRes = await fetch(`${baseUrlEnabled}/api/agent/harnesses`);
    assert.strictEqual(harnessRes.status, 200);
    const harnessJson = await harnessRes.json();
    assert(Array.isArray(harnessJson.harnesses));
    assert(harnessJson.harnesses.length > 0);

    const homeRes = await fetch(`${baseUrlEnabled}/`);
    assert.strictEqual(homeRes.status, 200);
    const homeHtml = await homeRes.text();
    assert(homeHtml.includes('href="/train"'), "Home page should render /train link when enabled");

    console.log("  ✓ Server route gating passed (enabled mode)");
  } finally {
    serverEnabled.close();
  }
}

async function runAll() {
  console.log("=== Running Prime Integration Decoupled Test Suite ===");
  await testPrimeIntegrationModule();
  await testAgentRunServiceDisabledMode();
  await testTrainingServiceDisabledMode();
  await testServerCapabilitiesAndRoutes();
  console.log("\nALL PRIME INTEGRATION DECOUPLING TESTS PASSED! (100% GREEN)");
}

runAll().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
