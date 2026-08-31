const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  ExternalPlayService,
  SummaryBuilder,
  assertSummaryInvariants,
  resolveDataHome,
  assertIsolation
} = require("../server/external-play");
const { createRequestRouter } = require("../server/router");

async function runAdversarialTests() {
  console.log("================================================================================");
  console.log("Starting Milestone 1 (External Play Local Auth) Adversarial Challenge Suite...");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-adversarial-test-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  let passedAssertions = 0;
  function pass() {
    passedAssertions++;
  }

  try {
    const service = new ExternalPlayService({ dataHome: testDataHome, port: 3000 });
    await service.initialize();

    // Helper router invoker
    const sendJson = (response, status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const sendHtml = (response, status, payload) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end(String(payload || ""));
    };
    const sendFile = (request, response, filePath, contentType) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(fs.readFileSync(filePath));
    };
    const sendRedirect = (response, location, status = 302) => {
      response.writeHead(status, { location });
      response.end();
    };

    const router = createRequestRouter({
      externalPlay: service,
      publicFileRoutes: new Map(),
      readJsonBody: async (req) => {
        return req.__body || {};
      },
      renderExternalPlayLandingPage: () => "<html>landing</html>",
      renderExternalPlayRunPage: () => "<html>run</html>",
      renderNotFound: () => "not found",
      sendHtml,
      sendJson,
      sendFile,
      sendRedirect
    });

    const invoke = async ({
      headers = {},
      method = "GET",
      remoteAddress = "127.0.0.1",
      url,
      body = null
    }) => {
      const result = { body: "", headers: {}, status: 0 };
      const response = {
        end(chunk = "") {
          result.body += String(chunk || "");
        },
        write(chunk = "") {
          result.body += String(chunk || "");
        },
        writeHead(status, responseHeaders = {}) {
          result.status = status;
          result.headers = responseHeaders;
        },
        setHeader(name, val) {
          result.headers[name.toLowerCase()] = val;
        }
      };

      const parsedUrl = new URL(url, `http://${headers.host || "127.0.0.1:3000"}`);
      const reqHeaders = {
        host: "127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
        ...headers
      };

      const closeListeners = [];
      const req = {
        headers: reqHeaders,
        method,
        socket: { remoteAddress },
        url,
        __body: body,
        on: (ev, fn) => {
          if (ev === "close") closeListeners.push(fn);
        },
        once: (ev, fn) => {
          if (ev === "close") closeListeners.push(fn);
        },
        off: (ev, fn) => {
          const idx = closeListeners.indexOf(fn);
          if (idx >= 0) closeListeners.splice(idx, 1);
        }
      };

      await router.handleRequest(req, response);
      for (const fn of closeListeners) {
        try { fn(); } catch (_e) {}
      }
      return result;
    };

    // =========================================================================
    // Challenge Suite 1: Illegal duration_ms Edge Cases & Type Fuzzing
    // =========================================================================
    console.log("\n--- [Suite 1] Illegal duration_ms Parameter Validation ---");

    const illegalDurations = [
      0,
      -1,
      -1000,
      -60000,
      59999,
      59999.999,
      21600001,
      21600000.5,
      100000.5,
      NaN,
      Infinity,
      -Infinity,
      "300000",
      "60000",
      "0",
      "59999",
      "invalid_string",
      "",
      null,
      false,
      true,
      {},
      [],
      [60000],
      { duration_ms: 60000 }
    ];

    for (const badDuration of illegalDurations) {
      // 1.1 Service API level
      await assert.rejects(
        service.createRun({ durationMs: badDuration }),
        (err) => {
          assert.equal(err?.status, 400);
          assert.equal(err?.code, "INVALID_ARGUMENT");
          assert.match(err?.message, /duration_ms/);
          return true;
        },
        `Service createRun must reject duration_ms=${JSON.stringify(badDuration)} with 400 INVALID_ARGUMENT`
      );
      pass();

      // 1.2 HTTP Router level
      const res = await invoke({
        method: "POST",
        url: "/api/external-play/runs",
        headers: { "content-type": "application/json" },
        body: { duration_ms: badDuration }
      });
      assert.equal(
        res.status,
        400,
        `HTTP POST /runs must reject duration_ms=${JSON.stringify(badDuration)} with 400`
      );
      const parsedBody = JSON.parse(res.body);
      assert.equal(parsedBody.code, "INVALID_ARGUMENT");
      pass();
    }

    // Boundary exact valid durations
    console.log("  Verifying valid duration_ms boundary values (60000, 21600000)...");
    await new Promise((r) => setTimeout(r, 50));
    const minRun = await service.createRun({ durationMs: 60000 });
    assert.equal(minRun.durationMs, 60000);
    assert.equal(minRun.manifest.duration_ms, 60000);
    pass();

    await new Promise((r) => setTimeout(r, 50));
    const maxRun = await service.createRun({ durationMs: 21600000 });
    assert.equal(maxRun.durationMs, 21600000);
    assert.equal(maxRun.manifest.duration_ms, 21600000);
    pass();

    await new Promise((r) => setTimeout(r, 50));
    const httpMinRes = await invoke({
      method: "POST",
      url: "/api/external-play/runs",
      headers: { "content-type": "application/json" },
      body: { duration_ms: 60000 }
    });
    assert.equal(httpMinRes.status, 201);
    pass();

    await new Promise((r) => setTimeout(r, 50));
    const httpMaxRes = await invoke({
      method: "POST",
      url: "/api/external-play/runs",
      headers: { "content-type": "application/json" },
      body: { duration_ms: 21600000 }
    });
    assert.equal(httpMaxRes.status, 201);
    pass();

    // =========================================================================
    // Challenge Suite 2: Illegal win_threshold Edge Cases & Type Fuzzing
    // =========================================================================
    console.log("\n--- [Suite 2] Illegal win_threshold Parameter Validation ---");

    const illegalThresholds = [
      0,
      -1,
      -100,
      101,
      102,
      1000,
      0.5,
      1.5,
      10.5,
      99.9,
      NaN,
      Infinity,
      -Infinity,
      "10",
      "1",
      "100",
      "0",
      "101",
      "",
      "abc",
      null,
      false,
      true,
      {},
      []
    ];

    for (const badThreshold of illegalThresholds) {
      // 2.1 Service API level
      await assert.rejects(
        service.createRun({ winThreshold: badThreshold }),
        (err) => {
          assert.equal(err?.status, 400);
          assert.equal(err?.code, "INVALID_ARGUMENT");
          assert.match(err?.message, /win_threshold/);
          return true;
        },
        `Service createRun must reject win_threshold=${JSON.stringify(badThreshold)} with 400 INVALID_ARGUMENT`
      );
      pass();

      // 2.2 HTTP Router level
      const res = await invoke({
        method: "POST",
        url: "/api/external-play/runs",
        headers: { "content-type": "application/json" },
        body: { win_threshold: badThreshold }
      });
      assert.equal(
        res.status,
        400,
        `HTTP POST /runs must reject win_threshold=${JSON.stringify(badThreshold)} with 400`
      );
      const parsedBody = JSON.parse(res.body);
      assert.equal(parsedBody.code, "INVALID_ARGUMENT");
      pass();
    }

    // Boundary exact valid win thresholds
    console.log("  Verifying valid win_threshold boundary values (1, 100)...");
    await new Promise((r) => setTimeout(r, 50));
    const minWinRun = await service.createRun({ winThreshold: 1 });
    assert.equal(minWinRun.winThreshold, 1);
    assert.equal(minWinRun.manifest.win_threshold, 1);
    pass();

    await new Promise((r) => setTimeout(r, 50));
    const maxWinRun = await service.createRun({ winThreshold: 100 });
    assert.equal(maxWinRun.winThreshold, 100);
    assert.equal(maxWinRun.manifest.win_threshold, 100);
    pass();

    // =========================================================================
    // Challenge Suite 3: Viewer Token & Data Endpoints Security Bypass Attempts
    // =========================================================================
    console.log("\n--- [Suite 3] Viewer Token & Data Endpoints Authorization Integrity ---");

    // Set up active run with mock data files
    const targetRun = service.getRun(service.activeRunId);
    assert.ok(targetRun);
    const validViewerToken = service.generateViewerToken(targetRun.runId);

    // Create a dummy blob in targetRun.blobsDir
    const dummyBlobContent = JSON.stringify({ state: "test" });
    const dummyDigest = crypto.createHash("sha256").update(dummyBlobContent).digest("hex");
    fs.writeFileSync(path.join(targetRun.blobsDir, `${dummyDigest}.json`), dummyBlobContent, "utf8");

    // Create summary file for summary endpoint
    const dummySummary = SummaryBuilder.buildSummary(targetRun, "cancelled");
    fs.writeFileSync(targetRun.summaryPath, JSON.stringify(dummySummary), "utf8");

    // Generate tokens with different invalid properties
    const otherRunId = `ext-${crypto.randomUUID()}`;
    const tokenOtherRun = service.generateViewerToken(otherRunId); // Valid signature, wrong run_id

    // Token signed with foreign instance key
    const foreignKey = crypto.randomBytes(32);
    const foreignPayload = {
      sub: "viewer",
      run_id: targetRun.runId,
      instance_id: service.instanceId,
      exp: Date.now() + 3600000
    };
    const foreignBody = Buffer.from(JSON.stringify(foreignPayload)).toString("base64url");
    const foreignSig = crypto.createHmac("sha256", foreignKey).update(foreignBody).digest("base64url");
    const tokenForgedKey = `${foreignBody}.${foreignSig}`;

    // Token with foreign instance_id (signed with real key)
    const foreignInstancePayload = {
      sub: "viewer",
      run_id: targetRun.runId,
      instance_id: "srv-foreign-instance-id",
      exp: Date.now() + 3600000
    };
    const foreignInstanceBody = Buffer.from(JSON.stringify(foreignInstancePayload)).toString("base64url");
    const foreignInstanceSig = crypto.createHmac("sha256", service.viewerKey).update(foreignInstanceBody).digest("base64url");
    const tokenForeignInstance = `${foreignInstanceBody}.${foreignInstanceSig}`;

    // Expired token
    const expiredPayload = {
      sub: "viewer",
      run_id: targetRun.runId,
      instance_id: service.instanceId,
      exp: Date.now() - 10000 // Expired in past
    };
    const expiredBody = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
    const expiredSig = crypto.createHmac("sha256", service.viewerKey).update(expiredBody).digest("base64url");
    const tokenExpired = `${expiredBody}.${expiredSig}`;

    // Invalid subject token (sub !== "viewer")
    const badSubPayload = {
      sub: "admin",
      run_id: targetRun.runId,
      instance_id: service.instanceId,
      exp: Date.now() + 3600000
    };
    const badSubBody = Buffer.from(JSON.stringify(badSubPayload)).toString("base64url");
    const badSubSig = crypto.createHmac("sha256", service.viewerKey).update(badSubBody).digest("base64url");
    const tokenBadSub = `${badSubBody}.${badSubSig}`;

    // Malformed JSON payload token
    const malformedBody = Buffer.from("{malformed:json").toString("base64url");
    const malformedSig = crypto.createHmac("sha256", service.viewerKey).update(malformedBody).digest("base64url");
    const tokenMalformed = `${malformedBody}.${malformedSig}`;

    const invalidAuthHeaders = [
      {}, // No Authorization header
      { authorization: "" }, // Empty Authorization
      { authorization: "Bearer" }, // Empty Bearer
      { authorization: "Bearer " }, // Empty token
      { authorization: "Bearer invalid.token.with.bad.format" }, // Bad format
      { authorization: "Bearer onlyonepart" }, // Single part
      { authorization: "Bearer part1.part2.part3" }, // Three parts
      { authorization: `Bearer ${tokenForgedKey}` }, // Forged key signature
      { authorization: `Bearer ${tokenOtherRun}` }, // Cross-run reuse
      { authorization: `Bearer ${tokenForeignInstance}` }, // Cross-instance reuse
      { authorization: `Bearer ${tokenExpired}` }, // Expired
      { authorization: `Bearer ${tokenBadSub}` }, // Wrong subject
      { authorization: `Bearer ${tokenMalformed}` }, // Malformed JSON
    ];

    const dataEndpoints = [
      `/api/external-play/runs/${targetRun.runId}/snapshot`,
      `/api/external-play/runs/${targetRun.runId}/actions`,
      `/api/external-play/runs/${targetRun.runId}/events`,
      `/api/external-play/runs/${targetRun.runId}/blobs/${dummyDigest}`,
      `/api/external-play/runs/${targetRun.runId}/world-bundle`,
      `/api/external-play/runs/${targetRun.runId}/summary`
    ];

    for (const ep of dataEndpoints) {
      console.log(`  Testing endpoint authorization barrier: ${ep}`);

      // All invalid tokens must be strictly rejected with 401 UNAUTHORIZED
      for (const badHeader of invalidAuthHeaders) {
        const res = await invoke({
          method: "GET",
          url: ep,
          headers: badHeader
        });
        assert.equal(
          res.status,
          401,
          `Endpoint ${ep} with header ${JSON.stringify(badHeader)} must return 401 UNAUTHORIZED`
        );
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.code, "UNAUTHORIZED");
        pass();
      }

      // Valid viewer token must succeed (200 OK)
      const validRes = await invoke({
        method: "GET",
        url: ep,
        headers: { authorization: `Bearer ${validViewerToken}` }
      });
      assert.equal(
        validRes.status,
        200,
        `Endpoint ${ep} with valid viewer token must return 200 OK`
      );
      pass();
    }

    // =========================================================================
    // Challenge Suite 4: Network Isolation, Cross-Site Origin & Content-Type Guards
    // =========================================================================
    console.log("\n--- [Suite 4] Network Isolation, Cross-Site & Mutation Content-Type Security ---");

    // 4.1 Loopback Host Rejections
    const invalidHosts = [
      "evil.example:3000",
      "attacker.com",
      "192.168.1.100:3000",
      "0.0.0.0:3000",
      "[::]:3000",
      ""
    ];

    for (const badHost of invalidHosts) {
      const res = await invoke({
        method: "POST",
        url: "/api/external-play/runs",
        headers: {
          host: badHost,
          "content-type": "application/json"
        },
        body: { duration_ms: 60000 }
      });
      assert.equal(res.status, 403, `Host ${badHost} must be rejected with 403 Forbidden`);
      pass();
    }

    // 4.2 Non-Loopback Peer Rejections
    const invalidPeers = [
      "192.168.1.100",
      "8.8.8.8",
      "10.0.0.1",
      "::ffff:192.168.1.100",
      "::ffff:8.8.8.8",
      ""
    ];

    for (const badPeer of invalidPeers) {
      const res = await invoke({
        method: "POST",
        url: "/api/external-play/runs",
        remoteAddress: badPeer,
        headers: { "content-type": "application/json" },
        body: { duration_ms: 60000 }
      });
      assert.equal(res.status, 403, `Peer IP ${badPeer} must be rejected with 403 Forbidden`);
      pass();
    }

    // 4.3 Cross-Site Origin & Sec-Fetch-Site Rejections
    const crossSiteOrigins = [
      "https://attacker.example",
      "http://evil.com:3000",
      "http://localhost:8080",
      "null"
    ];

    for (const badOrigin of crossSiteOrigins) {
      const res = await invoke({
        method: "POST",
        url: "/api/external-play/runs",
        headers: {
          origin: badOrigin,
          "sec-fetch-site": "cross-site",
          "content-type": "application/json"
        },
        body: { duration_ms: 60000 }
      });
      assert.equal(res.status, 403, `Cross-site origin ${badOrigin} must be rejected with 403`);
      pass();
    }

    // Sec-Fetch-Site cross-site rejection even with valid host
    const crossFetchSiteRes = await invoke({
      method: "POST",
      url: "/api/external-play/runs",
      headers: {
        "sec-fetch-site": "cross-site",
        "content-type": "application/json"
      },
      body: { duration_ms: 60000 }
    });
    assert.equal(crossFetchSiteRes.status, 403);
    pass();

    // 4.4 Mutation Content-Type Rejections (415 Unsupported Media Type)
    const invalidContentTypes = [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=----WebKitFormBoundary",
      "application/javascript",
      "text/html",
      ""
    ];

    const mutationEndpoints = [
      { method: "POST", url: "/api/external-play/runs", body: { duration_ms: 60000 } },
      { method: "POST", url: `/api/external-play/runs/${targetRun.runId}/cancel`, body: {} },
      { method: "POST", url: `/api/external-play/runs/${targetRun.runId}/viewer-token`, body: {} },
      { method: "POST", url: "/api/external-play/controller/session", body: { mcp_bootstrap_nonce: "xyz" } }
    ];

    for (const { method, url, body } of mutationEndpoints) {
      for (const badCt of invalidContentTypes) {
        const res = await invoke({
          method,
          url,
          headers: { "content-type": badCt },
          body
        });
        assert.equal(
          res.status,
          415,
          `Mutation ${method} ${url} with Content-Type '${badCt}' must be rejected with 415`
        );
        pass();
      }
    }

    // =========================================================================
    // Challenge Suite 5: Armed Run Replacement, State Mutation & Concurrency
    // =========================================================================
    console.log("\n--- [Suite 5] Armed Run Replacement, State Mutation & Concurrency ---");

    // 5.1 Fresh service with armed run
    const lifecycleHome = path.join(testDataHome, "lifecycle");
    const lcService = new ExternalPlayService({ dataHome: lifecycleHome, port: 3009 });
    await lcService.initialize();

    try {
      const run1 = lcService.getRun(lcService.activeRunId);
      assert.equal(run1.status, "armed");

      // Replace unclaimed armed run with new duration_ms and win_threshold
      const run2 = await lcService.createRun({ durationMs: 120000, winThreshold: 20 });
      assert.notEqual(run1.runId, run2.runId);
      assert.equal(lcService.activeRunId, run2.runId);
      assert.equal(run2.durationMs, 120000);
      assert.equal(run2.winThreshold, 20);

      // Wait for run1 cleanup and cancellation
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(run1.status, "cancelled");
      assert.equal(run1.outcome, "cancelled");

      const run1Journal = fs.readFileSync(run1.journalPath, "utf8").trim().split("\n").map(JSON.parse);
      const finalizeIntent = run1Journal.find((r) => r.type === "finalize_intent");
      assert.ok(finalizeIntent);
      assert.equal(finalizeIntent.reason, "reconfigured_before_start");

      // 5.2 Start run2 with MCP controller
      const mcpSession = await lcService.handleControllerSession(lcService.mcpBootstrapNonce, { name: "mcp-ctrl" });
      const ctrl = lcService.validateControllerToken(`Bearer ${mcpSession.controller_token}`);
      assert.ok(ctrl);

      const startRes = await run2.startOrAttach(ctrl, "op-start");
      assert.equal(startRes.status, "active");
      assert.equal(run2.status, "active");

      // 5.3 Attempting to create run while active must fail with 409
      await assert.rejects(
        lcService.createRun({ durationMs: 60000 }),
        (err) => err?.status === 409 && (err?.code === "RUN_ACTIVE" || err?.code === "CONFLICT"),
        "createRun while run is active must be rejected with 409"
      );
      pass();

      // 5.4 Concurrent claim and replacement race condition
      console.log("  Testing concurrent claim vs createRun race condition...");
      const raceHome = path.join(testDataHome, "race");
      const raceServ = new ExternalPlayService({ dataHome: raceHome, port: 3010 });
      await raceServ.initialize();

      try {
        const raceRun = raceServ.getRun(raceServ.activeRunId);
        const raceCtrlSession = await raceServ.handleControllerSession(raceServ.mcpBootstrapNonce, { name: "race-ctrl" });
        const raceCtrl = raceServ.validateControllerToken(`Bearer ${raceCtrlSession.controller_token}`);

        // Launch claim and createRun concurrently
        const [claimOutcome, createOutcome] = await Promise.allSettled([
          raceRun.startOrAttach(raceCtrl, "race-start-op"),
          raceServ.createRun({ durationMs: 180000 })
        ]);

        // Exactly one must succeed, and the other must be rejected cleanly with 409 (or both handled safely)
        const claimSuccess = claimOutcome.status === "fulfilled";
        const createSuccess = createOutcome.status === "fulfilled";

        console.log(`    Race result: claimSuccess=${claimSuccess}, createSuccess=${createSuccess}`);
        assert.ok(
          (claimSuccess && !createSuccess) || (!claimSuccess && createSuccess),
          "Exactly one operation must win the mutex race"
        );

        if (claimSuccess) {
          assert.equal(createOutcome.reason?.status, 409);
        } else {
          assert.equal(claimOutcome.reason?.status, 409);
        }
        pass();
      } finally {
        raceServ.shutdown();
      }

      // 5.5 Finalize run2 and verify creation after terminal state
      await run2._startFinalize("won", "Gems collected");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(run2.status, "won");

      const run3 = await lcService.createRun({ durationMs: 300000, winThreshold: 15 });
      assert.ok(run3);
      assert.equal(run3.status, "armed");
      assert.equal(lcService.activeRunId, run3.runId);
      pass();
    } finally {
      lcService.shutdown();
    }

    service.shutdown();

    console.log("\n================================================================================");
    console.log(`All Milestone 1 Adversarial Challenges PASSED! Total assertions: ${passedAssertions}`);
    console.log("================================================================================\n");

  } finally {
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runAdversarialTests().catch((err) => {
    console.error("Adversarial test failure:", err);
    process.exit(1);
  });
}

module.exports = { runAdversarialTests };
