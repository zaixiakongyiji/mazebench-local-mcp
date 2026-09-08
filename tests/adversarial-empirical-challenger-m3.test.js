const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const { createRequestHandler, externalPlay } = require("../server/app");
const { StdioMcpAdapter } = require("../scripts/maze-external-mcp");
const { TERMINAL_STATUSES } = require("../server/external-run-groups");

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

  async stop() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runEmpiricalChallengeM3() {
  console.log("================================================================================");
  console.log("EMPIRICAL CHALLENGER M3: Deep Adversarial Race Condition & Stress Verification");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-challenger-m3-"));
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

  const adapterScript = path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js");

  function getGroupClaimedCount(groupId) {
    const g = externalPlay.getGroup(groupId);
    return g ? g.entries.filter((e) => e.status !== "armed").length : 0;
  }

  async function cancelAndDrainAll() {
    for (const group of externalPlay.groupStore.groups.values()) {
      if (group.status === "awaiting_claim" || group.status === "running") {
        await externalPlay.cancelGroup(group.group_id);
      }
    }
    for (const run of externalPlay.runs.values()) {
      if (run.status === "armed" || run.status === "active") {
        await run.cancelRun("drain");
      }
      while (run.status === "finalizing") {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    externalPlay._refreshClaimState();
  }

  try {
    // ==========================================================================
    // CHALLENGE 1: 单模型旧局达到 action_limit 终态后，原 adapter 进程显式 start
    //              100% 成功认领新席位（覆盖单步动作、action_sequence、连续链式流转、Token丢失自愈）
    // ==========================================================================
    console.log("\n[CHALLENGE 1] Terminal Run (action_limit) -> Explicit Start 100% Success Matrix");

    // --- 1.1 单步动作达到 action_limit，同进程显式 start 认领新并发组席位 ---
    console.log("  >>> Sub-challenge 1.1: Single step actions reach action_limit -> start claims group seat");
    const child1 = spawn(process.execPath, [adapterScript], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client1 = new TestJsonRpcClient(child1);
    await client1.sendRequest(100, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-m3-c1" }
    });

    const run1_1 = await externalPlay.createRun({ maxActions: 2 });
    const start1_1 = await client1.sendRequest(101, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-1.1" }
    });
    assert.equal(start1_1.result?.isError, false);
    assert.equal(JSON.parse(start1_1.result.content[0].text).run_id, run1_1.runId);

    // 执行两步使其达到 action_limit
    await client1.sendRequest(102, "tools/call", { name: "rotate_camera_left", arguments: {} });
    const act1_1b = await client1.sendRequest(103, "tools/call", { name: "rotate_camera_right", arguments: {} });
    const act1_1bPayload = JSON.parse(act1_1b.result.content[0].text);
    assert.equal(act1_1bPayload.ended, true);
    assert.equal(act1_1bPayload.actions_remaining, 0);

    while (run1_1.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(run1_1.status, "action_limit");
    pass("Run 1.1 reached terminal status 'action_limit'");

    // 创建一个包含 2 席位的并发组
    const group1_1 = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });
    assert.equal(getGroupClaimedCount(group1_1.group_id), 0);

    // 原 adapter 进程未重启，直接显式 start
    const start1_1New = await client1.sendRequest(104, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-1.1-Group" }
    });
    assert.equal(start1_1New.result?.isError, false, "Start must succeed 100% after action_limit");
    const start1_1NewPayload = JSON.parse(start1_1New.result.content[0].text);
    assert.notEqual(start1_1NewPayload.run_id, run1_1.runId);
    assert.equal(start1_1NewPayload.group_id, group1_1.group_id);
    assert.equal(start1_1NewPayload.status, "active");
    assert.equal(getGroupClaimedCount(group1_1.group_id), 1);
    pass("Sub-challenge 1.1 PASSED: Claimed new group seat cleanly after single-step action_limit");

    // --- 1.2 action_sequence 达到 action_limit 终态，显式 start 认领新席位 ---
    console.log("  >>> Sub-challenge 1.2: action_sequence reaches action_limit -> explicit start succeeds");
    // 在当前局使用 action_sequence 消耗完剩余动作（maxActions: 5，当前已用 0，直接打满 5 步）
    const seqRes = await client1.sendRequest(105, "tools/call", {
      name: "action_sequence",
      arguments: {
        actions: ["rotate_camera_left", "rotate_camera_left", "rotate_camera_left", "rotate_camera_left", "rotate_camera_left"]
      }
    });
    assert.equal(seqRes.result?.isError, false);
    const seqPayload = JSON.parse(seqRes.result.content[0].text);
    assert.equal(seqPayload.ended, true);
    assert.equal(seqPayload.stop_reason, "action_limit");

    const curRun = externalPlay.getRun(start1_1NewPayload.run_id);
    while (curRun.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(curRun.status, "action_limit");
    pass("Run reached action_limit via action_sequence");

    // 验证：当前 group1_1 还有一个 armed 席位，原 adapter 进程直接 start 认领同组席位 2！
    const start1_2InSameGroup = await client1.sendRequest(106, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-1.2-Sequence-Follower" }
    });
    assert.equal(start1_2InSameGroup.result?.isError, false, "Start must succeed after action_sequence action_limit");
    const start1_2Payload = JSON.parse(start1_2InSameGroup.result.content[0].text);
    assert.equal(start1_2Payload.group_id, group1_1.group_id);
    assert.equal(getGroupClaimedCount(group1_1.group_id), 2, "Group 1.1 must now have 2/2 seats claimed");
    pass("Sub-challenge 1.2 PASSED: Claimed seat 2 in same group after action_sequence terminal end");

    // 让席位 2 也进入终态，并完成清理
    const run1_2_seat = externalPlay.getRun(start1_2Payload.run_id);
    await run1_2_seat._startFinalize("action_limit", "End seat 2");
    while (run1_2_seat.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    await externalPlay.cancelGroup(group1_1.group_id);
    externalPlay._refreshClaimState();

    // 创建全新单席位 run 供 1.3 链式流转使用
    const run1_2 = await externalPlay.createRun({ maxActions: 3 });
    const startFor1_3 = await client1.sendRequest(107, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-1.3-Starter" }
    });
    assert.equal(startFor1_3.result?.isError, false);
    assert.equal(JSON.parse(startFor1_3.result.content[0].text).run_id, run1_2.runId);

    // --- 1.3 连续链式流转（Chained Reclaims across terminal statuses: action_limit -> won -> timed_out）---
    console.log("  >>> Sub-challenge 1.3: Chained reclaims across action_limit -> won -> timed_out");
    // 当前在 run1_2，使其正常获胜 won
    await run1_2._startFinalize("won", "Simulated win");
    while (run1_2.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(run1_2.status, "won");

    // 同 adapter 再次 start 认领下一局
    const run1_3_wonFollower = await externalPlay.createRun({ maxActions: 3 });
    const startAfterWon = await client1.sendRequest(108, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-WonFollower" }
    });
    assert.equal(startAfterWon.result?.isError, false);
    assert.equal(JSON.parse(startAfterWon.result.content[0].text).run_id, run1_3_wonFollower.runId);
    pass("Claimed run after won terminal status");

    // 使该局超时 timed_out
    await run1_3_wonFollower._startFinalize("timed_out", "Simulated timeout");
    while (run1_3_wonFollower.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(run1_3_wonFollower.status, "timed_out");

    // 同 adapter 再次 start 认领下一局
    const run1_3_timedOutFollower = await externalPlay.createRun({ maxActions: 3 });
    const startAfterTimeout = await client1.sendRequest(109, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-TimeoutFollower" }
    });
    assert.equal(startAfterTimeout.result?.isError, false);
    assert.equal(JSON.parse(startAfterTimeout.result.content[0].text).run_id, run1_3_timedOutFollower.runId);
    pass("Claimed run after timed_out terminal status");
    pass("Sub-challenge 1.3 PASSED: Chained reclaims across action_limit, won, and timed_out 100% robust");

    // --- 1.4 终态后 Token 丢失场景下的权威终态自愈核验 start ---
    console.log("  >>> Sub-challenge 1.4: Action limit + controller token destroyed -> terminal verification reauth start");
    // 使 run1_3_timedOutFollower 进入 action_limit 终态
    await run1_3_timedOutFollower._startFinalize("action_limit", "Simulated limit");
    while (run1_3_timedOutFollower.status === "finalizing") {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(run1_3_timedOutFollower.status, "action_limit");

    // 服务端抹除该 controller 的所有 token
    for (const [t, info] of externalPlay.controllerTokens) {
      if (info.declaredCli === "challenger-m3-c1") {
        externalPlay.controllerTokens.delete(t);
      }
    }

    const group1_4 = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });
    const start1_4Reauth = await client1.sendRequest(110, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-1.4-Reauth" }
    });
    assert.equal(start1_4Reauth.result?.isError, false, "Start must self-heal via previous_run check when token lost");
    const start1_4Payload = JSON.parse(start1_4Reauth.result.content[0].text);
    assert.equal(start1_4Payload.group_id, group1_4.group_id);
    assert.equal(start1_4Payload.review_url, undefined, "Must NOT require web approval for ended run");
    pass("Sub-challenge 1.4 PASSED: Successfully self-healed and claimed seat after token wipe");

    await client1.stop();
    await cancelAndDrainAll();

    // ==========================================================================
    // CHALLENGE 2: 当旧 run 仍处于 active、finalizing 或 lease expired 时，
    //              任何试图 start 的操作必须被坚决阻断，要求走 resume 流程
    // ==========================================================================
    console.log("\n[CHALLENGE 2] Strict Blocking of Start When Old Run is Active / Finalizing");

    const child2 = spawn(process.execPath, [adapterScript], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client2 = new TestJsonRpcClient(child2);
    await client2.sendRequest(200, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-m3-c2" }
    });

    // 准备一个 2 席位并发组
    const group2_1 = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 20 });
    const start2_1 = await client2.sendRequest(201, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Active-Guard-Model" }
    });
    assert.equal(start2_1.result?.isError, false);
    const activeRun2_1Id = JSON.parse(start2_1.result.content[0].text).run_id;
    const activeRun2_1 = externalPlay.getRun(activeRun2_1Id);
    assert.equal(activeRun2_1.status, "active");
    assert.equal(getGroupClaimedCount(group2_1.group_id), 1);
    pass("Created and claimed active run (1 active, 1 armed in group)");

    // --- 2.1 运行处于 active，Token 仍然有效，调用 start 企图吃下第 2 席位 ---
    // 2.1a: 传入不同 model_name 试图认领，被 IDENTITY_MISMATCH 坚决阻断
    const startDeniedDifferentModel = await client2.sendRequest(202, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Greedy-Different-Model" }
    });
    assert.equal(startDeniedDifferentModel.result?.isError, true, "Start MUST fail while bound run is still active");
    assert.match(startDeniedDifferentModel.result.content[0].text, /already registered as|IDENTITY_MISMATCH/i);

    // 2.1b: 传入相同 model_name 试图认领，被 ALREADY_BOUND 坚决阻断
    const startDeniedSameModel = await client2.sendRequest(2021, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Active-Guard-Model" }
    });
    assert.equal(startDeniedSameModel.result?.isError, true, "Start MUST fail with ALREADY_BOUND");
    assert.match(startDeniedSameModel.result.content[0].text, /ALREADY_BOUND|already bound to active run/i);

    assert.equal(getGroupClaimedCount(group2_1.group_id), 1, "Must NOT claim 2nd seat in either attempt");
    pass("Sub-challenge 2.1 PASSED: Start strictly blocked (IDENTITY_MISMATCH / ALREADY_BOUND) while old run is active");

    // --- 2.2 运行处于 active，Token 意外丢失（401），调用 start 企图绕过活动局 ---
    console.log("  >>> Sub-challenge 2.2: Old run is active with token wiped -> start must be blocked & require resume");
    for (const [t, info] of externalPlay.controllerTokens) {
      if (info.declaredCli === "challenger-m3-c2") {
        externalPlay.controllerTokens.delete(t);
      }
    }

    const startDeniedActiveNoToken = await client2.sendRequest(203, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Bypass-Model" }
    });
    assert.equal(startDeniedActiveNoToken.result?.isError, true, "Start MUST fail and require resume");
    assert.match(startDeniedActiveNoToken.result.content[0].text, /resume/i);
    assert.equal(getGroupClaimedCount(group2_1.group_id), 1, "Must NOT leak seat when token wiped on active run");
    pass("Sub-challenge 2.2 PASSED: Active run with wiped token strictly blocked from start, forced to resume");

    // --- 2.3 旧 run 处于 finalizing 状态，试图 start 必须坚决阻断 ---
    console.log("  >>> Sub-challenge 2.3: Old run is finalizing -> start strictly blocked");
    // 模拟 run 正在 finalizing（后台持久化未完成）
    activeRun2_1.status = "finalizing";

    // 2.3a: 此时在 adapter 尝试调用 start（单元级与客户端级）
    const mockM3Adapter = new StdioMcpAdapter();
    mockM3Adapter.serverJsonPath = path.join(testDataHome, "server.json");
    mockM3Adapter.serverUrl = `http://127.0.0.1:${port}`;
    mockM3Adapter.instanceId = externalPlay.instanceId;

    await assert.rejects(
      async () => {
        await mockM3Adapter._authenticateWithPreviousRun(activeRun2_1.runId);
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.data?.code, "RUN_RESUME_REQUIRED");
        assert.equal(err.data?.status, "finalizing");
        assert.match(err.message, /finalizing/i);
        return true;
      }
    );
    pass("Finalizing run rejected by server with 409 RUN_RESUME_REQUIRED");

    // 2.3b: 完成 finalizing，转入 action_limit
    activeRun2_1.status = "action_limit";
    pass("Finalizing completed -> status transitioned to action_limit");

    // 2.3c: 终态后，再次调用 start 应当立刻放行并认领组内第 2 席
    const startAfterFinalizingDone = await client2.sendRequest(204, "tools/call", {
      name: "start",
      arguments: { model_name: "M3-Model-Post-Finalizing" }
    });
    assert.equal(startAfterFinalizingDone.result?.isError, false, "Start must succeed once finalizing finishes");
    assert.equal(getGroupClaimedCount(group2_1.group_id), 2, "Group must reach 2/2 claimed");
    pass("Sub-challenge 2.3 PASSED: Finalizing strictly blocks; subsequent start succeeds cleanly");

    // --- 2.4 虚假 previous_run_id 或已损坏记录必须被坚决阻断 ---
    console.log("  >>> Sub-challenge 2.4: Non-existent previous_run_id strictly blocked with PREVIOUS_RUN_UNVERIFIED");
    await assert.rejects(
      async () => {
        await mockM3Adapter._authenticateWithPreviousRun("completely-bogus-run-id");
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.data?.code, "PREVIOUS_RUN_UNVERIFIED");
        return true;
      }
    );
    pass("Sub-challenge 2.4 PASSED: Unknown previous_run_id fails closed (PREVIOUS_RUN_UNVERIFIED)");

    await client2.stop();
    await cancelAndDrainAll();

    // ==========================================================================
    // CHALLENGE 3: 代次隔离在极端并发与交替延迟下的绝对滴水不漏
    //              证明旧代次心跳 401/409 绝对不可能篡改新局 Token 或租约
    // ==========================================================================
    console.log("\n[CHALLENGE 3] Generation Isolation Under Extreme Race & Alternating Delays");

    // --- 3.1 真实异步延迟注入：Gen 1 心跳在途挂起，新局已完成 start，旧心跳 401 迟到到达 ---
    console.log("  >>> Sub-challenge 3.1: Heartbeat 401 in-flight during generation transition");
    const adapter3_1 = new StdioMcpAdapter();
    adapter3_1.serverUrl = `http://127.0.0.1:${port}`;
    adapter3_1.controllerToken = "token-gen1";
    adapter3_1.activeRunId = "run-gen1";
    adapter3_1.leaseId = "lease-gen1";
    adapter3_1.leaseEpoch = 1;
    adapter3_1.claimedState = "run-gen1";
    adapter3_1.generation = 1;

    let triggerDelayedHb401 = null;
    adapter3_1.httpRequest = async (method, urlPath, body) => {
      if (urlPath === "/api/external-play/lease/heartbeat" && body?.run_id === "run-gen1") {
        return new Promise((_, reject) => {
          triggerDelayedHb401 = () => {
            const err = new Error("Unauthorized");
            err.statusCode = 401;
            reject(err);
          };
        });
      }
      return { ok: true };
    };

    // 触发 Gen 1 心跳挂起
    const capturedGen1 = adapter3_1.generation;
    const capturedLease1 = adapter3_1.leaseId;
    const hb1Promise = (async () => {
      try {
        await adapter3_1.httpRequest("POST", "/api/external-play/lease/heartbeat", {
          run_id: "run-gen1",
          lease_id: capturedLease1,
          lease_epoch: 1
        });
      } catch (err) {
        if (adapter3_1.generation !== capturedGen1 || adapter3_1.leaseId !== capturedLease1) return;
        if ([401, 403, 404, 409].includes(err.statusCode)) {
          if (err.statusCode === 401 || err.statusCode === 403) adapter3_1.controllerToken = null;
          adapter3_1.requireResumption();
        }
      }
    })();
    assert.notEqual(triggerDelayedHb401, null, "Heartbeat request must be in-flight");

    // 此时新局认领完成，推进到 Gen 2
    adapter3_1._cleanupSession();
    adapter3_1.controllerToken = "token-gen2-secure";
    adapter3_1.activeRunId = "run-gen2";
    adapter3_1.leaseId = "lease-gen2";
    adapter3_1.leaseEpoch = 1;
    adapter3_1.claimedState = "run-gen2";
    adapter3_1.generation = 2;
    adapter3_1.authorizationRequired = false;
    adapter3_1.startHeartbeat();

    // 释放迟到的 Gen 1 401 报错
    triggerDelayedHb401();
    await hb1Promise;

    // 验证 Gen 2 状态绝对未受篡改
    assert.equal(adapter3_1.generation, 2, "Generation must stay 2");
    assert.equal(adapter3_1.controllerToken, "token-gen2-secure", "Gen 2 token must NOT be modified or nulled");
    assert.equal(adapter3_1.authorizationRequired, false, "Gen 2 must NOT be marked authorizationRequired");
    assert.equal(adapter3_1.activeRunId, "run-gen2");
    assert.equal(adapter3_1.leaseId, "lease-gen2");
    assert.notEqual(adapter3_1.heartbeatTimer, null);
    adapter3_1.stopHeartbeat();
    pass("Sub-challenge 3.1 PASSED: Gen 1 Heartbeat 401 safely dropped without mutating Gen 2 token or lease");

    // --- 3.2 多代次交叉雪崩测试（Multi-generation Avalanche of Delayed Stale Errors）---
    console.log("  >>> Sub-challenge 3.2: Multi-generation avalanche of stale 401/409 errors against Gen 3");
    adapter3_1.generation = 3;
    adapter3_1.controllerToken = "token-gen3-supreme";
    adapter3_1.activeRunId = "run-gen3";
    adapter3_1.leaseId = "lease-gen3";
    adapter3_1.authorizationRequired = false;

    // 构造 6 个并发的陈旧错误（覆盖 Gen 0, Gen 1, Gen 2 的各类 401, 403, 404, 409）
    const staleErrors = [
      { gen: 1, lease: "lease-gen1", status: 401 },
      { gen: 1, lease: "lease-gen1", status: 409 },
      { gen: 2, lease: "lease-gen2", status: 401 },
      { gen: 2, lease: "lease-gen2", status: 403 },
      { gen: 2, lease: "lease-gen2", status: 404 },
      { gen: 0, lease: "lease-gen0", status: 401 }
    ];

    await Promise.all(
      staleErrors.map(async ({ gen, lease, status }) => {
        try {
          const err = new Error("Stale failure");
          err.statusCode = status;
          throw err;
        } catch (err) {
          if (adapter3_1.generation !== gen || adapter3_1.leaseId !== lease) return;
          if ([401, 403, 404, 409].includes(err.statusCode)) {
            if (err.statusCode === 401 || err.statusCode === 403) adapter3_1.controllerToken = null;
            adapter3_1.requireResumption();
          }
        }
      })
    );

    assert.equal(adapter3_1.controllerToken, "token-gen3-supreme", "Gen 3 token must withstand error avalanche");
    assert.equal(adapter3_1.authorizationRequired, false, "Gen 3 authorization must remain untouched");
    pass("Sub-challenge 3.2 PASSED: 6x avalanche of multi-generation stale errors 100% neutralized");

    // --- 3.3 迟到动作 ended: true 响应注入 ---
    console.log("  >>> Sub-challenge 3.3: Stale action ended: true response dropped by generation guard");
    const adapter3_3 = new StdioMcpAdapter();
    adapter3_3.initialized = true;
    adapter3_3.generation = 1;
    adapter3_3.controllerToken = "token-m3-3-gen1";
    adapter3_3.claimedState = "run-m3-3-gen1";
    adapter3_3.activeRunId = "run-m3-3-gen1";
    adapter3_3.leaseId = "lease-m3-3-gen1";
    adapter3_3.leaseEpoch = 1;

    let resolveStaleAction = null;
    adapter3_3.httpRequest = async (method, urlPath, body) => {
      if (urlPath === "/api/external-play/mcp" && body?.tool === "left") {
        return new Promise((resolve) => {
          resolveStaleAction = () => {
            resolve({
              result: {
                content: [{
                  type: "text",
                  text: JSON.stringify({ action_seq: 1, observation: {}, ended: true, outcome: "action_limit" })
                }],
                isError: false
              }
            });
          };
        });
      }
      return { ok: true };
    };

    const actionReqPromise = adapter3_3.handleRequest({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: { name: "left", arguments: {} }
    });
    assert.notEqual(resolveStaleAction, null);

    // 推进到 Gen 2
    adapter3_3._cleanupSession();
    adapter3_3.generation = 2;
    adapter3_3.activeRunId = "run-m3-3-gen2";
    adapter3_3.leaseId = "lease-m3-3-gen2";
    adapter3_3.leaseEpoch = 1;
    adapter3_3.startHeartbeat();

    // 释放旧动作响应
    resolveStaleAction();
    await actionReqPromise;

    assert.equal(adapter3_3.activeRunId, "run-m3-3-gen2", "Gen 2 activeRunId must NOT be cleared by stale action");
    assert.equal(adapter3_3.leaseId, "lease-m3-3-gen2", "Gen 2 leaseId must NOT be cleared by stale action");
    assert.notEqual(adapter3_3.heartbeatTimer, null);
    adapter3_3.stopHeartbeat();
    pass("Sub-challenge 3.3 PASSED: Stale action ended: true cleanly dropped");

    // --- 3.4 10 线程突发并发 start 冲击同一 adapter 实例 ---
    console.log("  >>> Sub-challenge 3.4: 10 concurrent starts burst on single adapter instance");
    const groupBurst = await externalPlay.createGroup({ mode: "concurrent", count: 4, maxActions: 10 });
    const childBurst = spawn(process.execPath, [adapterScript], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const clientBurst = new TestJsonRpcClient(childBurst);
    await clientBurst.sendRequest(400, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "challenger-m3-burst" }
    });

    const burstRequests = [];
    for (let i = 0; i < 10; i++) {
      burstRequests.push(
        clientBurst.sendRequest(401 + i, "tools/call", {
          name: "start",
          arguments: { model_name: `Burst-Candidate-${i}` }
        })
      );
    }
    const burstResponses = await Promise.all(burstRequests);
    const burstWins = burstResponses.filter((r) => !r.result?.isError);
    const burstLosses = burstResponses.filter((r) => r.result?.isError);

    assert.equal(burstWins.length, 1, "Exactly ONE start must win the race");
    assert.equal(burstLosses.length, 9, "Remaining 9 starts must be rejected by startInProgress mutex");
    for (const loss of burstLosses) {
      assert.match(loss.result.content[0].text, /start operation is already in progress/i);
    }

    const groupBurstState = externalPlay.getGroup(groupBurst.group_id);
    const claimedInBurst = groupBurstState.entries.filter((e) => e.status === "active");
    const armedInBurst = groupBurstState.entries.filter((e) => e.status === "armed");
    assert.equal(claimedInBurst.length, 1, "Server group must reflect exactly 1 claimed seat");
    assert.equal(armedInBurst.length, 3, "Server group must have 3 armed seats remaining");
    pass("Sub-challenge 3.4 PASSED: 10-way start burst resulted in exactly 1 claim and 9 mutex blocks");

    // 验证后续正常游戏动作无阻碍
    const burstAction = await clientBurst.sendRequest(420, "tools/call", {
      name: "rotate_camera_left",
      arguments: {}
    });
    assert.equal(burstAction.result?.isError, false, "Subsequent game action must succeed after burst");
    pass("Subsequent action succeeded cleanly");

    await clientBurst.stop();
    await cancelAndDrainAll();

    console.log("\n================================================================================");
    console.log(`EMPIRICAL CHALLENGER M3: ALL ${totalAssertions} ADVERSARIAL ASSERTIONS PASSED!`);
    console.log("================================================================================");
  } finally {
    externalPlay.shutdown();
    server.close();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runEmpiricalChallengeM3().catch((err) => {
    console.error("M3 EMPIRICAL CHALLENGE FAILED:", err);
    process.exit(1);
  });
}

module.exports = { runEmpiricalChallengeM3 };
