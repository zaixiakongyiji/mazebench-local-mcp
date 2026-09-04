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
    assert.equal(externalPlay.activeRunId, null);
    assert.equal(externalPlay.runs.size, 0);
    const initialManualRun = await externalPlay.createRun();

    // 1. Verify Codex and legacy MCP protocol versions in separate sessions.
    console.log("  [Test 1] Codex and legacy protocol compatibility");
    for (const protocolVersion of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const compatibilityChild = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
        env: {
          ...process.env,
          MAZEBENCH_DATA_HOME: testDataHome
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      try {
        const compatibilityClient = new TestJsonRpcClient(compatibilityChild);
        const compatibilityInitRes = await compatibilityClient.sendRequest(1, "initialize", {
          protocolVersion,
          clientInfo: { name: "compatibility-test-client", version: "1.0.0" }
        });
        assert.equal(compatibilityInitRes.result?.protocolVersion, protocolVersion);
      } finally {
        compatibilityChild.kill("SIGTERM");
      }
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
    console.log("  [Test 5] Tools list contains all 14 tools");
    const toolsRes = await client.sendRequest(5, "tools/list", {});
    assert.ok(toolsRes.result);
    assert.ok(Array.isArray(toolsRes.result.tools));
    assert.equal(toolsRes.result.tools.length, 14);

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
      "go_to_level",
      "action_sequence"
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
      arguments: { model_name: "Test Model" }
    });
    assert.ok(startCallRes.result);
    assert.equal(startCallRes.result.isError, false);
    const startPayload = JSON.parse(startCallRes.result.content[0].text);
    assert.equal(startPayload.run_id, initialManualRun.runId);
    assert.equal(startPayload.status, "active");
    assert.equal(startPayload.ended, false);
    assert.equal(startPayload.max_actions, 256);
    assert.equal(startPayload.model_name, "Test Model");
    assert.equal(startPayload.harness, "测试客户端-claude-desktop");
    assert.match(startPayload.run_instructions, /action_sequence/);
    assert.equal(startPayload.instructions_version, "external-mcp-v1");
    assert.ok(startPayload.observation, "start must return observation");
    assert.ok(startPayload.observation.player, "start observation must include player");
    assert.ok(startPayload.observation.current_room, "start observation must include current_room");
    assert.ok(startPayload.observation.level, "start observation must include room ASCII map in level");

    const obsCallRes = await client.sendRequest(8, "tools/call", {
      name: "observe",
      arguments: {}
    });
    assert.ok(obsCallRes.result);
    assert.equal(obsCallRes.result.isError, false);
    const obsPayload = JSON.parse(obsCallRes.result.content[0].text);
    assert.equal(obsPayload.status, "active");
    assert.equal(obsPayload.ended, false);
    assert.ok(obsPayload.observation?.level, "observe observation must include room ASCII map in level");

    const downCallRes = await client.sendContentLengthRequest(9, "tools/call", {
      name: "down",
      arguments: {}
    });
    assert.ok(downCallRes.result);
    assert.equal(downCallRes.result.isError, false);
    const downPayload = JSON.parse(downCallRes.result.content[0].text);
    assert.ok(downPayload);
    assert.ok(downPayload.observation, "down response must include observation");
    assert.ok(downPayload.observation.level, "down observation must include room ASCII map in level");
    assert.ok(downPayload.observation.level.length > 1000, "level map must be full rendered ASCII grid (>1000 chars)");
    assert.equal(typeof downPayload.observation.current_room, "string");
    assert.equal(downPayload.ended, false);
    assert.equal(downPayload.observation.moved, true);
    assert.equal(downPayload.observation._transition_source, undefined, "internal transition source must not leak to AI");
    assert.equal(downPayload.observation.board_state_hash, undefined, "internal board state hash must not leak to AI");

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

    const badSequenceRes = await client.sendRequest(121, "tools/call", {
      name: "action_sequence",
      arguments: { actions: ["up", "fly"] }
    });
    assert.equal(badSequenceRes.error?.code, -32602);

    const sequenceRes = await client.sendRequest(122, "tools/call", {
      name: "action_sequence",
      arguments: { actions: ["rotate camera left", "rotate_camera_right"] }
    });
    assert.equal(sequenceRes.result?.isError, false);
    const sequencePayload = JSON.parse(sequenceRes.result.content[0].text);
    assert.equal(sequencePayload.requested_count, 2);
    assert.equal(sequencePayload.completed_count, 2);
    assert.equal(sequencePayload.ended, false);
    assert.ok(sequencePayload.final_observation?.level);

    const resumedStartRes = await client.sendRequest(123, "tools/call", {
      name: "start",
      arguments: {}
    });
    assert.equal(resumedStartRes.result?.isError, false);
    const resumedStartPayload = JSON.parse(resumedStartRes.result.content[0].text);
    assert.equal(resumedStartPayload.action_seq, externalPlay.getRun(startPayload.run_id).lastActionSeq);
    assert.equal(resumedStartPayload.actions_remaining, 256 - resumedStartPayload.action_seq);
    assert.equal(resumedStartPayload.game_won, false);
    assert.equal(resumedStartPayload.ended, false);

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
    const activeRun = externalPlay.getRun(startPayload.run_id);
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

    // 11. Reconfigured run sync: cancel current run and manually create a new armed run
    console.log("  [Test 11] Start syncs to a manually created replacement run");
    await activeRun._startFinalize("cancelled", "reconfigured_before_start");
    while (activeRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    const replacementRun = await externalPlay.createRun({ durationMs: 1800000 });
    assert.equal(externalPlay.activeRunId, replacementRun.runId);

    // Call start with a new model declaration; MCP should claim the replacement run.
    const reconfigStartRes = await client.sendRequest(15, "tools/call", {
      name: "start",
      arguments: { model_name: "Replacement Model" }
    });
    assert.ok(reconfigStartRes.result);
    assert.equal(reconfigStartRes.result.isError, false);
    const reconfigPayload = JSON.parse(reconfigStartRes.result.content[0].text);
    assert.equal(reconfigPayload.run_id, replacementRun.runId);
    assert.equal(reconfigPayload.status, "active");
    assert.equal(reconfigPayload.duration_ms, 1800000);
    assert.ok(reconfigPayload.deadline_at);
    assert.ok(reconfigPayload.time_remaining_ms > 0);
    assert.equal(reconfigPayload.max_actions, undefined);

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
      arguments: { run_id: explicitRun.runId, model_name: "Explicit Model" }
    });
    assert.ok(explicitStartRes.result);
    assert.equal(explicitStartRes.result.isError, false);
    const explicitPayload = JSON.parse(explicitStartRes.result.content[0].text);
    assert.equal(explicitPayload.run_id, explicitRun.runId);
    assert.equal(explicitPayload.status, "active");

    // 13. Starting without a manually created run must not add a record
    console.log("  [Test 13] Start stays idle when all runs are terminal");
    await explicitRun._startFinalize("cancelled", "User requested manual cancellation");
    while (explicitRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(externalPlay.activeRunId, null);
    const runCountBeforeRejectedStart = externalPlay.runs.size;
    externalPlay.defaultMaxActions = 2;
    const rejectedStartRes = await client.sendRequest(17, "tools/call", {
      name: "start",
      arguments: {}
    });
    assert.equal(rejectedStartRes.result?.isError, true);
    assert.match(rejectedStartRes.result.content[0].text, /No armed External Play run is available/);
    assert.equal(externalPlay.activeRunId, null);
    assert.equal(externalPlay.runs.size, runCountBeforeRejectedStart);

    // 14. action_sequence stops exactly at the run action limit and returns ended=true.
    console.log("  [Test 14] action_sequence stops at action limit with ended=true");
    const terminalSequenceRun = await externalPlay.createRun({ maxActions: 2 });
    const terminalSequenceStartRes = await client.sendRequest(18, "tools/call", {
      name: "start",
      arguments: { run_id: terminalSequenceRun.runId, model_name: "Sequence Model" }
    });
    assert.equal(terminalSequenceStartRes.result?.isError, false);
    const terminalSequenceRes = await client.sendRequest(19, "tools/call", {
      name: "action_sequence",
      arguments: { actions: ["rotate camera left", "rotate camera right", "down"] }
    });
    assert.equal(terminalSequenceRes.result?.isError, false);
    const terminalSequencePayload = JSON.parse(terminalSequenceRes.result.content[0].text);
    assert.equal(terminalSequencePayload.requested_count, 3);
    assert.equal(terminalSequencePayload.completed_count, 2);
    assert.equal(terminalSequencePayload.stopped_early, true);
    assert.equal(terminalSequencePayload.stop_reason, "action_limit");
    assert.equal(terminalSequencePayload.ended, true);
    assert.equal(terminalSequencePayload.steps.at(-1)?.action_seq, 2);

    // 15. 八个适配器并发初始化和认领时，start 必须复用 initialize 阶段的 controller token。
    console.log("  [Test 15] Eight concurrent adapters initialize and claim distinct group runs");
    const concurrentGroup = await externalPlay.createGroup({ mode: "concurrent", count: 8, maxActions: 1 });
    const controllerTokenCountBefore = externalPlay.controllerTokens.size;
    const concurrentChildren = Array.from({ length: 8 }, () => spawn(
      process.execPath,
      [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")],
      {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      }
    ));
    try {
      const concurrentClients = concurrentChildren.map((proc) => new TestJsonRpcClient(proc));
      const initializeResponses = await Promise.all(concurrentClients.map((concurrentClient, index) => (
        concurrentClient.sendRequest(200 + index, "initialize", {
          protocolVersion: "2025-06-18",
          clientInfo: { name: `concurrent-harness-${index + 1}`, version: "1.0.0" }
        })
      )));
      assert.ok(initializeResponses.every((response) => response.result?.serverInfo?.name === "mazebench"));

      const startResponses = await Promise.all(concurrentClients.map((concurrentClient, index) => (
        concurrentClient.sendRequest(300 + index, "tools/call", {
          name: "start",
          arguments: { model_name: `concurrent-model-${index + 1}` }
        })
      )));
      assert.ok(startResponses.every((response) => response.result?.isError === false));
      const concurrentPayloads = startResponses.map((response) => JSON.parse(response.result.content[0].text));
      assert.equal(new Set(concurrentPayloads.map((payload) => payload.run_id)).size, 8);
      assert.ok(concurrentPayloads.every((payload) => payload.group_id === concurrentGroup.group_id));
      assert.equal(
        externalPlay.controllerTokens.size - controllerTokenCountBefore,
        8,
        "start must reuse the controller token exchanged during initialize"
      );
    } finally {
      concurrentChildren.forEach((proc) => proc.kill("SIGTERM"));
    }

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
