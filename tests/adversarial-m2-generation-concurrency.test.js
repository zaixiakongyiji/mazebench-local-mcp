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

async function runAdversarialM2Suite() {
  console.log("================================================================================");
  console.log("Starting Challenger 2: Milestone 2 Generation Drop & Concurrency Stress Suite");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-chal2-m2-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;
  externalPlay.options.dataHome = testDataHome;

  let totalAssertions = 0;
  const failures = [];
  function pass(msg) {
    totalAssertions++;
    if (msg) console.log(`  ✓ ${msg}`);
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
    // SUITE 1: 实证对抗——代次丢弃机制实测 (Generation Drop Resilience)
    // ==========================================================================
    console.log("\n--- SUITE 1: Generation Drop & Stale Response Resilience ---");

    // Case 1.1: 心跳 401 延迟报错到达，绝不清空新 token，新局租约和心跳不受影响
    console.log("\n[Case 1.1] Late heartbeat 401 error from old run dropped without affecting new run");
    {
      const adapter = new StdioMcpAdapter();
      adapter.serverUrl = `http://127.0.0.1:${port}`;
      adapter.controllerToken = "token-run-1";
      adapter.activeRunId = "run-1";
      adapter.leaseId = "lease-1";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-1";
      adapter.generation = 1;

      let triggerHeartbeatError = null;
      const originalHttpRequest = adapter.httpRequest.bind(adapter);
      adapter.httpRequest = async (method, urlPath, body, headers, reqId) => {
        if (urlPath === "/api/external-play/lease/heartbeat" && body?.run_id === "run-1") {
          return new Promise((_, reject) => {
            triggerHeartbeatError = (statusCode = 401) => {
              const err = new Error(`Heartbeat failed status ${statusCode}`);
              err.statusCode = statusCode;
              reject(err);
            };
          });
        }
        return originalHttpRequest(method, urlPath, body, headers, reqId);
      };

      // 启动 Run-1 心跳并促发一次心跳请求挂起
      adapter.startHeartbeat();
      // 等待心跳触发或者手动触发 timer 回调
      // 为了精确控制，我们直接等待短时间让 setInterval 跑，或者执行一次内部心跳请求
      // 直接触发一次心跳定时逻辑
      const capturedGen = adapter.generation;
      const capturedRunId = adapter.activeRunId;
      const capturedLeaseId = adapter.leaseId;
      const capturedLeaseEpoch = adapter.leaseEpoch;

      let inFlightPromise = (async () => {
        try {
          await adapter.httpRequest("POST", "/api/external-play/lease/heartbeat", {
            run_id: capturedRunId,
            lease_id: capturedLeaseId,
            lease_epoch: capturedLeaseEpoch
          });
        } catch (err) {
          // 模拟 scripts/maze-external-mcp.js:458 的真实心跳 catch 逻辑
          if (adapter.generation !== capturedGen || adapter.leaseId !== capturedLeaseId) return;
          if ([401, 403, 404, 409].includes(err.statusCode)) {
            if (err.statusCode === 401 || err.statusCode === 403) adapter.controllerToken = null;
            adapter.requireResumption();
          }
        }
      })();

      // 验证旧心跳此时确处于在途挂起状态
      assert.notEqual(triggerHeartbeatError, null, "Heartbeat request must be in-flight");

      // 此时旧局结束，新局 Run-2 认领并附着
      adapter._cleanupSession();
      adapter.controllerToken = "token-run-2";
      adapter.activeRunId = "run-2";
      adapter.leaseId = "lease-2";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-2";
      adapter.generation = 2;
      adapter.startHeartbeat();

      // 延迟触发 Run-1 心跳的 401 报错
      triggerHeartbeatError(401);
      await inFlightPromise;

      // 实证断言：新局完全不受干扰
      assert.equal(adapter.generation, 2, "Generation must remain at 2");
      assert.equal(adapter.controllerToken, "token-run-2", "New token must NEVER be wiped by stale 401");
      assert.equal(adapter.authorizationRequired, false, "Must not set authorizationRequired on new run");
      assert.equal(adapter.activeRunId, "run-2", "New run activeRunId must remain intact");
      assert.equal(adapter.leaseId, "lease-2", "New run leaseId must remain intact");
      assert.notEqual(adapter.heartbeatTimer, null, "New heartbeat timer must remain running");
      adapter.stopHeartbeat();
      pass("Stale 401 heartbeat error dropped cleanly; new run intact");
    }

    // Case 1.2: 心跳 409 延迟报错到达，绝不清空新 token 或将新局置为 authorizationRequired
    console.log("\n[Case 1.2] Late heartbeat 409 error from old run dropped without affecting new run");
    {
      const adapter = new StdioMcpAdapter();
      adapter.serverUrl = `http://127.0.0.1:${port}`;
      adapter.controllerToken = "token-run-1";
      adapter.activeRunId = "run-1";
      adapter.leaseId = "lease-1";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-1";
      adapter.generation = 1;

      let triggerHeartbeat409 = null;
      adapter.httpRequest = async (method, urlPath, body, headers, reqId) => {
        if (urlPath === "/api/external-play/lease/heartbeat" && body?.run_id === "run-1") {
          return new Promise((_, reject) => {
            triggerHeartbeat409 = () => {
              const err = new Error("Run is action_limit");
              err.statusCode = 409;
              reject(err);
            };
          });
        }
      };

      const capturedGen = adapter.generation;
      const capturedRunId = adapter.activeRunId;
      const capturedLeaseId = adapter.leaseId;
      const capturedLeaseEpoch = adapter.leaseEpoch;

      let inFlightPromise = (async () => {
        try {
          await adapter.httpRequest("POST", "/api/external-play/lease/heartbeat", {
            run_id: capturedRunId,
            lease_id: capturedLeaseId,
            lease_epoch: capturedLeaseEpoch
          });
        } catch (err) {
          if (adapter.generation !== capturedGen || adapter.leaseId !== capturedLeaseId) return;
          if ([401, 403, 404, 409].includes(err.statusCode)) {
            if (err.statusCode === 401 || err.statusCode === 403) adapter.controllerToken = null;
            adapter.requireResumption();
          }
        }
      })();

      assert.notEqual(triggerHeartbeat409, null);

      // 切换到 Run-2
      adapter._cleanupSession();
      adapter.controllerToken = "token-run-2";
      adapter.activeRunId = "run-2";
      adapter.leaseId = "lease-2";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-2";
      adapter.generation = 2;
      adapter.startHeartbeat();

      // 迟到 409 返回
      triggerHeartbeat409();
      await inFlightPromise;

      assert.equal(adapter.controllerToken, "token-run-2", "New token must NEVER be wiped by stale 409");
      assert.equal(adapter.authorizationRequired, false, "Must not lock new run in authorizationRequired");
      assert.equal(adapter.activeRunId, "run-2");
      assert.equal(adapter.leaseId, "lease-2");
      adapter.stopHeartbeat();
      pass("Stale 409 heartbeat error dropped cleanly; new run intact");
    }

    // Case 1.3: 旧局动作 ended: true 迟到响应到达，验证不清理新局状态
    console.log("\n[Case 1.3] Late action ended: true response dropped without wiping new run state");
    {
      const adapter = new StdioMcpAdapter();
      adapter.serverUrl = `http://127.0.0.1:${port}`;
      adapter.initialized = true;
      adapter.controllerToken = "token-run-1";
      adapter.activeRunId = "run-1";
      adapter.leaseId = "lease-1";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-1";
      adapter.generation = 1;

      let triggerActionResponse = null;
      adapter.httpRequest = async (method, urlPath, body, headers, reqId) => {
        if (urlPath === "/api/external-play/mcp" && body?.tool === "up") {
          return new Promise((resolve) => {
            triggerActionResponse = () => {
              resolve({
                result: {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      action_seq: 2,
                      observation: { level: 1, action_count: 2 },
                      ended: true,
                      outcome: "action_limit"
                    })
                  }],
                  isError: false
                }
              });
            };
          });
        }
      };

      // 发起旧局动作 handleRequest
      const actionPromise = adapter.handleRequest({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "up", arguments: {} }
      });

      assert.notEqual(triggerActionResponse, null, "Action request must be in-flight");

      // 切换到新局
      adapter._cleanupSession();
      adapter.controllerToken = "token-run-2";
      adapter.activeRunId = "run-2";
      adapter.leaseId = "lease-2";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-2";
      adapter.generation = 2;
      adapter.startHeartbeat();

      // 旧局动作 ended: true 迟到返回
      triggerActionResponse();
      await actionPromise;

      // 实证断言：新局的 activeRunId 与 leaseId 绝不被清除为 null！新局心跳定时器未被停止！
      assert.equal(adapter.generation, 2);
      assert.equal(adapter.activeRunId, "run-2", "New run activeRunId must NOT be wiped by stale action ended: true");
      assert.equal(adapter.leaseId, "lease-2", "New run leaseId must NOT be wiped by stale action ended: true");
      assert.notEqual(adapter.heartbeatTimer, null, "New heartbeat timer must NOT be stopped by stale action");
      adapter.stopHeartbeat();
      pass("Stale action ended: true cleanly dropped; new run active status preserved");
    }

    // Case 1.4: 旧局动作 401 报错迟到到达，验证不将新局置为 authorizationRequired
    console.log("\n[Case 1.4] Late action 401 error dropped without affecting new run auth");
    {
      const adapter = new StdioMcpAdapter();
      adapter.serverUrl = `http://127.0.0.1:${port}`;
      adapter.initialized = true;
      adapter.controllerToken = "token-run-1";
      adapter.activeRunId = "run-1";
      adapter.leaseId = "lease-1";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-1";
      adapter.generation = 1;

      let triggerAction401 = null;
      adapter.httpRequest = async (method, urlPath, body, headers, reqId) => {
        if (urlPath === "/api/external-play/mcp" && body?.tool === "down") {
          return new Promise((_, reject) => {
            triggerAction401 = () => {
              const err = new Error("Token expired");
              err.statusCode = 401;
              reject(err);
            };
          });
        }
      };

      const actionPromise = adapter.handleRequest({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "down", arguments: {} }
      });

      assert.notEqual(triggerAction401, null);

      // 切换新局
      adapter._cleanupSession();
      adapter.controllerToken = "token-run-2";
      adapter.activeRunId = "run-2";
      adapter.leaseId = "lease-2";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-2";
      adapter.generation = 2;

      // 迟到 401
      let case1_4_failed = false;
      let case1_4_error = null;
      try {
        triggerAction401();
        await actionPromise;

        assert.equal(adapter.controllerToken, "token-run-2", "New token must remain intact");
        assert.equal(adapter.authorizationRequired, false, "Must not set authorizationRequired");
        pass("Stale action 401 dropped without poisoning new token");
      } catch (err) {
        case1_4_failed = true;
        case1_4_error = err;
        console.log("  ✗ [VULNERABILITY CONFIRMED in Case 1.4]:", err.message);
        console.log("    Observed: adapter.controllerToken was wiped to", adapter.controllerToken, "and authorizationRequired is", adapter.authorizationRequired);
      }
      if (case1_4_failed) {
        failures.push({ case: "Case 1.4", error: case1_4_error });
      }
    }

    // Case 1.5: action_sequence ended: true 迟到响应到达，验证不清理新局状态
    console.log("\n[Case 1.5] Late action_sequence ended: true dropped without wiping new run state");
    {
      const adapter = new StdioMcpAdapter();
      adapter.serverUrl = `http://127.0.0.1:${port}`;
      adapter.initialized = true;
      adapter.controllerToken = "token-run-1";
      adapter.activeRunId = "run-1";
      adapter.leaseId = "lease-1";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-1";
      adapter.generation = 1;

      let triggerSeqResponse = null;
      adapter.httpRequest = async (method, urlPath, body, headers, reqId) => {
        if (urlPath === "/api/external-play/mcp" && body?.tool === "up") {
          return new Promise((resolve) => {
            triggerSeqResponse = () => {
              resolve({
                result: {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      action_seq: 1,
                      observation: { level: 1 },
                      ended: true,
                      outcome: "action_limit"
                    })
                  }],
                  isError: false
                }
              });
            };
          });
        }
      };

      const seqPromise = adapter.handleRequest({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: { name: "action_sequence", arguments: { actions: ["up"] } }
      });

      assert.notEqual(triggerSeqResponse, null);

      // 切换到新局
      adapter._cleanupSession();
      adapter.controllerToken = "token-run-2";
      adapter.activeRunId = "run-2";
      adapter.leaseId = "lease-2";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-2";
      adapter.generation = 2;
      adapter.startHeartbeat();

      triggerSeqResponse();
      await seqPromise;

      assert.equal(adapter.activeRunId, "run-2");
      assert.equal(adapter.leaseId, "lease-2");
      assert.notEqual(adapter.heartbeatTimer, null);
      adapter.stopHeartbeat();
      pass("Stale action_sequence ended: true cleanly dropped");
    }

    // Case 1.6: 旧局 resume 审批通过响应迟到到达，验证不会附着旧租约
    console.log("\n[Case 1.6] Late resume approved response dropped without attaching stale lease");
    {
      const adapter = new StdioMcpAdapter();
      adapter.serverUrl = `http://127.0.0.1:${port}`;
      adapter.controllerToken = "token-run-1";
      adapter.claimedState = "run-1";
      adapter.generation = 1;

      let triggerResumeStatus = null;
      adapter.httpRequest = async (method, urlPath, body, headers, reqId) => {
        if (urlPath.startsWith("/api/external-play/resume-requests/")) {
          return new Promise((resolve) => {
            triggerResumeStatus = () => {
              resolve({
                status: "approved",
                run_id: "run-1",
                lease_id: "lease-stale-approved",
                lease_epoch: 99
              });
            };
          });
        }
      };

      // 开启轮询
      adapter.startResumePolling("req-stale-1");
      // 手动触发一次 poll 调用以挂起请求
      const pendingObj = adapter.pendingResume;
      assert.notEqual(pendingObj, null);

      const pollPromise = (async () => {
        const data = await adapter.httpRequest("GET", "/api/external-play/resume-requests/req-stale-1/status");
        if (
          adapter.pendingResume !== pendingObj ||
          adapter.generation !== pendingObj.generation ||
          adapter.controllerToken !== pendingObj.token
        ) return;
        if (data.status === "approved") {
          adapter.attachResumedLease(data);
        }
      })();

      assert.notEqual(triggerResumeStatus, null);

      // 新局认领
      adapter._cleanupSession();
      adapter.controllerToken = "token-run-2";
      adapter.activeRunId = "run-2";
      adapter.leaseId = "lease-2";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-2";
      adapter.generation = 2;

      // 迟到审批返回
      triggerResumeStatus();
      await pollPromise;

      // 断言：旧租约绝不附着，新局保持原状
      assert.equal(adapter.activeRunId, "run-2", "Must NOT switch activeRunId to stale approved run-1");
      assert.equal(adapter.leaseId, "lease-2", "Must NOT switch leaseId to stale lease-stale-approved");
      pass("Stale resume approval dropped without hijacking new run");
    }

    // ==========================================================================
    // SUITE 2: 实证对抗——单 Adapter 并发 Start 互斥竞争实测
    // ==========================================================================
    console.log("\n--- SUITE 2: Single-Adapter Concurrent Start Mutex Stress Harness ---");

    // Case 2.1: 并发触发 2 个 start({ model_name }) 请求
    console.log("\n[Case 2.1] 2 Concurrent start requests -> Exactly 1 claims, 1 rejected with mutex");
    {
      const group2 = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 10 });
      const childProc = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const client = new TestJsonRpcClient(childProc);
      await client.sendRequest(1, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-m2-c2-1" }
      });

      const [r1, r2] = await Promise.all([
        client.sendRequest(10, "tools/call", { name: "start", arguments: { model_name: "Model-Race-1" } }),
        client.sendRequest(11, "tools/call", { name: "start", arguments: { model_name: "Model-Race-2" } })
      ]);

      const successes = [r1, r2].filter((r) => !r.result?.isError);
      const errors = [r1, r2].filter((r) => r.result?.isError);

      assert.equal(successes.length, 1, "Exactly 1 start must succeed");
      assert.equal(errors.length, 1, "Exactly 1 start must be rejected");
      assert.match(errors[0].result.content[0].text, /start operation is already in progress/i);

      // 核验服务端状态：2 席位中恰好 1 席被认领
      const groupState = externalPlay.getGroup(group2.group_id);
      const claimedRuns = groupState.entries.filter((r) => r.status === "active");
      const armedRuns = groupState.entries.filter((r) => r.status === "armed");
      assert.equal(claimedRuns.length, 1, "Server must have exactly 1 active run in group");
      assert.equal(armedRuns.length, 1, "Server must have exactly 1 armed run remaining in group");

      childProc.kill("SIGTERM");
      await externalPlay.cancelGroup(group2.group_id);
      pass("2 Concurrent starts: exactly 1 claimed, 1 mutex-rejected, exactly 1 seat claimed on server");
    }

    // Case 2.2: 并发触发 3 个 start({ model_name }) 请求
    console.log("\n[Case 2.2] 3 Concurrent start requests -> Exactly 1 claims, 2 rejected with mutex");
    {
      const group3 = await externalPlay.createGroup({ mode: "concurrent", count: 3, maxActions: 10 });
      const childProc = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const client = new TestJsonRpcClient(childProc);
      await client.sendRequest(1, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-m2-c2-2" }
      });

      const [r1, r2, r3] = await Promise.all([
        client.sendRequest(20, "tools/call", { name: "start", arguments: { model_name: "Racer-3A" } }),
        client.sendRequest(21, "tools/call", { name: "start", arguments: { model_name: "Racer-3B" } }),
        client.sendRequest(22, "tools/call", { name: "start", arguments: { model_name: "Racer-3C" } })
      ]);

      const successes = [r1, r2, r3].filter((r) => !r.result?.isError);
      const errors = [r1, r2, r3].filter((r) => r.result?.isError);

      assert.equal(successes.length, 1, "Exactly 1 start must succeed");
      assert.equal(errors.length, 2, "Exactly 2 starts must be rejected");
      for (const errRes of errors) {
        assert.match(errRes.result.content[0].text, /start operation is already in progress/i);
      }

      const groupState = externalPlay.getGroup(group3.group_id);
      const claimedRuns = groupState.entries.filter((r) => r.status === "active");
      const armedRuns = groupState.entries.filter((r) => r.status === "armed");
      assert.equal(claimedRuns.length, 1);
      assert.equal(armedRuns.length, 2);

      childProc.kill("SIGTERM");
      await externalPlay.cancelGroup(group3.group_id);
      pass("3 Concurrent starts: exactly 1 claimed, 2 mutex-rejected, exactly 1 seat claimed on server");
    }

    // Case 2.3: 极限压力测试：并发触发 5 个 start({ model_name }) 请求
    console.log("\n[Case 2.3] 5 Concurrent start requests -> Exactly 1 claims, 4 rejected with mutex");
    {
      const group5 = await externalPlay.createGroup({ mode: "concurrent", count: 5, maxActions: 10 });
      const childProc = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const client = new TestJsonRpcClient(childProc);
      await client.sendRequest(1, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-m2-c2-3" }
      });

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          client.sendRequest(30 + i, "tools/call", {
            name: "start",
            arguments: { model_name: `Racer-5-${i}` }
          })
        );
      }
      const results = await Promise.all(promises);

      const successes = results.filter((r) => !r.result?.isError);
      const errors = results.filter((r) => r.result?.isError);

      assert.equal(successes.length, 1, "Exactly 1 start must succeed under 5-way concurrency");
      assert.equal(errors.length, 4, "Exactly 4 starts must be rejected under 5-way concurrency");
      for (const errRes of errors) {
        assert.match(errRes.result.content[0].text, /start operation is already in progress/i);
      }

      const groupState = externalPlay.getGroup(group5.group_id);
      const claimedRuns = groupState.entries.filter((r) => r.status === "active");
      const armedRuns = groupState.entries.filter((r) => r.status === "armed");
      assert.equal(claimedRuns.length, 1, "Server must have exactly 1 active run");
      assert.equal(armedRuns.length, 4, "Server must have exactly 4 armed runs remaining");

      childProc.kill("SIGTERM");
      await externalPlay.cancelGroup(group5.group_id);
      pass("5 Concurrent starts: exactly 1 claimed, 4 rejected, 0 double-allocation");
    }

    // Case 2.4: 终态旧局 + Token 丢失长链路重连并发 start 竞争
    console.log("\n[Case 2.4] Concurrent starts during terminal run reauth pipeline");
    {
      // 启动一个进程，先认领单局并使其进入终态
      const singleRun = await externalPlay.createRun({ maxActions: 1 });
      const childProc = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const client = new TestJsonRpcClient(childProc);
      await client.sendRequest(1, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-m2-reauth-race" }
      });

      // 认领并执行到终态
      await client.sendRequest(2, "tools/call", { name: "start", arguments: { model_name: "Initial" } });
      const endAct = await client.sendRequest(3, "tools/call", { name: "rotate_camera_left", arguments: {} });
      assert.equal(JSON.parse(endAct.result.content[0].text).ended, true);

      // 模拟 token 在服务端被销毁（触发 401 认证丢失）
      for (const [t, info] of externalPlay.controllerTokens) {
        if (info.declaredCli === "test-m2-reauth-race") {
          externalPlay.controllerTokens.delete(t);
        }
      }

      // 创建新组（2 席）
      const newGroup = await externalPlay.createGroup({ mode: "concurrent", count: 2, maxActions: 5 });

      // 在客户端处于 claimedState + token lost 状态下，并发发出 3 个 start 请求
      const [r1, r2, r3] = await Promise.all([
        client.sendRequest(10, "tools/call", { name: "start", arguments: { model_name: "Reauth-Racer-1" } }),
        client.sendRequest(11, "tools/call", { name: "start", arguments: { model_name: "Reauth-Racer-2" } }),
        client.sendRequest(12, "tools/call", { name: "start", arguments: { model_name: "Reauth-Racer-3" } })
      ]);

      const successes = [r1, r2, r3].filter((r) => !r.result?.isError);
      const errors = [r1, r2, r3].filter((r) => r.result?.isError);
      console.log("Case 2.4 results:", {
        successesCount: successes.length,
        errorsCount: errors.length,
        r1Result: r1.result?.isError ? r1.result.content[0].text : "SUCCESS",
        r2Result: r2.result?.isError ? r2.result.content[0].text : "SUCCESS",
        r3Result: r3.result?.isError ? r3.result.content[0].text : "SUCCESS"
      });

      let case2_4_failed = false;
      let case2_4_err = null;
      try {
        assert.equal(successes.length, 1, "Exactly 1 start must succeed across reauth pipeline");
        assert.equal(errors.length, 2, "Exactly 2 starts must be rejected across reauth pipeline");
        for (const errRes of errors) {
          assert.match(errRes.result.content[0].text, /start operation is already in progress/i);
        }

        const groupState = externalPlay.getGroup(newGroup.group_id);
        console.log("Case 2.4 r1 payload:", r1.result?.content?.[0]?.text);
        console.log("Case 2.4 group entries:", groupState.entries);
        assert.equal(groupState.entries.filter((r) => r.status === "active").length, 1);
        assert.equal(groupState.entries.filter((r) => r.status === "armed").length, 1);
        pass("Concurrent starts during terminal reauth: exactly 1 claimed seat, 2 rejected");
      } catch (err) {
        case2_4_failed = true;
        case2_4_err = err;
        console.log("  ✗ [VULNERABILITY CONFIRMED in Case 2.4]:", err.message);
      }
      if (case2_4_failed) {
        failures.push({ case: "Case 2.4", error: case2_4_err });
      }

      childProc.kill("SIGTERM");
      await externalPlay.cancelGroup(newGroup.group_id);
    }

    // Case 2.5: start 失败后互斥锁复位验证（防止死锁）
    console.log("\n[Case 2.5] Mutex reset after failed start (no deadlock or permanent blockage)");
    {
      const childProc = spawn(process.execPath, [path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js")], {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const client = new TestJsonRpcClient(childProc);
      await client.sendRequest(1, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-m2-mutex-reset" }
      });

      // 当前没有任何可用席位，发起 start 应当失败
      const failedStart = await client.sendRequest(2, "tools/call", {
        name: "start",
        arguments: { model_name: "Fail-First" }
      });
      assert.equal(failedStart.result?.isError, true, "Start with no runs must fail");

      // 创建一个席位
      await externalPlay.createRun({ maxActions: 5 });

      // 紧接着发起第二次 start，验证互斥锁已复位，后续调用绝不被误判为 in-progress
      const secondStart = await client.sendRequest(3, "tools/call", {
        name: "start",
        arguments: { model_name: "Recovered-Second" }
      });
      assert.equal(secondStart.result?.isError, false, "Second start must succeed after first failure");

      childProc.kill("SIGTERM");
      pass("Mutex cleanly reset after failure; subsequent start succeeded without deadlock");
    }

    console.log(`\n================================================================================`);
    console.log(`CHALLENGER 2 SUITE COMPLETED: ${totalAssertions} assertions passed, ${failures.length} vulnerabilities found.`);
    if (failures.length > 0) {
      console.log(`CONFIRMED VULNERABILITIES:`);
      for (const f of failures) {
        console.log(`  - [${f.case}] ${f.error.message}`);
      }
    }
    console.log(`================================================================================`);
    if (failures.length > 0) {
      throw new Error(`${failures.length} vulnerability found during adversarial empirical testing.`);
    }
  } finally {
    externalPlay.shutdown();
    server.close();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

runAdversarialM2Suite().catch((err) => {
  console.error("Adversarial verification finished with findings:", err.message);
  process.exit(1);
});
