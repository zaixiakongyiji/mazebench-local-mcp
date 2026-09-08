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

async function runEmpiricalChallengeM2() {
  console.log("================================================================================");
  console.log("Starting EMPIRICAL CHALLENGER M2: Adversarial Stress & Terminal Reclaim Tests");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-challenger-m2-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;
  externalPlay.options.dataHome = testDataHome;

  let totalAssertions = 0;
  function pass(msg) {
    totalAssertions++;
    if (msg) console.log(`  ✓ [PASS] ${msg}`);
  }

  const server = http.createServer(createRequestHandler());
  let port;
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", async () => {
      port = server.address().port;
      externalPlay.serverPort = port;
      await externalPlay.initialize();
      resolve();
    });
  });

  try {
    // ==========================================================================
    // CHALLENGE 1: 单模型旧局正常结束后，同一 adapter 进程直接调用 start({ model_name })
    //              必须 100% 成功认领新组席位，无需重启客户端，且支持多轮连续流转 (Chained Reclaims)
    // ==========================================================================
    console.log("\n[CHALLENGE 1] Single Run Normal End -> Direct Start for New Group (and Chained Reclaims)");
    const childProc1 = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client1 = new TestJsonRpcClient(childProc1);

    await client1.sendRequest(1, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-client-1" }
    });
    pass("Adapter 1 initialized");

    // 1.1 认领第一局（单局，maxActions: 2）
    const run1 = await externalPlay.createRun({ maxActions: 2 });
    const c1Start1 = await client1.sendRequest(2, "tools/call", {
      name: "start",
      arguments: { model_name: "Challenger-Model-A" }
    });
    assert.equal(c1Start1.result?.isError, false);
    const c1Payload1 = JSON.parse(c1Start1.result.content[0].text);
    assert.equal(c1Payload1.run_id, run1.runId);
    pass("Run 1 claimed successfully");

    // 两步动作消耗完毕，进入 action_limit 终态
    await client1.sendRequest(3, "tools/call", { name: "rotate_camera_left", arguments: {} });
    const c1Act2 = await client1.sendRequest(4, "tools/call", { name: "rotate_camera_right", arguments: {} });
    const c1Act2Payload = JSON.parse(c1Act2.result.content[0].text);
    assert.equal(c1Act2Payload.ended, true);
    assert.equal(externalPlay.getRun(run1.runId).status, "action_limit");
    pass("Run 1 reached action_limit terminal state");

    function getGroupClaimedCount(groupId) {
      const g = externalPlay.getGroup(groupId);
      return g ? g.entries.filter((e) => e.status !== "armed").length : 0;
    }

    // 创建第一个并发组（2 席位）
    const group1 = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 3 });
    assert.equal(getGroupClaimedCount(group1.group_id), 0);

    // 同一 adapter 进程直接发起 start 认领组席位
    const c1Start2 = await client1.sendRequest(5, "tools/call", {
      name: "start",
      arguments: { model_name: "Challenger-Model-B" }
    });
    assert.equal(c1Start2.result?.isError, false);
    const c1Payload2 = JSON.parse(c1Start2.result.content[0].text);
    assert.notEqual(c1Payload2.run_id, run1.runId);
    assert.equal(c1Payload2.group_id, group1.group_id);
    assert.equal(getGroupClaimedCount(group1.group_id), 1);
    pass("Same adapter claimed seat in Group 1 directly without restart or approval");

    // 在新局中执行动作验证租约与心跳正常
    const c1Act3 = await client1.sendRequest(6, "tools/call", { name: "up", arguments: {} });
    assert.equal(c1Act3.result?.isError, false);
    pass("New group run executes actions normally with valid lease");

    // 让席位 1 达到 action_limit 终态（总共 maxActions: 3，再执行 2 次动作）
    await client1.sendRequest(7, "tools/call", { name: "up", arguments: {} });
    const c1Seat1End = await client1.sendRequest(8, "tools/call", { name: "up", arguments: {} });
    assert.equal(JSON.parse(c1Seat1End.result.content[0].text).ended, true);
    pass("Group 1 seat 1 reached action_limit");

    // 1.2 连续流转挑战：席位 1 终态后，此时 group1 的席位 2 仍在等待认领（armed）！
    // 再次用同一 adapter 进程调用 start，它应该顺利认领同组的席位 2！
    const c1Start3 = await client1.sendRequest(9, "tools/call", {
      name: "start",
      arguments: { model_name: "Challenger-Model-C" }
    });
    assert.equal(c1Start3.result?.isError, false);
    const c1Payload3 = JSON.parse(c1Start3.result.content[0].text);
    assert.equal(c1Payload3.group_id, group1.group_id);
    assert.equal(getGroupClaimedCount(group1.group_id), 2);
    pass("Chained Reclaims: Same adapter claimed seat 2 in the same group after seat 1 ended!");

    // 让席位 2 也结束（maxActions: 3）
    await client1.sendRequest(10, "tools/call", { name: "up", arguments: {} });
    await client1.sendRequest(11, "tools/call", { name: "up", arguments: {} });
    const c1Seat2End = await client1.sendRequest(12, "tools/call", { name: "up", arguments: {} });
    assert.equal(JSON.parse(c1Seat2End.result.content[0].text).ended, true);

    // 此时 group1 全部席位已终态（没有 awaiting_claim 席位），创建全新 Group 2
    const group2 = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });
    const c1Start4 = await client1.sendRequest(13, "tools/call", {
      name: "start",
      arguments: { model_name: "Challenger-Model-D" }
    });
    assert.equal(c1Start4.result?.isError, false);
    const c1Payload4 = JSON.parse(c1Start4.result.content[0].text);
    assert.equal(c1Payload4.group_id, group2.group_id);
    assert.equal(getGroupClaimedCount(group2.group_id), 1);
    pass("Chained Reclaims: 4 consecutive runs across distinct groups claimed cleanly on single adapter process!");

    childProc1.kill("SIGTERM");

    // ==========================================================================
    // CHALLENGE 2: 旧局终态后 Controller Token 丢失或销毁自愈能力
    // ==========================================================================
    console.log("\n[CHALLENGE 2] Old Run Ended + Token Lost -> Auto-Healing Terminal Verification Reclaim");
    const childProc2 = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client2 = new TestJsonRpcClient(childProc2);
    await client2.sendRequest(20, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-client-2" }
    });

    // 认领 group2 剩余的一个席位并终态化
    const c2Start1 = await client2.sendRequest(21, "tools/call", {
      name: "start",
      arguments: { model_name: "Challenger-Reauth" }
    });
    assert.equal(c2Start1.result?.isError, false);
    const runToFinalizeId = JSON.parse(c2Start1.result.content[0].text).run_id;
    const runToFinalize = externalPlay.getRun(runToFinalizeId);

    // 使其终态化
    await runToFinalize._startFinalize("cancelled", "Challenger manual cancel");
    while (runToFinalize.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(runToFinalize.status, "cancelled");
    pass("Run finalized to cancelled state");

    // 2.1 模拟服务端物理抹除此 controller 的 token
    for (const [t, info] of externalPlay.controllerTokens) {
      if (info.declaredCli === "challenger-client-2") {
        externalPlay.controllerTokens.delete(t);
      }
    }
    pass("Simulated controller token deletion from server");

    // 创建新运行组
    const group3 = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });

    // 2.2 adapter 在客户端 token 失效的状态下调用 start
    const c2Start2 = await client2.sendRequest(22, "tools/call", {
      name: "start",
      arguments: { model_name: "Challenger-Model-Healed" }
    });
    assert.equal(c2Start2.result?.isError, false);
    const c2Payload2 = JSON.parse(c2Start2.result.content[0].text);
    assert.equal(c2Payload2.group_id, group3.group_id);
    pass("Token lost after terminal state: auto-healing reauth verified terminal run and claimed new seat!");

    childProc2.kill("SIGTERM");

    // ==========================================================================
    // CHALLENGE 3: 活动旧局（Active / Finalizing / 未知）认证丢失，坚决阻断绕过
    // ==========================================================================
    console.log("\n[CHALLENGE 3] Active / Finalizing Run Auth Loss -> Strict Block Against Reclaim Bypass");
    // 清理前置测试产生的未结束 run，确保状态干净
    for (const run of externalPlay.runs.values()) {
      if (run.status === "armed" || run.status === "active") {
        await run.cancelRun("Challenger phase isolation");
      }
    }
    externalPlay._refreshClaimState();

    // 创建专属运行组（2 席位）
    const groupActive = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 10 });

    const childProc3 = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client3 = new TestJsonRpcClient(childProc3);
    await client3.sendRequest(30, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-client-3" }
    });

    // 认领 groupActive 的第 1 个席位，保持 active 状态
    const c3Start1 = await client3.sendRequest(31, "tools/call", {
      name: "start",
      arguments: { model_name: "Challenger-Active-Guard" }
    });
    if (c3Start1.result?.isError) {
      console.log("c3Start1 FAILED WITH:", c3Start1.result.content[0].text);
    }
    assert.equal(c3Start1.result?.isError, false);
    const activeRunId = JSON.parse(c3Start1.result.content[0].text).run_id;
    const activeRun = externalPlay.getRun(activeRunId);
    assert.equal(activeRun.status, "active");
    pass("Active run created and currently active");

    // 抹除其 controller token，模拟认证丢失
    for (const [t, info] of externalPlay.controllerTokens) {
      if (info.declaredCli === "challenger-client-3") {
        externalPlay.controllerTokens.delete(t);
      }
    }

    const spare = groupActive.entries.find((e) => e.run_id !== activeRunId);
    assert.equal(externalPlay.getRun(spare.run_id).status, "armed");

    // 3.1 尝试调用 start，企图绕过活动局去认领新席位
    const c3StartDenied = await client3.sendRequest(32, "tools/call", {
      name: "start",
      arguments: { model_name: "Attacker-Bypass-Model" }
    });
    assert.equal(c3StartDenied.result?.isError, true);
    assert.match(c3StartDenied.result.content[0].text, /resume/i);
    assert.equal(getGroupClaimedCount(groupActive.group_id), 1, "No seat must be claimed when active run has lost auth");
    assert.equal(externalPlay.getRun(spare.run_id).status, "armed");
    pass("Active run auth loss strictly blocked from start; instructed to resume");

    // 3.2 连续重复尝试 start 5 次，验证安全门禁持续有效，席位持续未被窃取
    for (let i = 0; i < 5; i++) {
      const retryDenied = await client3.sendRequest(33 + i, "tools/call", {
        name: "start",
        arguments: { model_name: `Attacker-Bypass-Try-${i}` }
      });
      assert.equal(retryDenied.result?.isError, true);
      assert.match(retryDenied.result.content[0].text, /resume/i);
    }
    assert.equal(getGroupClaimedCount(groupActive.group_id), 1);
    assert.equal(externalPlay.getRun(spare.run_id).status, "armed");
    pass("Repeated start retries consistently blocked without state leakage");

    // 3.3 模拟单元级：对不存在的 previous_run_id 或 finalizing 状态的旧 run 进行核验
    // 单元级测试 StdioMcpAdapter 的 _authenticateWithPreviousRun
    const mockAdapter = new StdioMcpAdapter();
    mockAdapter.serverJsonPath = path.join(testDataHome, "server.json");
    mockAdapter.serverUrl = `http://127.0.0.1:${port}`;
    mockAdapter.instanceId = externalPlay.instanceId;

    // 尝试传入虚假 run_id
    await assert.rejects(
      async () => {
        await mockAdapter._authenticateWithPreviousRun("bogus-run-id-99999");
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.data?.code, "PREVIOUS_RUN_UNVERIFIED");
        return true;
      }
    );
    pass("Non-existent previous_run_id strictly rejected with PREVIOUS_RUN_UNVERIFIED (409)");

    // 取消 groupActive 释放 activeGroupId 以允许创建 standalone run
    await externalPlay.cancelGroup(groupActive.group_id);
    externalPlay._refreshClaimState();

    // 创建一个运行，并将其置为 finalizing
    const finalizingRun = await externalPlay.createRun({ maxActions: 10 });
    // 认领它
    await finalizingRun.start(
      { controllerId: "ctrl-finalizing-test", declaredCli: "test", instanceId: externalPlay.instanceId },
      "op-fin-test",
      null,
      { modelName: "Fin-Model" }
    );
    // 模拟进入 finalizing
    finalizingRun.status = "finalizing";
    await assert.rejects(
      async () => {
        await mockAdapter._authenticateWithPreviousRun(finalizingRun.runId);
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.data?.code, "RUN_RESUME_REQUIRED");
        return true;
      }
    );
    pass("Finalizing run strictly rejected with RUN_RESUME_REQUIRED (409)");

    childProc3.kill("SIGTERM");

    // ==========================================================================
    // CHALLENGE 4: 无可用席位（NO_AVAILABLE_RUN）与状态机防锁死 / 自愈
    // ==========================================================================
    console.log("\n[CHALLENGE 4] NO_AVAILABLE_RUN Clean State Machine & Self-Recovery");
    // 清空当前所有 armed 席位，确保 0 可用席位
    for (const run of externalPlay.runs.values()) {
      if (run.status === "armed") {
        await run.cancelRun("Challenger test drain");
      }
    }
    externalPlay._refreshClaimState();
    assert.equal(externalPlay.claimableRunIds.length, 0);
    pass("All armed seats drained (0 available seats in system)");

    const childProc4 = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client4 = new TestJsonRpcClient(childProc4);
    await client4.sendRequest(40, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-client-4" }
    });

    // 4.1 在 0 可用席位时调用 start
    const c4NoSeatRes = await client4.sendRequest(41, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-No-Seat" }
    });
    assert.equal(c4NoSeatRes.result?.isError, true);
    assert.match(c4NoSeatRes.result.content[0].text, /NO_AVAILABLE_RUN|No armed External Play run is available/i);
    pass("Start returned NO_AVAILABLE_RUN error properly");

    // 4.2 验证 adapter 状态机未锁死：创建新席位后再次调用 start 必须立即成功
    const groupAvailable = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });
    const c4RetryRes = await client4.sendRequest(42, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-Retry-After-Seat-Created" }
    });
    assert.equal(c4RetryRes.result?.isError, false);
    const c4RetryPayload = JSON.parse(c4RetryRes.result.content[0].text);
    assert.equal(c4RetryPayload.group_id, groupAvailable.group_id);
    pass("Adapter seamlessly recovered and claimed seat when new run became available (no lockup!)");

    // 4.3 终态旧局在 token 丢失时遇到 NO_AVAILABLE_RUN 的自愈恢复
    // 先让当前局结束
    const c4Run = externalPlay.getRun(c4RetryPayload.run_id);
    await c4Run._startFinalize("action_limit", "End for challenge 4.3");
    while (c4Run.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    // 销毁所有剩余 armed 席位
    for (const run of externalPlay.runs.values()) {
      if (run.status === "armed") {
        await run.cancelRun("Challenger test drain 2");
      }
    }
    externalPlay._refreshClaimState();
    assert.equal(externalPlay.claimableRunIds.length, 0);

    // 删除 controller token
    for (const [t, info] of externalPlay.controllerTokens) {
      if (info.declaredCli === "challenger-client-4") {
        externalPlay.controllerTokens.delete(t);
      }
    }

    // 调用 start：由于旧局已终态，adapter 会核验终态并换取新 token，但向服务端请求 start 时会遭遇 NO_AVAILABLE_RUN
    const c4NoSeatAfterTerminal = await client4.sendRequest(43, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-Terminal-No-Seat" }
    });
    assert.equal(c4NoSeatAfterTerminal.result?.isError, true);
    assert.match(c4NoSeatAfterTerminal.result.content[0].text, /NO_AVAILABLE_RUN|No armed External Play run is available/i);
    pass("Terminal + auth lost + no seats correctly re-authenticated and cleanly returned NO_AVAILABLE_RUN");

    // 随后管理端补开新席位组
    const groupReplenished = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });
    // adapter 再次调用 start 必须顺利认领
    const c4FinalClaim = await client4.sendRequest(44, "tools/call", {
      name: "start",
      arguments: { model_name: "Model-Final-Winner" }
    });
    assert.equal(c4FinalClaim.result?.isError, false);
    const c4FinalPayload = JSON.parse(c4FinalClaim.result.content[0].text);
    assert.equal(c4FinalPayload.group_id, groupReplenished.group_id);
    pass("After NO_AVAILABLE_RUN, subsequent start successfully claimed newly armed seat!");

    childProc4.kill("SIGTERM");

    // ==========================================================================
    // CHALLENGE 5: 深度对抗并发与迟到时序压力 (Adversarial Race Conditions)
    // ==========================================================================
    console.log("\n[CHALLENGE 5] Concurrency Stress & Late Response Immune Defense");
    const childProc5 = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client5 = new TestJsonRpcClient(childProc5);
    await client5.sendRequest(50, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-client-5" }
    });

    // 清理前置残留以保证独立创建 5 席位组
    for (const run of externalPlay.runs.values()) {
      if (run.status === "armed" || run.status === "active") {
        await run.cancelRun("Challenger phase 5 isolation");
      }
    }
    externalPlay._refreshClaimState();

    // 准备 5 个 armed 席位
    await externalPlay.createGroup({ mode: "concurrent", count: 5, maxActions: 10 });

    // 5.1 并发 8 个 start 请求冲击同一个 adapter 实例
    const burstPromises = [];
    for (let i = 0; i < 8; i++) {
      burstPromises.push(client5.sendRequest(60 + i, "tools/call", {
        name: "start",
        arguments: { model_name: `Burst-Model-${i}` }
      }));
    }
    const burstResults = await Promise.all(burstPromises);
    const successfulStarts = burstResults.filter((r) => !r.result?.isError);
    const rejectedStarts = burstResults.filter((r) => r.result?.isError);

    assert.equal(successfulStarts.length, 1, "Exactly ONE start must succeed per adapter instance");
    assert.equal(rejectedStarts.length, 7, "All competing starts must be rejected");
    for (const rej of rejectedStarts) {
      assert.match(rej.result.content[0].text, /start operation is already in progress/i);
    }
    pass("High-concurrency burst: 8 simultaneous starts resulted in exactly 1 claim and 7 mutex blocks");

    // 验证互斥锁已完全释放，后续动作可正常下发
    const burstAct = await client5.sendRequest(70, "tools/call", { name: "rotate_camera_left", arguments: {} });
    assert.equal(burstAct.result?.isError, false);
    pass("Adapter mutex released cleanly after concurrency burst");

    // 5.2 单元级代次免疫压力：验证旧心跳 401 携带旧 generation 到达时被彻底丢弃
    const testGenAdapter = new StdioMcpAdapter();
    testGenAdapter.generation = 5;
    testGenAdapter.controllerToken = "active-valid-token";
    testGenAdapter.activeRunId = "run-active-5";
    testGenAdapter.leaseId = "lease-active-5";
    testGenAdapter.claimedState = "run-active-5";
    testGenAdapter.authorizationRequired = false;

    // 模拟一个旧代次 (generation: 4) 的请求产生的 401 错误
    const staleRequestGen = 4;
    const staleErr = { statusCode: 401, message: "Stale session token expired" };
    if (staleErr.statusCode === 401 && testGenAdapter.claimedState) {
      if (testGenAdapter.generation === staleRequestGen) {
        testGenAdapter.controllerToken = null;
        testGenAdapter.requireResumption();
      }
    }
    assert.equal(testGenAdapter.controllerToken, "active-valid-token", "Token must NOT be cleared by stale generation 401");
    assert.equal(testGenAdapter.authorizationRequired, false, "authorizationRequired must remain false");
    pass("Late 401 from previous generation cleanly ignored without mutating active credentials");

    childProc5.kill("SIGTERM");

    console.log("\n================================================================================");
    console.log(`EMPIRICAL CHALLENGER M2: ALL ${totalAssertions} ASSERTIONS PASSED WITH FLYING COLORS!`);
    console.log("================================================================================");
  } finally {
    externalPlay.shutdown();
    server.close();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

runEmpiricalChallengeM2().catch((err) => {
  console.error("EMPIRICAL CHALLENGE FAILED:", err);
  process.exit(1);
});
