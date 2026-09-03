"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const childProcess = require("child_process");

const rootDir = path.resolve(__dirname, "..");

// Track all spawned subprocesses and file accesses
const spawnedCommands = [];
const probedPaths = [];

// Intercept child_process methods
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
const originalExecFile = childProcess.execFile;
const originalExecFileSync = childProcess.execFileSync;
const originalExec = childProcess.exec;
const originalExecSync = childProcess.execSync;

function recordCommand(cmd, args) {
  const binary = String(cmd || "");
  const argList = Array.isArray(args) ? args.map(String) : [];
  spawnedCommands.push({ binary, args: argList });
}

childProcess.spawn = function (cmd, args, ...rest) {
  recordCommand(cmd, args);
  return originalSpawn.apply(this, [cmd, args, ...rest]);
};

childProcess.spawnSync = function (cmd, args, ...rest) {
  recordCommand(cmd, args);
  return originalSpawnSync.apply(this, [cmd, args, ...rest]);
};

childProcess.execFile = function (cmd, args, ...rest) {
  recordCommand(cmd, args);
  return originalExecFile.apply(this, [cmd, args, ...rest]);
};

childProcess.execFileSync = function (cmd, args, ...rest) {
  recordCommand(cmd, args);
  return originalExecFileSync.apply(this, [cmd, args, ...rest]);
};

childProcess.exec = function (cmd, ...rest) {
  recordCommand(cmd, []);
  return originalExec.apply(this, [cmd, ...rest]);
};

childProcess.execSync = function (cmd, ...rest) {
  recordCommand(cmd, []);
  return originalExecSync.apply(this, [cmd, ...rest]);
};

// Intercept fs calls to detect .prime access
const originalReadFileSync = fs.readFileSync;
const originalExistsSync = fs.existsSync;
const originalStatSync = fs.statSync;

function recordFileAccess(filePath) {
  const p = String(filePath || "");
  if (p.includes(".prime") || p.includes("prime-config") || p.includes("prime.json")) {
    probedPaths.push(p);
  }
}

fs.readFileSync = function (p, ...rest) {
  recordFileAccess(p);
  return originalReadFileSync.apply(this, [p, ...rest]);
};

fs.existsSync = function (p) {
  recordFileAccess(p);
  return originalExistsSync.apply(this, [p]);
};

fs.statSync = function (p, ...rest) {
  recordFileAccess(p);
  return originalStatSync.apply(this, [p, ...rest]);
};

async function testCleanEnvironmentIsolation() {
  console.log("\n[Section 1] Clean Environment Isolation & Zero-Probe Verification...");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-test-adv-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  // 1. Wipe environment variables
  delete process.env.MAZEBENCH_ENABLE_PRIME;
  delete process.env.PRIME_API_KEY;
  delete process.env.PRIME_CONFIG_PATH;
  delete process.env.PRIME_CONTEXT;
  process.env.MAZEBENCH_ENABLE_PRIME = "0";

  // Clear require cache for server modules to test cold start
  for (const key of Object.keys(require.cache)) {
    if (key.includes("server") || key.includes("shared")) {
      delete require.cache[key];
    }
  }

  spawnedCommands.length = 0;
  probedPaths.length = 0;

  // Assert require.cache does NOT contain integrations/prime before loading server
  let primeModulesInCache = Object.keys(require.cache).filter(
    (k) => k.includes("integrations/prime") || k.includes("integrations\\prime")
  );
  assert.strictEqual(
    primeModulesInCache.length,
    0,
    "require.cache must not contain integrations/prime before app initialization"
  );

  // Load server app in clean environment mode
  const { createServerApp, externalPlay } = require("../server/app");
  if (externalPlay) {
    externalPlay.options.dataHome = testDataHome;
  }

  const app = createServerApp({
    rootDir,
    enablePrime: false
  });

  // Verify require.cache STILL does NOT contain integrations/prime after app creation
  primeModulesInCache = Object.keys(require.cache).filter(
    (k) => k.includes("integrations/prime") || k.includes("integrations\\prime")
  );
  assert.strictEqual(
    primeModulesInCache.length,
    0,
    "require.cache must not contain integrations/prime after app creation in disabled mode"
  );

  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  if (externalPlay && typeof externalPlay.initialize === "function") {
    externalPlay.serverPort = port;
    await externalPlay.initialize();
  }

  try {
    // 1. Check Capabilities endpoint
    const capRes = await fetch(`${baseUrl}/api/capabilities`);
    assert.strictEqual(capRes.status, 200);
    const capBody = await capRes.json();
    assert.strictEqual(capBody.capabilities.external_play, true);
    assert.strictEqual(capBody.capabilities.local_mcp, true);
    assert.strictEqual(capBody.capabilities.prime_integration, false);
    assert(!("training" in capBody.capabilities));

    // 2. Check Agent Environment endpoint (which executes environment probing)
    const envRes = await fetch(`${baseUrl}/api/agent/environment?fresh=1`);
    assert.strictEqual(envRes.status, 200);
    const envBody = await envRes.json();
    assert.strictEqual(envBody.prime, false);
    assert.strictEqual(envBody.prime_installed, false);
    assert.strictEqual(envBody.prime_authenticated, false);
    assert.strictEqual(envBody.uv, false);

    // 3. Check Agent Harnesses endpoint
    const harnessRes = await fetch(`${baseUrl}/api/agent/harnesses`);
    assert.strictEqual(harnessRes.status, 200);
    const harnessBody = await harnessRes.json();
    assert.deepStrictEqual(harnessBody.harnesses, []);

    // 4. Removed Train routes stay unavailable
    for (const route of ["/train", "/api/train/bootstrap", "/api/train/runs"]) {
      const removedRes = await fetch(`${baseUrl}${route}`);
      assert.strictEqual(removedRes.status, 404, `${route} must remain removed`);
    }

    // 5. Check Prime Sync POST -> 400 INTEGRATION_DISABLED
    const syncRes = await fetch(`${baseUrl}/api/agent/runs/fake-run-123/prime-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    assert.strictEqual(syncRes.status, 400);
    const syncBody = await syncRes.json();
    assert.strictEqual(syncBody.code, "INTEGRATION_DISABLED");

    // 7. Check UI Pages (Home, Agent, External Play, Play)
    const homeHtml = await (await fetch(`${baseUrl}/`)).text();
    assert(!homeHtml.includes('href="/train"'), "Home page must omit Train card when training is disabled");
    assert(homeHtml.includes('href="/external-play"'), "Home page must include External Play card");

    const agentHtml = await (await fetch(`${baseUrl}/agent`)).text();
    assert(!agentHtml.includes('/logos/prime.png" type="image/png" fetchpriority="high"'), "Agent page must not preload prime logo when disabled");

    const extPlayHtml = await (await fetch(`${baseUrl}/external-play`)).text();
    assert(extPlayHtml.includes("External Play"), "External Play page must render correctly");

    // 8. Create an External Play Run in clean mode to verify core game loop is 100% operational
    const createRunRes = await fetch(`${baseUrl}/api/external-play/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration_ms: 120000, win_threshold: 5 })
    });
    assert.strictEqual(createRunRes.status, 201);
    const createRunBody = await createRunRes.json();
    assert(createRunBody.run_id, "External Play run should be created successfully");
    assert.strictEqual(createRunBody.status, "armed");

    // Cancel the created run
    const cancelRes = await fetch(`${baseUrl}/api/external-play/runs/${createRunBody.run_id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    assert.strictEqual(cancelRes.status, 200);

    // 9. Inspect recorded child processes
    const primeOrUvCalls = spawnedCommands.filter(
      (c) =>
        c.binary === "prime" ||
        c.binary === "uv" ||
        (c.args && c.args.some((a) => a === "prime" || a === "uv"))
    );
    assert.strictEqual(
      primeOrUvCalls.length,
      0,
      `Expected ZERO prime/uv subprocess calls in clean mode, but found: ${JSON.stringify(primeOrUvCalls)}`
    );

    // 10. Inspect recorded .prime file accesses
    assert.strictEqual(
      probedPaths.length,
      0,
      `Expected ZERO .prime filesystem accesses in clean mode, but found: ${JSON.stringify(probedPaths)}`
    );

    // 11. Assert require.cache still has NO integrations/prime modules
    primeModulesInCache = Object.keys(require.cache).filter(
      (k) => k.includes("integrations/prime") || k.includes("integrations\\prime")
    );
    assert.strictEqual(
      primeModulesInCache.length,
      0,
      "require.cache must NOT contain integrations/prime after executing all clean mode requests"
    );

    console.log("  ✓ Section 1 Passed: 0 prime/uv processes spawned, 0 .prime paths read, 0 integrations/prime modules in require.cache");
  } finally {
    if (externalPlay && typeof externalPlay.dispose === "function") {
      externalPlay.dispose();
    }
    server.close();
    try {
      fs.rmSync(testDataHome, { recursive: true, force: true });
    } catch (_e) {}
  }
}

async function testEnabledEnvironmentIntegration() {
  console.log("\n[Section 2] Enabled Environment Mode (MAZEBENCH_ENABLE_PRIME=1)...");

  process.env.MAZEBENCH_ENABLE_PRIME = "1";

  // Clear require cache for server modules
  for (const key of Object.keys(require.cache)) {
    if (key.includes("server") || key.includes("shared")) {
      delete require.cache[key];
    }
  }

  const { createServerApp } = require("../server/app");
  const app = createServerApp({
    rootDir,
    enablePrime: true
  });

  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Capabilities
    const capRes = await fetch(`${baseUrl}/api/capabilities`);
    assert.strictEqual(capRes.status, 200);
    const capBody = await capRes.json();
    assert.strictEqual(capBody.capabilities.prime_integration, true);
    assert(!("training" in capBody.capabilities));

    // 2. Harnesses
    const harnessRes = await fetch(`${baseUrl}/api/agent/harnesses`);
    assert.strictEqual(harnessRes.status, 200);
    const harnessBody = await harnessRes.json();
    assert(Array.isArray(harnessBody.harnesses));
    assert(harnessBody.harnesses.length > 0);
    assert(harnessBody.harnesses.some((h) => h.id === "mazebench_prime_agent"));

    // 3. UI
    const homeHtml = await (await fetch(`${baseUrl}/`)).text();
    assert(!homeHtml.includes('href="/train"'), "Home page must not include removed Train links");

    const agentHtml = await (await fetch(`${baseUrl}/agent`)).text();
    assert(agentHtml.includes('/logos/prime.png" type="image/png" fetchpriority="high"'), "Agent page must preload prime logo when enabled");

    // 4. Verify PrimeIntegration instance contracts directly
    const { createPrimeIntegration, PrimeIntegration } = require("../server/integrations/prime");
    const integration = createPrimeIntegration({ rootDir });
    assert(integration instanceof PrimeIntegration);
    assert.strictEqual(integration.enabled, true);
    assert(Array.isArray(integration.listHarnesses()));
    assert.strictEqual(integration.normalizeHarness("mazebench_prime_agent"), "mazebench_prime_agent");
    assert.throws(
      () => integration.normalizeHarness("unknown_xyz"),
      /Unknown Prime harness "unknown_xyz"/
    );

    // 5. Test Resume Checkpoint read/write in Prime integration
    const { resume } = require("../server/integrations/prime");
    const tempDir = path.join(rootDir, "outputs", "test-resume-temp-" + Date.now());
    const evalOutDir = path.join(tempDir, "eval-output");
    try {
      fs.mkdirSync(evalOutDir, { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "actions.jsonl"),
        JSON.stringify({
          turn: 1,
          action: "forward",
          status: { board_state_hash: "hash_abc_123" }
        }) + "\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(evalOutDir, "results.jsonl"),
        JSON.stringify({
          task: { system_prompt: "You are a maze solver." },
          nodes: [
            {
              parent: null,
              sampled: false,
              message: { role: "system", content: "You are a maze solver." }
            },
            {
              parent: 0,
              sampled: true,
              message: { role: "assistant", content: "I will move forward." }
            }
          ]
        }) + "\n",
        "utf8"
      );
      const result = resume.writePrimeResumeCheckpoint(tempDir, { sourceRunId: "source-123" });
      assert(result && result.checkpoint, "Checkpoint object should be generated");
      assert.strictEqual(result.checkpoint.version, 1);
      assert.strictEqual(result.checkpoint.action_count, 1);
      assert.strictEqual(result.checkpoint.source_run_id, "source-123");

      const readBack = JSON.parse(fs.readFileSync(result.path, "utf8"));
      assert.strictEqual(readBack.version, 1);
      assert.strictEqual(readBack.action_count, 1);
      assert.strictEqual(readBack.source_run_id, "source-123");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("  ✓ Section 2 Passed: Enabled mode successfully provides capabilities, catalog, harnesses, and resume operations");
  } finally {
    server.close();
  }
}

async function testAdversarialEdgeCases() {
  console.log("\n[Section 3] Adversarial Edge Cases & Defense Boundaries...");

  process.env.MAZEBENCH_ENABLE_PRIME = "0";

  // 1. Direct Python CLI execution in clean environment
  console.log("  -> Testing Python CLI fail-closed behavior for prime subcommands...");
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  // Test `mazebench prime install` with MAZEBENCH_ENABLE_PRIME=0
  const cliCleanResult = childProcess.spawnSync(
    pythonCmd,
    ["-m", "mazebench_cli", "prime", "install"],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        MAZEBENCH_ENABLE_PRIME: "0"
      }
    }
  );
  assert.strictEqual(cliCleanResult.status, 1, "CLI must exit with code 1 when prime is disabled");
  assert(
    cliCleanResult.stderr.includes("Prime integration is disabled"),
    `Expected 'Prime integration is disabled' in stderr, got: ${cliCleanResult.stderr}`
  );

  // Test `mazebench help` works cleanly without errors
  const cliHelpResult = childProcess.spawnSync(
    pythonCmd,
    ["-m", "mazebench_cli", "help"],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        MAZEBENCH_ENABLE_PRIME: "0"
      }
    }
  );
  assert.strictEqual(cliHelpResult.status, 0, "CLI help must exit with code 0");
  assert(cliHelpResult.stdout.includes("run the MazeBench maze game"));

  // 2. AgentRunService direct invocation with primeIntegration: null
  console.log("  -> Testing AgentRunService direct API safety when disabled...");
  const { createAgentRunService } = require("../server/agent-runs");
  const disabledAgentService = createAgentRunService({
    agentEnvironment: () => ({}),
    agentEnvironmentAsync: async () => ({}),
    primeIntegration: null,
    ensureDirectory: () => {},
    getGame: () => ({ id: "maze", worldMap: {} }),
    buildWorlds: { countWorldGems: () => 10 },
    loadJson: () => ({}),
    rootDir,
    worldMaps: {}
  });

  assert.deepStrictEqual(disabledAgentService.listPrimeHarnesses(), {
    harnesses: [],
    verifiers_version: "",
    catalog_fingerprint: "",
    policy: {}
  });
  assert.throws(
    () => disabledAgentService.syncPrimeEvaluation("test-run-id"),
    /Prime integration is disabled/
  );

  console.log("  ✓ Section 3 Passed: All edge cases and defense boundaries hold securely");
}

async function main() {
  console.log("================================================================================");
  console.log("EMPIRICAL ADVERSARIAL CHALLENGE HARNESS: MILESTONE 2 (PRIME CLI DECOUPLING)");
  console.log("================================================================================");

  await testCleanEnvironmentIsolation();
  await testEnabledEnvironmentIntegration();
  await testAdversarialEdgeCases();

  console.log("\n================================================================================");
  console.log(">>> ALL EMPIRICAL ADVERSARIAL CHALLENGES PASSED WITH 100% PERFECTION! <<<");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n❌ ADVERSARIAL CHALLENGE FAILURE:", err);
  process.exit(1);
});
