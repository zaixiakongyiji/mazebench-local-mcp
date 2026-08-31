const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const readline = require("node:readline");

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

  async sendContentLengthRequest(id, method, params = {}) {
    const req = { jsonrpc: "2.0", id, method, params };
    const body = JSON.stringify(req);
    const bodyBuf = Buffer.from(body, "utf8");
    const header = `Content-Length: ${bodyBuf.length}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(Buffer.concat([Buffer.from(header, "utf8"), bodyBuf]));
    });
  }

  sendNotification(method, params = {}) {
    const notif = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(JSON.stringify(notif) + "\n");
  }
}

async function runMcpTests() {
  console.log("Starting maze-external-mcp stdio adapter tests...");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-mcp-test-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;
  externalPlay.options.dataHome = testDataHome;

  // Start a local test server
  const server = http.createServer(createRequestHandler());
  const port = 38991;

  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", async () => {
      externalPlay.serverPort = port;
      await externalPlay.initialize();
      resolve();
    });
  });

  let child = null;

  try {
    // 1. Verify the legacy protocol remains compatible in a separate session.
    console.log("  [Test 1] Legacy protocol compatibility");
    const legacyChild = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: {
        ...process.env,
        MAZEBENCH_DATA_HOME: testDataHome
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    try {
      const legacyClient = new TestJsonRpcClient(legacyChild);
      const legacyInitRes = await legacyClient.sendRequest(1, "initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "legacy-test-client", version: "1.0.0" }
      });
      assert.equal(legacyInitRes.result?.protocolVersion, "2024-11-05");
    } finally {
      legacyChild.kill("SIGTERM");
    }

    // 2. Spawn the primary adapter and verify pre-init behavior.
    console.log("  [Test 2] Spawning adapter and verifying pre-init error");
    child = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: {
        ...process.env,
        MAZEBENCH_DATA_HOME: testDataHome
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stderrLogs = "";
    child.stderr.on("data", (d) => {
      stderrLogs += d.toString();
    });

    const client = new TestJsonRpcClient(child);

    // Calling tools before initialize must fail with -32002
    const preInitRes = await client.sendRequest(1, "tools/list", {});
    assert.ok(preInitRes.error);
    assert.equal(preInitRes.error.code, -32002);
    assert.equal(preInitRes.error.message, "Server not initialized");

    // 3. Initialize with unsupported version
    console.log("  [Test 3] Initialize with unsupported version");
    const badInitRes = await client.sendRequest(2, "initialize", {
      protocolVersion: "1999-01-01"
    });
    assert.ok(badInitRes.error);
    assert.equal(badInitRes.error.code, -32602);

    // 4. Proper Initialize Handshake with the current Gemini protocol and
    // multibyte Unicode in the declared CLI.
    console.log("  [Test 4] Current initialize handshake and token exchange with Unicode declared CLI");
    const initRes = await client.sendContentLengthRequest(3, "initialize", {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "测试客户端-claude-desktop", version: "1.0.0" }
    });
    assert.ok(initRes.result);
    assert.equal(initRes.result.protocolVersion, "2025-11-25");
    assert.equal(initRes.result.serverInfo.name, "mazebench");
    assert.ok(initRes.result.capabilities.tools);

    client.sendNotification("notifications/initialized");

    // Ping
    const pingRes = await client.sendRequest(4, "ping", {});
    assert.ok(pingRes.result);

    // 5. Tools List verification
    console.log("  [Test 5] Tools list contains all 13 tools");
    const toolsRes = await client.sendRequest(5, "tools/list", {});
    assert.ok(toolsRes.result);
    assert.ok(Array.isArray(toolsRes.result.tools));
    assert.equal(toolsRes.result.tools.length, 13);

    const toolNames = toolsRes.result.tools.map((t) => t.name);
    const expected = [
      "start",
      "observe",
      "up",
      "down",
      "left",
      "right",
      "rotate_camera_up",
      "rotate_camera_down",
      "rotate_camera_left",
      "rotate_camera_right",
      "undo",
      "reset",
      "go_to_level"
    ];
    assert.deepEqual(toolNames.sort(), expected.sort());

    // 6. Unknown tool call
    console.log("  [Test 6] Unknown tool rejection");
    const badToolRes = await client.sendRequest(6, "tools/call", {
      name: "fly_to_moon",
      arguments: {}
    });
    assert.ok(badToolRes.error);
    assert.equal(badToolRes.error.code, -32602);

    // 7. Tool calling with Content-Length framing: start -> observe -> down -> rotate_camera_right
    console.log("  [Test 7] Tool calling workflow with Content-Length framing");
    const startCallRes = await client.sendContentLengthRequest(7, "tools/call", {
      name: "start",
      arguments: {}
    });
    assert.ok(startCallRes.result);
    assert.equal(startCallRes.result.isError, false);
    const startPayload = JSON.parse(startCallRes.result.content[0].text);
    assert.equal(startPayload.status, "active");
    assert.ok(startPayload.observation, "start must return observation");
    assert.ok(startPayload.observation.player, "start observation must include player");
    assert.ok(startPayload.observation.current_room, "start observation must include current_room");

    const obsCallRes = await client.sendRequest(8, "tools/call", {
      name: "observe",
      arguments: {}
    });
    assert.ok(obsCallRes.result);
    assert.equal(obsCallRes.result.isError, false);
    const obsPayload = JSON.parse(obsCallRes.result.content[0].text);
    assert.equal(obsPayload.status, "active");

    const downCallRes = await client.sendContentLengthRequest(9, "tools/call", {
      name: "down",
      arguments: {}
    });
    assert.ok(downCallRes.result);
    assert.equal(downCallRes.result.isError, false);
    const downPayload = JSON.parse(downCallRes.result.content[0].text);
    assert.ok(downPayload);

    // 8. Schema and pattern validation: go_to_level
    console.log("  [Test 8] Schema argument and pattern validation for go_to_level");
    const missingArgRes = await client.sendRequest(10, "tools/call", {
      name: "go_to_level",
      arguments: { x: "A" } // missing y
    });
    assert.ok(missingArgRes.error);
    assert.equal(missingArgRes.error.code, -32602);

    const badPatternRes = await client.sendRequest(11, "tools/call", {
      name: "go_to_level",
      arguments: { x: "123", y: "456" } // invalid non-letter
    });
    assert.ok(badPatternRes.error);
    assert.equal(badPatternRes.error.code, -32602);

    // 9. Additional property rejection on 0-arg tool
    console.log("  [Test 9] Additional property rejection");
    const extraPropRes = await client.sendRequest(12, "tools/call", {
      name: "up",
      arguments: { extra_illegal_arg: 123 }
    });
    assert.ok(extraPropRes.error);
    assert.equal(extraPropRes.error.code, -32602);

    // 10. Cancel notification handling
    console.log("  [Test 10] notifications/cancelled handling");
    client.sendNotification("notifications/cancelled", { requestId: 13 });
    const cancelRes = await client.sendRequest(13, "tools/call", {
      name: "down",
      arguments: {}
    });
    assert.ok(cancelRes.error);
    assert.equal(cancelRes.error.code, -32800);

    // Cancellation while an HTTP request is waiting for the run lock must
    // propagate to the server and prevent the pre-WAL action from committing.
    const activeRun = externalPlay.getRun(externalPlay.activeRunId);
    const unlockRun = await activeRun.sessionMutex.acquire();
    const actionSeqBeforeActiveCancel = activeRun.lastActionSeq;
    const activeCancelPromise = client.sendRequest(14, "tools/call", {
      name: "down",
      arguments: {}
    });
    const waitStartedAt = Date.now();
    while (activeRun.sessionMutex._queue.length === 0 && Date.now() - waitStartedAt < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(activeRun.sessionMutex._queue.length > 0, "active request must reach the server lock before cancellation");
    client.sendNotification("notifications/cancelled", { requestId: 14 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    unlockRun();

    const activeCancelRes = await activeCancelPromise;
    assert.equal(activeCancelRes.error?.code, -32800);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(activeRun.lastActionSeq, actionSeqBeforeActiveCancel, "cancelled pre-WAL action must not commit");

    // 11. Reconfigured run auto-recovery: cancel current run and create a new armed run
    console.log("  [Test 11] Reconfigured run auto-recovery on start");
    await activeRun._startFinalize("cancelled", "reconfigured_before_start");
    while (activeRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    const replacementRun = await externalPlay.createRun({ durationMs: 1800000 });
    assert.equal(externalPlay.activeRunId, replacementRun.runId);

    // Call start on MCP client without arguments; MCP should auto-sync and start the replacement run
    const reconfigStartRes = await client.sendRequest(15, "tools/call", {
      name: "start",
      arguments: {}
    });
    assert.ok(reconfigStartRes.result);
    assert.equal(reconfigStartRes.result.isError, false);
    const reconfigPayload = JSON.parse(reconfigStartRes.result.content[0].text);
    assert.equal(reconfigPayload.run_id, replacementRun.runId);
    assert.equal(reconfigPayload.status, "active");

    // 12. Explicit run_id argument support
    console.log("  [Test 12] Explicit run_id argument support for start");
    // Finalize replacement run
    await replacementRun._startFinalize("won", "test completed");
    while (replacementRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Create new armed run
    const explicitRun = await externalPlay.createRun({ durationMs: 1800000 });
    const explicitStartRes = await client.sendRequest(16, "tools/call", {
      name: "start",
      arguments: { run_id: explicitRun.runId }
    });
    assert.ok(explicitStartRes.result);
    assert.equal(explicitStartRes.result.isError, false);
    const explicitPayload = JSON.parse(explicitStartRes.result.content[0].text);
    assert.equal(explicitPayload.run_id, explicitRun.runId);
    assert.equal(explicitPayload.status, "active");

    // 13. Auto-creation of armed run when all runs are terminal
    console.log("  [Test 13] Auto-create armed run when starting on terminal state");
    await explicitRun._startFinalize("cancelled", "User requested manual cancellation");
    while (explicitRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    const autoCreateStartRes = await client.sendRequest(17, "tools/call", {
      name: "start",
      arguments: {}
    });
    assert.ok(autoCreateStartRes.result);
    assert.equal(autoCreateStartRes.result.isError, false);
    const autoCreatePayload = JSON.parse(autoCreateStartRes.result.content[0].text);
    assert.ok(autoCreatePayload.run_id);
    assert.notEqual(autoCreatePayload.run_id, explicitRun.runId);
    assert.equal(autoCreatePayload.status, "active");

    console.log("All maze-external-mcp stdio adapter tests PASSED!");
  } finally {
    if (child) {
      child.kill("SIGTERM");
    }
    externalPlay.shutdown();
    server.close();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runMcpTests().catch((err) => {
    console.error("MCP test failed:", err);
    process.exit(1);
  });
}

module.exports = { runMcpTests };
