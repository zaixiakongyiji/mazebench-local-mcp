const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  ExternalPlayService,
  RunInstance
} = require("../server/external-play");
const { createRequestRouter } = require("../server/router");

const TERMINAL_STATUSES = new Set(["won", "action_limit", "timed_out", "cancelled", "failed"]);

async function runAdversarialTerminalReclaimTests() {
  console.log("================================================================================");
  console.log("Starting Milestone 1 (Server-side Terminal Reclaim Verification) Stress Suite...");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-m1-challenger-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  let totalAssertions = 0;
  function pass() {
    totalAssertions++;
  }

  const service = new ExternalPlayService({ dataHome: testDataHome, port: 3049, defaultMaxActions: 5 });
  await service.initialize();

  // Helper for router testing
  const router = createRequestRouter({
    externalPlay: service,
    publicFileRoutes: new Map(),
    readJsonBody: async (req) => req.__body || {},
    sendJson: (res, status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    },
    getLevelState: () => ({ width: 10, height: 10 }),
    getLevel: () => ({ id: "lvl-1" }),
    getGame: () => ({ id: "maze" }),
    worldMaps: {
      defaultLevelIdForGame: () => "lvl-1",
      isMazeWorldLevelId: () => false
    }
  });

  const invokePost = async (body, headers = {}) => {
    let resStatus = 0;
    let resJson = null;
    let resHeaders = {};
    const req = {
      method: "POST",
      url: "/api/external-play/controller/session",
      headers: {
        host: "127.0.0.1:3049",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...headers
      },
      socket: { remoteAddress: "127.0.0.1" },
      __body: body
    };
    const res = {
      writeHead(status, h = {}) {
        resStatus = status;
        resHeaders = h;
      },
      end(data) {
        if (data) {
          try {
            resJson = JSON.parse(data);
          } catch (_e) {
            resJson = data;
          }
        }
      }
    };
    await router.handleRequest(req, res);
    return { status: resStatus, body: resJson, headers: resHeaders };
  };

  const newController = async (name) => {
    const session = await service.handleControllerSession(service.mcpBootstrapNonce, { name });
    return service.validateControllerToken(`Bearer ${session.controller_token}`);
  };

  try {
    // Setup terminal and non-terminal runs for testing
    console.log("Setting up test runs...");
    const ctrlSetup = await newController("ctrl-setup");
    
    // 1. Terminal won run
    const runWon = await service.createRun({ maxActions: 5 });
    await service.claimRun(ctrlSetup, { model_name: "Model Won" });
    await runWon._startFinalize("won", "Goal reached");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runWon.status, "won");
    pass();

    // 2. Active run
    const ctrlActive = await newController("ctrl-active");
    const runActive = await service.createRun({ maxActions: 5 });
    await service.claimRun(ctrlActive, { model_name: "Model Active" });
    assert.equal(runActive.status, "active");
    pass();

    // 3. Armed run (unclaimed)
    const runArmed = await service.createRun({ maxActions: 5 });
    assert.equal(runArmed.status, "armed");
    pass();

    // -------------------------------------------------------------------------
    // Suite 1: Boundary and Type Defensive Testing for previous_run_id
    // -------------------------------------------------------------------------
    console.log("\n--- [Suite 1] Boundary & Defensive Type Fuzzing for previous_run_id ---");

    const invalidTypeCases = [
      { name: "empty string", val: "" },
      { name: "whitespace only", val: "   \t\n  " },
      { name: "number integer", val: 12345 },
      { name: "number zero", val: 0 },
      { name: "number float", val: 3.14159 },
      { name: "boolean true", val: true },
      { name: "boolean false", val: false },
      { name: "plain object", val: {} },
      { name: "object with runId", val: { run_id: runWon.runId } },
      { name: "empty array", val: [] },
      { name: "array of strings", val: [runWon.runId] }
    ];

    for (const tc of invalidTypeCases) {
      const nonceBefore = service.mcpBootstrapNonce;

      // 1. Direct service call
      await assert.rejects(
        service.handleControllerSession(
          nonceBefore,
          { name: "fuzz-client" },
          { previousRunId: tc.val }
        ),
        (err) => {
          assert.equal(err.status, 400, `Expected 400 for ${tc.name}`);
          assert.equal(err.code, "INVALID_ARGUMENT");
          return true;
        },
        `Service must reject ${tc.name} with 400 INVALID_ARGUMENT`
      );
      assert.equal(service.mcpBootstrapNonce, nonceBefore, `Nonce must NOT be consumed on ${tc.name}`);
      pass();

      // 2. HTTP router layer call
      const httpRes = await invokePost({
        mcp_bootstrap_nonce: nonceBefore,
        clientInfo: { name: "fuzz-http" },
        previous_run_id: tc.val
      });
      assert.equal(httpRes.status, 400, `HTTP status must be 400 for ${tc.name}`);
      assert.equal(httpRes.body?.code, "INVALID_ARGUMENT");
      assert.equal(service.mcpBootstrapNonce, nonceBefore, `Nonce must NOT be consumed via HTTP on ${tc.name}`);
      pass();
    }

    // Path traversal, prototype injection, and exotic string cases
    const maliciousStringCases = [
      { name: "path traversal unix", val: "../../../../etc/passwd" },
      { name: "path traversal windows", val: "..\\..\\..\\windows\\system32\\config\\sam" },
      { name: "root absolute path", val: "/etc/shadow" },
      { name: "windows drive absolute", val: "C:\\boot.ini" },
      { name: "null byte injection", val: "run-\u0000-injected" },
      { name: "newline injection", val: "run-\r\n-injected" },
      { name: "HTML/script injection", val: "<script>alert('xss')</script>" },
      { name: "SQL injection quote", val: "ext-' OR '1'='1" },
      { name: "prototype property __proto__", val: "__proto__" },
      { name: "prototype property constructor", val: "constructor" },
      { name: "prototype property toString", val: "toString" },
      { name: "prototype property valueOf", val: "valueOf" },
      { name: "huge string 16KB", val: "a".repeat(16384) },
      { name: "unicode and emojis", val: "ext-🎯-测试-🚀-2026" }
    ];

    for (const sc of maliciousStringCases) {
      const nonceBefore = service.mcpBootstrapNonce;

      // 1. Direct service call
      await assert.rejects(
        service.handleControllerSession(
          nonceBefore,
          { name: "fuzz-sec-client" },
          { previousRunId: sc.val }
        ),
        (err) => {
          assert.equal(err.status, 409, `Expected 409 for ${sc.name}`);
          assert.equal(err.code, "PREVIOUS_RUN_UNVERIFIED");
          assert.equal(err.run_id, sc.val.trim());
          return true;
        },
        `Service must reject unverified string ${sc.name} with 409 PREVIOUS_RUN_UNVERIFIED`
      );
      assert.equal(service.mcpBootstrapNonce, nonceBefore, `Nonce must NOT be consumed on ${sc.name}`);
      pass();

      // 2. HTTP router layer call
      const httpRes = await invokePost({
        mcp_bootstrap_nonce: nonceBefore,
        clientInfo: { name: "fuzz-sec-http" },
        previous_run_id: sc.val
      });
      assert.equal(httpRes.status, 409, `HTTP status must be 409 for ${sc.name}`);
      assert.equal(httpRes.body?.code, "PREVIOUS_RUN_UNVERIFIED");
      assert.equal(httpRes.body?.run_id, sc.val.trim());
      assert.equal(service.mcpBootstrapNonce, nonceBefore, `Nonce must NOT be consumed via HTTP on ${sc.name}`);
      pass();
    }

    // -------------------------------------------------------------------------
    // Suite 2: State Machine Status Matrix Verification
    // -------------------------------------------------------------------------
    console.log("\n--- [Suite 2] State Machine Status Matrix Verification ---");

    // Non-terminal: armed run
    const nonceArmed = service.mcpBootstrapNonce;
    await assert.rejects(
      service.handleControllerSession(
        nonceArmed,
        { name: "armed-reclaim" },
        { previousRunId: runArmed.runId }
      ),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "RUN_RESUME_REQUIRED");
        assert.equal(err.run_id, runArmed.runId);
        assert.equal(err.status_name, "armed");
        return true;
      }
    );
    assert.equal(service.mcpBootstrapNonce, nonceArmed, "Nonce must not be consumed for armed run");
    pass();

    // Non-terminal: active run
    const nonceActive = service.mcpBootstrapNonce;
    await assert.rejects(
      service.handleControllerSession(
        nonceActive,
        { name: "active-reclaim" },
        { previousRunId: runActive.runId }
      ),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "RUN_RESUME_REQUIRED");
        assert.equal(err.run_id, runActive.runId);
        assert.equal(err.status_name, "active");
        return true;
      }
    );
    assert.equal(service.mcpBootstrapNonce, nonceActive, "Nonce must not be consumed for active run");
    pass();

    // Terminal statuses: action_limit, timed_out, cancelled, failed
    const terminalOutcomes = ["action_limit", "timed_out", "cancelled"];
    for (const outcome of terminalOutcomes) {
      const c = await newController(`ctrl-${outcome}`);
      const r = await service.createRun({ maxActions: 5 });
      await service.claimRun(c, { model_name: `Model ${outcome}` });
      assert.equal(service.controllerRunBindings.get(c.controllerId), r.runId);

      // Transition to terminal outcome
      await r._startFinalize(outcome, `Ended with ${outcome}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(r.status, outcome);

      const nonceBefore = service.mcpBootstrapNonce;
      const res = await service.handleControllerSession(
        nonceBefore,
        { name: `ctrl-reclaim-${outcome}` },
        { previousRunId: r.runId }
      );

      assert.ok(res.controller_token);
      assert.ok(res.controller_id.startsWith(`ctrl-reclaim-${outcome}`));
      assert.equal(res.instance_id, service.instanceId);
      assert.deepEqual(res.previous_run, {
        run_id: r.runId,
        ended: true,
        status: outcome
      });
      assert.equal(service.controllerRunBindings.has(c.controllerId), false, `Old binding for ${outcome} must be purged`);
      assert.equal(service.controllerRunBindings.has(res.controller_id), false, "New controller must not be bound yet");
      assert.notEqual(service.mcpBootstrapNonce, nonceBefore, `Nonce must rotate after successful ${outcome} reclaim`);
      pass();
    }

    // Special terminal status: failed
    {
      const cFailed = await newController("ctrl-failed");
      const rFailed = await service.createRun({ maxActions: 5 });
      await service.claimRun(cFailed, { model_name: "Model Failed" });
      rFailed._writeSummaryAtomically = () => {
        throw new Error("synthetic storage error to trigger failed terminal state");
      };
      await rFailed._startFinalize("cancelled", "Trigger failure path");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(rFailed.status, "failed");

      const nonceBefore = service.mcpBootstrapNonce;
      const res = await service.handleControllerSession(
        nonceBefore,
        { name: "ctrl-reclaim-failed" },
        { previousRunId: rFailed.runId }
      );

      assert.ok(res.controller_token);
      assert.equal(res.previous_run.status, "failed");
      assert.equal(res.previous_run.ended, true);
      assert.equal(service.controllerRunBindings.has(cFailed.controllerId), false, "Old binding for failed must be purged");
      assert.notEqual(service.mcpBootstrapNonce, nonceBefore, "Nonce must rotate after failed reclaim");
      pass();
    }

    // -------------------------------------------------------------------------
    // Suite 3: Nonce Resilience under Repeated Failure Stress
    // -------------------------------------------------------------------------
    console.log("\n--- [Suite 3] Nonce Resilience under 50 Repeated Failures ---");

    const initialNonce = service.mcpBootstrapNonce;
    const serverJsonPath = path.join(testDataHome, "server.json");
    const initialServerJsonContent = fs.readFileSync(serverJsonPath, "utf8");
    const initialTokenCount = service.controllerTokens.size;

    // Create fresh runs for Suite 3 to guarantee their state is untouched
    const suite3Armed = await service.createRun({ maxActions: 5 });
    assert.equal(suite3Armed.status, "armed");

    // Execute 50 consecutive failing requests with the same nonce
    const failureGenerators = [
      () => ({ previousRunId: "" }),
      () => ({ previousRunId: "    " }),
      () => ({ previousRunId: 9999 }),
      () => ({ previousRunId: {} }),
      () => ({ previousRunId: [] }),
      () => ({ previousRunId: runActive.runId }),
      () => ({ previousRunId: suite3Armed.runId }),
      () => ({ previousRunId: "ext-nonexistent-" + crypto.randomUUID() }),
      () => ({ previousRunId: "../../etc/passwd" }),
      () => ({ previousRunId: "__proto__" })
    ];

    for (let i = 0; i < 50; i++) {
      const gen = failureGenerators[i % failureGenerators.length];
      const opt = gen();

      try {
        await service.handleControllerSession(
          initialNonce,
          { name: `fail-burst-${i}` },
          opt
        );
        assert.fail(`Request ${i} (type: ${JSON.stringify(opt)}) should have failed`);
      } catch (err) {
        if (err.name === "AssertionError" || err.code === "ERR_ASSERTION") throw err;
        assert.ok(err.status === 400 || err.status === 409, `Error status must be 400/409, got ${err.status}`);
      }

      // Assert nonce integrity after EACH failure
      assert.equal(service.mcpBootstrapNonce, initialNonce, `Nonce must not change on iteration ${i}`);
    }

    // Verify server.json was NOT rewritten during failures
    const currentServerJsonContent = fs.readFileSync(serverJsonPath, "utf8");
    const parsedServerJson = JSON.parse(currentServerJsonContent);
    assert.equal(parsedServerJson.mcp_bootstrap_nonce, initialNonce, "server.json nonce must remain untouched");
    assert.equal(service.controllerTokens.size, initialTokenCount, "No tokens should be allocated during failures");
    pass();

    // Now, after 50 failures, the 51st request with valid terminal previous_run_id MUST succeed with original nonce!
    console.log("Verifying 51st request succeeds with original unconsumed nonce...");
    const success51 = await service.handleControllerSession(
      initialNonce,
      { name: "ctrl-success-51" },
      { previousRunId: runWon.runId }
    );
    assert.ok(success51.controller_token, "Must obtain token on 51st request");
    assert.deepEqual(success51.previous_run, {
      run_id: runWon.runId,
      ended: true,
      status: "won"
    });
    assert.notEqual(service.mcpBootstrapNonce, initialNonce, "Nonce must rotate after valid 51st request");
    const rotatedNonce = service.mcpBootstrapNonce;
    pass();

    // Verify server.json now contains the newly rotated nonce
    const updatedServerJson = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
    assert.equal(updatedServerJson.mcp_bootstrap_nonce, rotatedNonce, "server.json must reflect rotated nonce");
    pass();

    // 52nd request: Retrying with the old initialNonce must now be rejected with 403 FORBIDDEN
    console.log("Verifying 52nd request with old nonce is rejected with 403 FORBIDDEN...");
    await assert.rejects(
      service.handleControllerSession(
        initialNonce,
        { name: "ctrl-stale-52" },
        { previousRunId: runWon.runId }
      ),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "FORBIDDEN");
        return true;
      },
      "Stale nonce must be rejected with 403 FORBIDDEN"
    );
    pass();

    // -------------------------------------------------------------------------
    // Suite 4: High Concurrency & Race Condition Stress
    // -------------------------------------------------------------------------
    console.log("\n--- [Suite 4] High Concurrency & Race Condition Stress ---");

    // 4.1: 20 concurrent requests with the SAME terminal previous_run_id and SAME nonce
    console.log("4.1: 20 concurrent requests with identical terminal previous_run_id and same nonce...");
    const currentNonce41 = service.mcpBootstrapNonce;
    const promises41 = Array.from({ length: 20 }, (_, idx) => {
      return service.handleControllerSession(
        currentNonce41,
        { name: `race-client-${idx}` },
        { previousRunId: runWon.runId }
      ).then(
        (res) => ({ success: true, res }),
        (err) => ({ success: false, err })
      );
    });

    const results41 = await Promise.all(promises41);
    const successes41 = results41.filter((r) => r.success);
    const failures41 = results41.filter((r) => !r.success);

    assert.equal(successes41.length, 1, `Exactly 1 request must win the nonce race, got ${successes41.length}`);
    assert.equal(failures41.length, 19, `Exactly 19 requests must fail, got ${failures41.length}`);
    for (const f of failures41) {
      assert.equal(f.err.status, 403, "All losing concurrent requests must get 403");
      assert.equal(f.err.code, "FORBIDDEN");
    }
    pass();

    // 4.2: 24 concurrent requests with MIXED previous_run_id inputs and SAME nonce
    console.log("4.2: 24 concurrent requests with mixed inputs (terminal, active, invalid, ghost)...");
    const currentNonce42 = service.mcpBootstrapNonce;
    const mixedInputs = [
      ...Array.from({ length: 6 }, () => ({ type: "terminal", opt: { previousRunId: runWon.runId } })),
      ...Array.from({ length: 6 }, () => ({ type: "active", opt: { previousRunId: runActive.runId } })),
      ...Array.from({ length: 6 }, () => ({ type: "invalid_arg", opt: { previousRunId: "   " } })),
      ...Array.from({ length: 6 }, () => ({ type: "ghost", opt: { previousRunId: "ext-ghost-" + crypto.randomUUID() } }))
    ];

    // Shuffle array
    for (let i = mixedInputs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mixedInputs[i], mixedInputs[j]] = [mixedInputs[j], mixedInputs[i]];
    }

    const promises42 = mixedInputs.map((input, idx) => {
      return service.handleControllerSession(
        currentNonce42,
        { name: `mixed-race-${idx}` },
        input.opt
      ).then(
        (res) => ({ success: true, inputType: input.type, res }),
        (err) => ({ success: false, inputType: input.type, err })
      );
    });

    const results42 = await Promise.all(promises42);
    const successes42 = results42.filter((r) => r.success);
    const failures42 = results42.filter((r) => !r.success);

    assert.equal(successes42.length, 1, `Exactly 1 valid terminal request must succeed, got ${successes42.length}`);
    assert.equal(successes42[0].inputType, "terminal", "The single winner MUST be of terminal type");

    // All active requests must fail with either 409 RUN_RESUME_REQUIRED or 403 FORBIDDEN
    const activeFailures = failures42.filter((r) => r.inputType === "active");
    for (const f of activeFailures) {
      assert.ok(
        (f.err.status === 409 && f.err.code === "RUN_RESUME_REQUIRED") ||
        (f.err.status === 403 && f.err.code === "FORBIDDEN"),
        `Active run must fail with 409 or 403, got ${f.err.status} ${f.err.code}`
      );
    }

    // All invalid argument requests must fail with 400 or 403
    const invalidFailures = failures42.filter((r) => r.inputType === "invalid_arg");
    for (const f of invalidFailures) {
      assert.ok(
        (f.err.status === 400 && f.err.code === "INVALID_ARGUMENT") ||
        (f.err.status === 403 && f.err.code === "FORBIDDEN"),
        `Invalid arg must fail with 400 or 403, got ${f.err.status} ${f.err.code}`
      );
    }

    // All ghost run requests must fail with 409 PREVIOUS_RUN_UNVERIFIED or 403
    const ghostFailures = failures42.filter((r) => r.inputType === "ghost");
    for (const f of ghostFailures) {
      assert.ok(
        (f.err.status === 409 && f.err.code === "PREVIOUS_RUN_UNVERIFIED") ||
        (f.err.status === 403 && f.err.code === "FORBIDDEN"),
        `Ghost run must fail with 409 or 403, got ${f.err.status} ${f.err.code}`
      );
    }
    pass();

    // 4.3: Concurrency between terminal reclaim and createResumeRequest
    console.log("4.3: Concurrency between terminal reclaim and createResumeRequest...");
    const ctrl43Applicant = await newController("ctrl43-applicant");
    const [reclaimResult, resumeResult] = await Promise.allSettled([
      service.handleControllerSession(
        service.mcpBootstrapNonce,
        { name: "ctrl43-reclaim" },
        { previousRunId: runWon.runId }
      ),
      service.createResumeRequest(ctrl43Applicant, runWon.runId)
    ]);

    assert.equal(reclaimResult.status, "fulfilled", "Terminal reclaim must succeed");
    assert.equal(resumeResult.status, "rejected", "Resume on terminal run must be rejected");
    assert.equal(resumeResult.reason?.status, 409);
    assert.equal(resumeResult.reason?.code, "RUN_ENDED");
    assert.equal(resumeResult.reason?.ended, true);
    pass();

    // -------------------------------------------------------------------------
    // Suite 5: Security & Isolation Verification (AGENTS.md Boundary)
    // -------------------------------------------------------------------------
    console.log("\n--- [Suite 5] AGENTS.md Security & Isolation Verification ---");

    // 1. Check previous_run fields
    const validSession = await service.handleControllerSession(
      service.mcpBootstrapNonce,
      { name: "ctrl-sec-inspect" },
      { previousRunId: runWon.runId }
    );
    const prevRunKeys = Object.keys(validSession.previous_run).sort();
    assert.deepEqual(
      prevRunKeys,
      ["ended", "run_id", "status"],
      "previous_run MUST only contain ended, run_id, status"
    );

    // Verify NO forbidden properties leaked
    const forbiddenProps = [
      "level", "map", "world", "world_bundle", "token", "secret", "lease",
      "observation", "viewer_key", "internal_state", "data_home", "sessionMutex"
    ];
    for (const prop of forbiddenProps) {
      assert.equal(validSession.previous_run[prop], undefined, `Must not leak ${prop}`);
      assert.equal(validSession[prop], undefined, `Root session must not leak ${prop}`);
    }
    pass();

    // 2. Verify error objects do not leak filesystem paths or stack traces in HTTP JSON
    const httpLeakCheck = await invokePost({
      mcp_bootstrap_nonce: service.mcpBootstrapNonce,
      clientInfo: { name: "leak-check" },
      previous_run_id: "/etc/passwd/../../secret"
    });
    assert.equal(httpLeakCheck.status, 409);
    const bodyStr = JSON.stringify(httpLeakCheck.body);
    assert.ok(!bodyStr.includes(testDataHome), "Error response must not leak testDataHome filesystem path");
    assert.ok(!bodyStr.includes("at AsyncMutex"), "Error response must not leak stack traces");
    pass();

    // -------------------------------------------------------------------------
    // Suite 6: Server Restart Persistence & Quarantine Invariants
    // -------------------------------------------------------------------------
    console.log("\n--- [Suite 6] Server Restart Persistence & Quarantine Invariants ---");

    // 1. Setup a persistent restart environment
    const restartDataHome = path.join(testDataHome, "restart-persistence-test");
    const serviceR1 = new ExternalPlayService({ dataHome: restartDataHome, port: 3051, defaultMaxActions: 10 });
    await serviceR1.initialize();

    const ctrlR1A = await (async () => {
      const s = await serviceR1.handleControllerSession(serviceR1.mcpBootstrapNonce, { name: "ctrl-r1-a" });
      return serviceR1.validateControllerToken("Bearer " + s.controller_token);
    })();
    const ctrlR1B = await (async () => {
      const s = await serviceR1.handleControllerSession(serviceR1.mcpBootstrapNonce, { name: "ctrl-r1-b" });
      return serviceR1.validateControllerToken("Bearer " + s.controller_token);
    })();

    // Run A: Successfully reaches "won"
    const runRA = await serviceR1.createRun({ maxActions: 10 });
    await serviceR1.claimRun(ctrlR1A, { model_name: "Model Restart Won" });
    await runRA._startFinalize("won", "Goal reached prior to restart");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(runRA.status, "won");

    // Run B: Remains active with long deadline
    const runRB = await serviceR1.createRun({ maxActions: 10, durationMs: 300000 });
    await serviceR1.claimRun(ctrlR1B, { model_name: "Model Restart Active" });
    assert.equal(runRB.status, "active");

    // Corrupt Run C directly on disk in runs directory to trigger quarantine during restart
    const corruptRunDir = path.join(restartDataHome, "runs", "ext-corrupted-run-c");
    fs.mkdirSync(corruptRunDir, { recursive: true });
    fs.writeFileSync(path.join(corruptRunDir, "manifest.json"), JSON.stringify({ run_id: "ext-corrupted-run-c", created_at: new Date().toISOString() }));
    fs.writeFileSync(path.join(corruptRunDir, "journal.jsonl"), "INVALID_JSON_CORRUPTED_LINE\n");

    // Gracefully shut down Service 1
    serviceR1.shutdown();

    // Start Service 2 from the exact same dataHome
    console.log("Starting Service 2 from persisted dataHome...");
    const serviceR2 = new ExternalPlayService({ dataHome: restartDataHome, port: 3051, defaultMaxActions: 10 });
    await serviceR2.initialize();

    try {
      // Assert Run A recovered as "won"
      const recoveredRA = serviceR2.getRun(runRA.runId);
      assert.ok(recoveredRA, "Run A must be recovered");
      assert.equal(recoveredRA.status, "won");

      // Assert Run B recovered as "active"
      const recoveredRB = serviceR2.getRun(runRB.runId);
      assert.ok(recoveredRB, "Run B must be recovered");
      assert.equal(recoveredRB.status, "active");

      // Assert Corrupt Run C was quarantined and is NOT in runs map
      assert.equal(serviceR2.getRun("ext-corrupted-run-c"), null, "Corrupt run must not be loaded into service runs");

      // 6.1: previous_run_id with recovered terminal run MUST succeed
      const nonceR2 = serviceR2.mcpBootstrapNonce;
      const resRecoveredRA = await serviceR2.handleControllerSession(
        nonceR2,
        { name: "ctrl-r2-reconnect" },
        { previousRunId: runRA.runId }
      );
      assert.ok(resRecoveredRA.controller_token);
      assert.deepEqual(resRecoveredRA.previous_run, {
        run_id: runRA.runId,
        ended: true,
        status: "won"
      });
      assert.notEqual(serviceR2.mcpBootstrapNonce, nonceR2, "Nonce must rotate on recovered terminal reclaim");
      pass();

      // 6.2: previous_run_id with recovered ACTIVE run MUST be rejected with 409 RUN_RESUME_REQUIRED
      const nonceR2Active = serviceR2.mcpBootstrapNonce;
      await assert.rejects(
        serviceR2.handleControllerSession(
          nonceR2Active,
          { name: "ctrl-r2-active-cheat" },
          { previousRunId: runRB.runId }
        ),
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, "RUN_RESUME_REQUIRED");
          assert.equal(err.run_id, runRB.runId);
          assert.equal(err.status_name, "active");
          return true;
        },
        "Active run after restart must reject reclaim and require resume"
      );
      assert.equal(serviceR2.mcpBootstrapNonce, nonceR2Active, "Nonce must NOT be consumed on active run reject");
      pass();

      // 6.3: previous_run_id with quarantined corrupt run MUST be rejected with 409 PREVIOUS_RUN_UNVERIFIED
      const nonceR2Quarantine = serviceR2.mcpBootstrapNonce;
      await assert.rejects(
        serviceR2.handleControllerSession(
          nonceR2Quarantine,
          { name: "ctrl-r2-quarantine-cheat" },
          { previousRunId: "ext-corrupted-run-c" }
        ),
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, "PREVIOUS_RUN_UNVERIFIED");
          assert.equal(err.run_id, "ext-corrupted-run-c");
          return true;
        },
        "Quarantined/unverified run after restart must reject reclaim"
      );
      assert.equal(serviceR2.mcpBootstrapNonce, nonceR2Quarantine, "Nonce must NOT be consumed on unverified reject");
      pass();
    } finally {
      serviceR2.shutdown();
    }

    console.log("\n================================================================================");
    console.log(`ALL ADVERSARIAL STRESS TESTS PASSED! (${totalAssertions} assertions checked)`);
    console.log("================================================================================\n");
  } finally {
    service.shutdown();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runAdversarialTerminalReclaimTests().catch((err) => {
    console.error("Adversarial test failed:", err);
    process.exit(1);
  });
}

module.exports = { runAdversarialTerminalReclaimTests };
