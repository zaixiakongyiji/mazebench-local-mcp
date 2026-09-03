const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const readline = require("node:readline");
const crypto = require("node:crypto");

const { createRequestHandler, externalPlay } = require("../server/app");

class TestJsonRpcClient {
  constructor(childProc) {
    this.child = childProc;
    this.pending = new Map();
    this.rl = readline.createInterface({
      input: childProc.stdout,
      terminal: false
    });

    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`Non-JSON stdout received from MCP adapter: "${trimmed}"`);
      }
      if (parsed.id !== undefined && this.pending.has(parsed.id)) {
        const { resolve } = this.pending.get(parsed.id);
        this.pending.delete(parsed.id);
        resolve(parsed);
      }
    });

    this.child.on("exit", (code) => {
      for (const [id, { reject }] of this.pending.entries()) {
        reject(new Error(`Child process exited with code ${code} while waiting for response to request ${id}`));
      }
      this.pending.clear();
    });
  }

  async sendRequest(id, method, params = {}) {
    const req = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async sendNotification(method, params = {}) {
    const notif = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(JSON.stringify(notif) + "\n");
  }
}

async function runBrowserTest() {
  console.log("Starting External Play Playwright E2E Browser Test...");

  let playwright;
  try {
    playwright = require("playwright-core");
  } catch (_e) {
    try {
      playwright = require("playwright");
    } catch (_e2) {
      if (process.env.CI) {
        throw new Error("Playwright is not installed in CI environment!");
      }
      console.log("Playwright is not installed in local environment, skipping browser test.");
      return;
    }
  }

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-browser-test-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;
  externalPlay.options.dataHome = testDataHome;

  const server = http.createServer(createRequestHandler());
  const port = 38992;

  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", async () => {
      externalPlay.serverPort = port;
      await externalPlay.initialize();
      resolve();
    });
  });

  let browser = null;
  let mcpProc = null;

  try {
    let executablePath = undefined;
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    try {
      browser = await playwright.chromium.launch({
        headless: true,
        executablePath
      });
    } catch (err) {
      if (process.env.CI) {
        throw new Error(`Chromium launch failed in CI: ${err.message}`);
      }
      console.log(`Chromium launch skipped (${err.message})`);
      return;
    }

    const context = await browser.newContext();
    assert.equal(externalPlay.activeRunId, null, "service startup must not create a run");
    const run = await externalPlay.createRun();
    const runId = run.runId;

    // 1. Launch stdio MCP client process and perform initial actions BEFORE browser opens
    console.log("  [Step 1] Launching stdio MCP adapter process and executing initial actions...");
    const mcpScriptPath = path.join(__dirname, "..", "scripts", "maze-external-mcp.js");
    mcpProc = spawn(process.execPath, [mcpScriptPath], {
      env: {
        ...process.env,
        MAZEBENCH_DATA_HOME: testDataHome,
        MAZEBENCH_EXTERNAL_PLAY_PORT: String(port)
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const mcpClient = new TestJsonRpcClient(mcpProc);

    // Initialize MCP handshake with token & declared CLI
    const initRes = await mcpClient.sendRequest(1, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "browser-test-cli", version: "1.0.0" }
    });
    assert.equal(initRes.result?.serverInfo?.name, "mazebench");

    // Call "start" tool
    const startToolRes = await mcpClient.sendRequest(2, "tools/call", {
      name: "start",
      arguments: {}
    });
    assert.equal(startToolRes.result?.isError, false);

    // Call 3 movement actions: down, right, left
    await mcpClient.sendRequest(3, "tools/call", { name: "down", arguments: {} });
    await mcpClient.sendRequest(4, "tools/call", { name: "right", arguments: {} });
    await mcpClient.sendRequest(5, "tools/call", { name: "left", arguments: {} });

    assert.equal(run.lastActionSeq, 3);
    assert.ok(fs.existsSync(run.actionsPath), "actions.jsonl must exist on disk");

    // 2. Spectator opens page (Late Join test)
    console.log("  [Step 2] Late spectator joins and performs historical action catch-up...");
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log("  [Spectator Page Error]:", err));
    page.on("console", (msg) => console.log("  [Spectator Page Console]:", msg.text()));

    const url = `http://127.0.0.1:${port}/external-play/${encodeURIComponent(runId)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Check Title & Canvas
    const title = await page.title();
    assert.ok(title.includes("External Play Spectator"), `Expected spectator title, got: ${title}`);

    const canvas = await page.$("#maze-canvas, canvas");
    assert.ok(canvas, "3D Spectator viewport canvas must be present in DOM");

    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 50 && box.height > 50, "Canvas should have non-zero layout dimensions");

    // Verify URL does not contain bootstrap_nonce
    await page.waitForTimeout(500);
    const currentUrl = page.url();
    assert.ok(!currentUrl.includes("bootstrap_nonce"), "Bootstrap nonce must not be in URL");

    // Wait for 3D Game Engine to initialize
    await page.waitForFunction(() => Boolean(window.__MAZEBENCH_APP__), { timeout: 10000 });

    const appState = await page.evaluate(() => {
      const app = window.__MAZEBENCH_APP__;
      if (!app) return null;
      return {
        levelId: app.currentLevelId,
        actorCount: app.state?.actors?.length || 0,
        hasRenderer: Boolean(app.renderer)
      };
    });
    assert.ok(appState, "MazeBench 3D game engine must be running on spectator page");
    assert.ok(appState.actorCount > 0, "Game engine must have actors initialized in state");

    // Verify Standalone Validators in browser
    const validatorsLoaded = await page.evaluate(() => {
      return Boolean(window.Validators && typeof window.Validators.validateViewerTransition === "function");
    });
    assert.ok(validatorsLoaded, "Standalone Schema Validator must be loaded on spectator page");

    // Wait for late catch-up to process all 3 historical actions
    await page.waitForFunction(() => document.getElementById("spectator-actions")?.textContent.includes("3"), { timeout: 5000 });
    let actionsText = await page.$eval("#spectator-actions", (el) => el.textContent);
    assert.ok(actionsText.includes("3"), `Spectator HUD should catch up to 3 actions, got: ${actionsText}`);

    // Verify Player Position matches authoritative viewer state
    const playerPos = await page.evaluate(() => {
      const app = window.__MAZEBENCH_APP__;
      const p = app.state?.actors?.find((a) => (typeof app.isMainPlayerActor === "function" ? app.isMainPlayerActor(a) : a.type === "player"));
      return p ? { x: p.x, y: p.y } : null;
    });
    assert.ok(playerPos, "Authoritative player actor must exist in 3D state");

    // Verify Camera Pitch mapping
    const cameraTilt = await page.evaluate(() => {
      const app = window.__MAZEBENCH_APP__;
      return typeof app.getSpectatorCameraTilt === "function" ? app.getSpectatorCameraTilt() : null;
    });
    assert.ok(cameraTilt !== null && Math.abs(cameraTilt - 0.22) < 0.05, `Camera tilt should match 0.22 rad, got ${cameraTilt}`);

    // 3. Verify Real WebGL Scene Pixels are Non-Zero
    console.log("  [Step 3] Verifying WebGL scene renders non-zero pixel buffer...");
    const pixelsRendered = await page.evaluate(() => {
      const app = window.__MAZEBENCH_APP__;
      if (!app) return false;
      if (typeof app.render === "function") app.render();
      const canvasEl = document.querySelector("#maze-canvas, canvas");
      if (!canvasEl) return false;
      const gl = canvasEl.getContext("webgl2") || canvasEl.getContext("webgl");
      if (!gl) return false;
      const sampleW = Math.min(canvasEl.width, 32);
      const sampleH = Math.min(canvasEl.height, 32);
      const pixels = new Uint8Array(sampleW * sampleH * 4);
      gl.readPixels(0, 0, sampleW, sampleH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return Array.from(pixels).some((byte) => byte > 0);
    });
    assert.ok(pixelsRendered, "WebGL canvas must contain rendered non-zero pixel data");

    // 4. Execute 4th and 5th actions live over stdio MCP -> HTTP -> SSE
    console.log("  [Step 4] Executing live actions via stdio MCP (up, rotate_camera_right)...");
    await mcpClient.sendRequest(6, "tools/call", { name: "up", arguments: {} });
    await mcpClient.sendRequest(7, "tools/call", { name: "rotate_camera_right", arguments: {} });
    await page.waitForFunction(() => document.getElementById("spectator-actions")?.textContent.includes("5"), { timeout: 5000 });
    actionsText = await page.$eval("#spectator-actions", (el) => el.textContent);
    assert.ok(actionsText.includes("5"), `Spectator HUD should update to 5 actions via SSE, got: ${actionsText}`);

    // Verify 3D Camera Yaw was updated
    const liveYaw = await page.evaluate(() => {
      const app = window.__MAZEBENCH_APP__;
      return typeof app.getSpectatorCameraYaw === "function" ? app.getSpectatorCameraYaw() : null;
    });
    assert.ok(liveYaw !== null && Math.abs(liveYaw - Math.PI / 2) < 0.1, `3D camera yaw should update to Math.PI/2, got ${liveYaw}`);

    // 5. Test Cross-Room Navigation (goto_level / SpectatorHost transition)
    console.log("  [Step 5] Executing cross-room transition via goto_level and SpectatorHost...");
    await mcpClient.sendRequest(8, "tools/call", { name: "go_to_level", arguments: { x: "H", y: "I" } });
    await page.waitForTimeout(800);

    const roomText = await page.$eval("#spectator-room", (el) => el.textContent);
    assert.ok(roomText.includes("level_HxI"), `Spectator HUD room should be level_HxI, got: ${roomText}`);

    // Verify 3D Host transition method switchPlayWorldLevel directly
    await page.evaluate(() => {
      window.__MAZEBENCH_SPECTATOR_HOST__.applySnapshot({ current_room: "level_HxH" });
    });
    await page.waitForTimeout(1200);

    const appRoom = await page.evaluate(() => window.__MAZEBENCH_APP__?.currentLevelId);
    assert.equal(appRoom, "level_HxH", `3D game engine currentLevelId should transition to level_HxH, got: ${appRoom}`);

    // 6. Cancel run and assert Summary Overlay is rendered
    console.log("  [Step 6] Cancelling run and validating summary modal...");
    await run.cancelRun();
    await page.waitForTimeout(800);

    const summaryVisible = await page.$eval("#summary-overlay", (el) => !el.hidden);
    assert.ok(summaryVisible, "Summary modal dialog should be visible after session ends");

    const summaryOutcome = await page.$eval("#summary-outcome", (el) => el.textContent);
    assert.equal(summaryOutcome.trim(), "CANCELLED");

    const summaryCli = await page.$eval("#summary-cli", (el) => el.textContent);
    assert.ok(summaryCli.includes("browser-test-cli"), `Expected declared_cli browser-test-cli, got: ${summaryCli}`);

    const homeBtnHref = await page.$eval("#summary-home-btn", (el) => el.getAttribute("href"));
    assert.equal(homeBtnHref, "/", "Summary modal must provide a link back to homepage");

    // 7. Test Terminal Spectator (Joining already finalized run with fast-forward)
    console.log("  [Step 7] Testing spectator joining an already finalized run...");
    const terminalPage = await context.newPage();
    terminalPage.on("pageerror", (err) => console.log("  [Terminal Page Error]:", err));
    terminalPage.on("console", (msg) => console.log("  [Terminal Page Console]:", msg.text()));
    await terminalPage.goto(`http://127.0.0.1:${port}/external-play/${encodeURIComponent(runId)}`, { waitUntil: "domcontentloaded" });
    await terminalPage.waitForFunction(() => !document.getElementById("summary-overlay")?.hidden, { timeout: 10000 });

    const terminalSummaryVisible = await terminalPage.$eval("#summary-overlay", (el) => !el.hidden);
    assert.ok(terminalSummaryVisible, "Terminal spectator must replay historical actions fast and show summary modal");

    const unauthenticatedSnapshot = await fetch(
      `http://127.0.0.1:${port}/api/external-play/runs/${encodeURIComponent(runId)}/snapshot`
    );
    assert.equal(
      unauthenticatedSnapshot.status,
      401,
      "terminal run data must still require a viewer token"
    );

    // 8. Test Blob Tampering, Missing Blob (404), and Schema Validation Rejection
    console.log("  [Step 8] Testing blob tampering, 404 missing blobs, and schema validator rejection...");
    const actionRecords = fs.readFileSync(run.actionsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const validTransition = actionRecords.find((record) => record.viewer_transition)?.viewer_transition;
    assert.ok(validTransition, "Browser test requires one valid inline transition as a tamper fixture");
    const validTransitionText = JSON.stringify(validTransition);
    const tamperedDigest = crypto.createHash("sha256").update(validTransitionText, "utf8").digest("hex");
    const tamperedTransition = {
      ...validTransition,
      duration_ms: validTransition.duration_ms + 1
    };
    fs.writeFileSync(
      path.join(run.blobsDir, `${tamperedDigest}.json`),
      JSON.stringify(tamperedTransition),
      "utf8"
    );

    const blobNegativeResults = await page.evaluate(async ({ testRunId, tamperedDigest: digest }) => {
      const results = {};

      // a) The real spectator fetch path must reject schema-valid bytes whose
      // content no longer matches their content-addressed filename.
      results.tamperedRejected = (await window.__MAZEBENCH_EXTERNAL_PLAY_DEBUG__
        .fetchAndVerifyBlob(digest, "transition")) === null;

      // b) Missing Blob 404 with Viewer Token
      const fakeDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const tokenRes = await fetch(`/api/external-play/runs/${encodeURIComponent(testRunId)}/viewer-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      const { viewer_token: testViewerToken } = await tokenRes.json();
      const missingRes = await fetch(`/api/external-play/runs/${encodeURIComponent(testRunId)}/blobs/${fakeDigest}`, {
        headers: { Authorization: `Bearer ${testViewerToken}` }
      });
      results.missingIs404 = missingRes.status === 404;

      // c) Schema Validator negative cases
      const V = window.Validators;
      if (V) {
        // Invalid transition: missing keyframes / invalid type
        const invalidTransition = { v: 1, type: "invalid_type", duration_ms: -5 };
        results.invalidTransitionRejected = V.validateViewerTransition(invalidTransition) === false;

        // Invalid viewer_state: missing required fields
        const invalidViewerState = { v: 2, current_room: 12345 };
        results.invalidViewerStateRejected = V.validateViewerState(invalidViewerState) === false;

        // Invalid summary: missing outcome
        const invalidSummary = { summary_schema_version: 1, run_id: "ext-invalid" };
        results.invalidSummaryRejected = V.validateSummary(invalidSummary) === false;
      }

      return results;
    }, { testRunId: runId, tamperedDigest });

    assert.equal(blobNegativeResults.tamperedRejected, true, "Spectator must reject a schema-valid blob with a mismatched digest");
    assert.equal(blobNegativeResults.missingIs404, true, "Missing blob must return HTTP 404");
    assert.equal(blobNegativeResults.invalidTransitionRejected, true, "Malformed viewer_transition must be rejected by validator");
    assert.equal(blobNegativeResults.invalidViewerStateRejected, true, "Malformed viewer_state must be rejected by validator");
    assert.equal(blobNegativeResults.invalidSummaryRejected, true, "Malformed summary must be rejected by validator");

    console.log("Playwright E2E browser test PASSED!");
  } finally {
    if (mcpProc) {
      mcpProc.kill("SIGTERM");
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    externalPlay.shutdown();
    server.close();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runBrowserTest().catch((err) => {
    console.error("Browser test failed:", err);
    process.exit(1);
  });
}

module.exports = { runBrowserTest };
