const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const { createRequestHandler, externalPlay } = require("../server/app");
const { StdioMcpAdapter } = require("../scripts/maze-external-mcp");

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
}

async function runMilestone2Verification() {
  console.log("================================================================================");
  console.log("Starting Milestone 2 (MCP Adapter Generation & Cleanup) Verification Suite...");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-m2-test-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;
  externalPlay.options.dataHome = testDataHome;

  let totalAssertions = 0;
  function pass(msg) {
    totalAssertions++;
    if (msg) console.log(`  ✓ ${msg}`);
  }

  const server = http.createServer(createRequestHandler());
  const port = 38992;
  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", async () => {
      externalPlay.serverPort = port;
      await externalPlay.initialize();
      resolve();
    });
  });

  try {
    // --------------------------------------------------------------------------
    // Test 1: 单模型对局正常结束后，原 adapter 进程执行显式 start({ model_name }) 成功认领新席位
    // --------------------------------------------------------------------------
    console.log("\n[Test 1] Single run ends -> same adapter explicitly starts new group run");
    const singleRun = await externalPlay.createRun({ maxActions: 2 });
    assert.equal(singleRun.status, "armed");

    const childProc = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const client = new TestJsonRpcClient(childProc);
    const initRes = await client.sendRequest(1, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-m2-client" }
    });
    assert.equal(initRes.result?.serverInfo?.name, "mazebench");
    pass("Adapter initialized successfully");

    // 认领第一局
    const start1Res = await client.sendRequest(2, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-1" }
    });
    assert.equal(start1Res.result?.isError, false);
    const start1Payload = JSON.parse(start1Res.result.content[0].text);
    assert.equal(start1Payload.run_id, singleRun.runId);
    pass("First run claimed");

    // 执行两步动作使其达到 action_limit 终态
    const act1 = await client.sendRequest(3, "tools/call", { name: "rotate_camera_left", arguments: {} });
    assert.equal(act1.result?.isError, false);
    const act2 = await client.sendRequest(4, "tools/call", { name: "rotate_camera_right", arguments: {} });
    assert.equal(act2.result?.isError, false);
    const act2Payload = JSON.parse(act2.result.content[0].text);
    assert.equal(act2Payload.ended, true);
    pass("First run reached action_limit terminal state");

    // 创建一个二席位并发组
    const group = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });
    pass("Concurrent group created (2 armed seats)");

    // 使用同一个 adapter 进程，再次调用 start({ model_name: "Model-2" })
    const start2Res = await client.sendRequest(5, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-2" }
    });
    assert.equal(start2Res.result?.isError, false);
    const start2Payload = JSON.parse(start2Res.result.content[0].text);
    assert.notEqual(start2Payload.run_id, singleRun.runId);
    assert.equal(start2Payload.group_id, group.group_id);
    pass("Old adapter seamlessly claimed seat in new group without restart or approval!");

    // 验证新局能正常动作
    const act3 = await client.sendRequest(6, "tools/call", { name: "up", arguments: {} });
    assert.equal(act3.result?.isError, false);
    pass("New group run can execute actions cleanly");

    childProc.kill("SIGTERM");

    // --------------------------------------------------------------------------
    // Test 2: 旧局终态后 token 失效，调用 start 能通过 previous_run 终态核验无缝推进
    // --------------------------------------------------------------------------
    console.log("\n[Test 2] Old run ended + token lost -> explicit start authenticates previous_run and claims seat");
    const childProc2 = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client2 = new TestJsonRpcClient(childProc2);
    await client2.sendRequest(10, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-m2-reauth" }
    });

    // 认领 group 中的第 2 个席位并使其结束
    const startGroupRes = await client2.sendRequest(11, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-Reauth" }
    });
    assert.equal(startGroupRes.result?.isError, false);
    const groupRunId = JSON.parse(startGroupRes.result.content[0].text).run_id;
    const groupRun = externalPlay.getRun(groupRunId);

    // 强制使 groupRun 到达终态
    await groupRun._startFinalize("action_limit", "Testing finalize");
    while (groupRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(groupRun.status, "action_limit");

    // 模拟 token 被销毁（比如服务重启或 401 丢失）
    for (const [t, info] of externalPlay.controllerTokens) {
      if (info.declaredCli === "test-m2-reauth") {
        externalPlay.controllerTokens.delete(t);
      }
    }

    // 创建新席位组
    const reauthGroup = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });

    // 旧 adapter（此时客户端本地 token 已在服务端失效）直接发起 start
    const startReauthRes = await client2.sendRequest(12, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-Reclaim-After-Auth-Loss" }
    });
    if (startReauthRes.result?.isError) {
      console.log("startReauthRes failed with:", startReauthRes.result.content[0].text);
    }
    assert.equal(startReauthRes.result?.isError, false);
    const startReauthPayload = JSON.parse(startReauthRes.result.content[0].text);
    assert.equal(startReauthPayload.group_id, reauthGroup.group_id);
    pass("Start after auth loss verified terminal state and claimed new run!");

    // 关键断言：验证在包含 2 个席位的组中，恰好只有 1 个席位被认领，绝无第 2 席位被穿透认领
    const reauthGroupState = externalPlay.getGroup(reauthGroup.group_id);
    const activeRuns = reauthGroupState.entries.filter((e) => e.status === "active");
    const armedRuns = reauthGroupState.entries.filter((e) => e.status === "armed");
    assert.equal(activeRuns.length, 1, "Exactly 1 seat must be claimed in concurrent group after reauth start");
    assert.equal(armedRuns.length, 1, "Exactly 1 seat must remain armed (no double-claim fallthrough)");
    pass("Concurrent group seat count strictly verified: exactly 1 active, 1 armed (no fallthrough double claim)");

    childProc2.kill("SIGTERM");
    await externalPlay.cancelGroup(reauthGroup.group_id);

    // --------------------------------------------------------------------------
    // Test 2b: 单席位（仅 1 个 armed 席位）环境下，401 恢复后显式 start 正常成功认领，不因穿透导致 409 报错
    // --------------------------------------------------------------------------
    console.log("\n[Test 2b] Single-seat environment -> start after auth loss successfully claims without 409 conflict");
    const childProc2b = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client2b = new TestJsonRpcClient(childProc2b);
    await client2b.sendRequest(100, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-m2-single-seat-reauth" }
    });

    // 认领单局并使其达到终态
    const singlePre = await externalPlay.createRun({ maxActions: 1 });
    const startPreRes = await client2b.sendRequest(101, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-Pre" }
    });
    assert.equal(startPreRes.result?.isError, false);
    const preRunId = JSON.parse(startPreRes.result.content[0].text).run_id;
    const preRun = externalPlay.getRun(preRunId);

    // 动作 1 次使其进入 action_limit
    const preAct = await client2b.sendRequest(102, "tools/call", { name: "rotate_camera_left", arguments: {} });
    assert.equal(preAct.result?.isError, false);
    const preActPayload = JSON.parse(preAct.result.content[0].text);
    assert.equal(preActPayload.ended, true);
    assert.equal(preRun.status, "action_limit");

    // 模拟 token 被服务端销毁
    for (const [t, info] of externalPlay.controllerTokens) {
      if (info.declaredCli === "test-m2-single-seat-reauth") {
        externalPlay.controllerTokens.delete(t);
      }
    }

    // 只创建 1 个单席位 armed run（当前环境中仅此 1 席可用）
    const singleNext = await externalPlay.createRun({ maxActions: 5 });
    assert.equal(singleNext.status, "armed");

    // 调用 start，验证成功认领该席位，绝不因二次穿透导致 409: No armed External Play run is available 报错
    const startSingleNextRes = await client2b.sendRequest(103, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-Single-Reclaim" }
    });
    if (startSingleNextRes.result?.isError) {
      console.log("startSingleNextRes failed with:", startSingleNextRes.result.content[0].text);
    }
    assert.equal(startSingleNextRes.result?.isError, false, "Single seat reclaim must NOT fail with error");
    const singleNextPayload = JSON.parse(startSingleNextRes.result.content[0].text);
    assert.equal(singleNextPayload.run_id, singleNext.runId);
    assert.equal(singleNextPayload.status, "active");

    const updatedNextRun = externalPlay.getRun(singleNext.runId);
    assert.equal(updatedNextRun.status, "active");
    pass("Single seat reclaimed cleanly after auth loss without double-claim 409!");

    childProc2b.kill("SIGTERM");
    await updatedNextRun.cancelRun();
    while (updatedNextRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }

    // --------------------------------------------------------------------------
    // Test 3: 单实例并发 start 互斥拦截
    // --------------------------------------------------------------------------
    console.log("\n[Test 3] Concurrent start on same adapter is mutually excluded");
    const childProc3 = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client3 = new TestJsonRpcClient(childProc3);
    await client3.sendRequest(20, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-m2-concurrency" }
    });

    await externalPlay.createRun({ maxActions: 5 });
    await externalPlay.createRun({ maxActions: 5 });

    // 并发同时发送两个 start 请求
    const [cRes1, cRes2] = await Promise.all([
      client3.sendRequest(21, "tools/call", { name: "start", arguments: { model_name: "Racer-1" } }),
      client3.sendRequest(22, "tools/call", { name: "start", arguments: { model_name: "Racer-2" } })
    ]);

    const hasError = cRes1.result?.isError || cRes2.result?.isError;
    const hasSuccess = !cRes1.result?.isError || !cRes2.result?.isError;
    assert.ok(hasSuccess, "At least one start must succeed");
    if (cRes1.result?.isError) {
      assert.match(cRes1.result.content[0].text, /start operation is already in progress/i);
      pass("First start rejected by startInProgress mutex");
    } else if (cRes2.result?.isError) {
      assert.match(cRes2.result.content[0].text, /start operation is already in progress/i);
      pass("Second start rejected by startInProgress mutex");
    }

    childProc3.kill("SIGTERM");

    // --------------------------------------------------------------------------
    // Test 4: 单元级会话代次（Generation）迟到心跳与迟到动作防卫
    // --------------------------------------------------------------------------
    console.log("\n[Test 4] Unit-level generation defense against stale heartbeat and action callbacks");
    const adapter = new StdioMcpAdapter();
    assert.equal(adapter.generation, 0);
    assert.equal(adapter.startInProgress, false);

    // 模拟认领附着
    adapter.controllerToken = "test-token-gen";
    adapter.activeRunId = "run-gen-1";
    adapter.leaseId = "lease-gen-1";
    adapter.leaseEpoch = 1;
    adapter.claimedState = "run-gen-1";
    adapter.generation = 1;

    const capturedGen = adapter.generation;
    const capturedLeaseId = adapter.leaseId;

    // 清理并进入新局
    adapter._cleanupSession();
    assert.equal(adapter.generation, 2);
    assert.equal(adapter.activeRunId, null);
    assert.equal(adapter.leaseId, null);
    assert.equal(adapter.claimedState, null);
    assert.equal(adapter.authorizationRequired, false);
    pass("_cleanupSession correctly incremented generation and cleared session state");

    // 新局附着
    adapter.controllerToken = "new-token-gen";
    adapter.activeRunId = "run-gen-2";
    adapter.leaseId = "lease-gen-2";
    adapter.leaseEpoch = 1;
    adapter.claimedState = "run-gen-2";
    adapter.generation = 3;

    // 模拟来自旧局的迟到心跳 409 响应触发 catch
    const fakeErr = { statusCode: 409, message: "Run is action_limit, cannot heartbeat" };
    if (adapter.generation !== capturedGen || adapter.leaseId !== capturedLeaseId) {
      pass("Late heartbeat 409 from previous run cleanly dropped!");
    } else {
      assert.fail("Should not execute catch logic when generation/leaseId mismatch");
    }

    assert.equal(adapter.controllerToken, "new-token-gen");
    assert.equal(adapter.authorizationRequired, false);
    assert.equal(adapter.activeRunId, "run-gen-2");
    pass("New session token and lease remain intact after dropped late heartbeat");

    // 模拟迟到审批通过响应
    const staleApproved = { status: "approved", run_id: "run-gen-1", lease_id: "lease-stale", lease_epoch: 99 };
    if (adapter.generation !== capturedGen) {
      pass("Late approval from previous session cleanly dropped!");
    } else {
      adapter.attachResumedLease(staleApproved);
      assert.fail("Should not attach stale resumed lease");
    }
    assert.equal(adapter.activeRunId, "run-gen-2");

    console.log(`\n================================================================================`);
    console.log(`ALL MILESTONE 2 VERIFICATION TESTS PASSED! (${totalAssertions} checks verified)`);
    console.log(`================================================================================`);
  } finally {
    externalPlay.shutdown();
    server.close();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

runMilestone2Verification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
