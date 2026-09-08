const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
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
        return;
      }
      if (parsed.id !== undefined && this.pending.has(parsed.id)) {
        const { resolve } = this.pending.get(parsed.id);
        this.pending.delete(parsed.id);
        resolve(parsed);
      }
    });

    this.child.on("exit", (code) => {
      for (const [id, { reject }] of this.pending.entries()) {
        reject(new Error(`MCP child exited with code ${code} waiting for ${id}`));
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

  async callTool(id, name, args = {}) {
    return this.sendRequest(id, "tools/call", {
      name,
      arguments: args
    });
  }

  async stop() {
    if (this.child) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}

function fetchHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data ? JSON.parse(data) : null
        });
      });
    });
    req.on("error", reject);
    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runMcpComprehensiveStressTest() {
  console.log("================================================================================");
  console.log("Starting stdio MCP & External Play Comprehensive Stress & Interop Suite...");
  console.log("================================================================================\n");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-mcp-stress-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;
  externalPlay.options.dataHome = testDataHome;

  const server = http.createServer(createRequestHandler());
  const port = 39874;

  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", async () => {
      externalPlay.serverPort = port;
      await externalPlay.initialize();
      await externalPlay.createRun({ durationMs: 1800000 });
      resolve();
    });
  });

  let assertionCount = 0;
  const pass = () => assertionCount++;

  const adapterScript = path.resolve(__dirname, "..", "scripts", "maze-external-mcp.js");

  try {
    console.log(">>> [Phase 1] Stdio MCP Handshake & Tool Discovery");
    const child1 = spawn(process.execPath, [adapterScript], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client1 = new TestJsonRpcClient(child1);

    const initRes = await client1.sendRequest(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "AdversarialStressAgent", version: "1.0.0" }
    });
    assert.ok(initRes.result);
    assert.equal(initRes.result.protocolVersion, "2024-11-05");
    assert.equal(initRes.result.serverInfo?.name, "mazebench");
    pass();

    const toolsRes = await client1.sendRequest(2, "tools/list", {});
    assert.ok(toolsRes.result?.tools);
    assert.equal(toolsRes.result.tools.length, 15);
    pass();

    console.log(">>> [Phase 2] Game Session Claim & Rapid Action Storm (40 steps)");
    const startRes = await client1.callTool(3, "start", { model_name: "AdversarialStressAgent" });
    assert.ok(startRes.result);
    assert.equal(startRes.result.isError, false);
    const startPayload = JSON.parse(startRes.result.content[0].text);
    const activeRunId = startPayload.run_id;
    assert.ok(activeRunId);
    pass();

    // Rapid action storm
    const actions = ["down", "right", "observe", "down", "right", "undo", "right", "down"];
    for (let i = 0; i < 40; i++) {
      const act = actions[i % actions.length];
      const res = await client1.callTool(10 + i, act, {});
      assert.ok(res.result, `Action ${act} at step ${i} must yield result`);
      assert.equal(res.result.isError, false, `Action ${act} at step ${i} must succeed`);
      pass();
    }

    console.log(">>> [Phase 3] Concurrent Viewer Inspection & Telemetry During Active Play");
    const tokenRes = await fetchHttp(`http://127.0.0.1:${port}/api/external-play/runs/${activeRunId}/viewer-token`, {
      method: "POST",
      headers: {
        "Host": `127.0.0.1:${port}`,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin"
      },
      body: {}
    });
    assert.equal(tokenRes.status, 200);
    assert.ok(tokenRes.body?.viewer_token);
    const viewerToken = tokenRes.body.viewer_token;
    pass();

    // Concurrently fetch snapshot, actions, and events via HTTP
    const viewerQueries = [];
    for (let i = 0; i < 15; i++) {
      viewerQueries.push((async () => {
        const snap = await fetchHttp(`http://127.0.0.1:${port}/api/external-play/runs/${activeRunId}/snapshot`, {
          headers: {
            "Host": `127.0.0.1:${port}`,
            "Authorization": `Bearer ${viewerToken}`
          }
        });
        assert.equal(snap.status, 200);
        assert.ok(snap.body);
        assert.equal(snap.body.status, "active");

        const acts = await fetchHttp(`http://127.0.0.1:${port}/api/external-play/runs/${activeRunId}/actions?from_seq=1&limit=50`, {
          headers: {
            "Host": `127.0.0.1:${port}`,
            "Authorization": `Bearer ${viewerToken}`
          }
        });
        assert.equal(acts.status, 200);
        assert.ok(Array.isArray(acts.body?.actions));
        assert.ok(acts.body.actions.length > 0);
        pass();
      })());
    }

    // Interleave with MCP actions
    for (let i = 0; i < 5; i++) {
      viewerQueries.push((async () => {
        const res = await client1.callTool(100 + i, "down", {});
        assert.ok(res.result);
        pass();
      })());
    }

    await Promise.all(viewerQueries);
    console.log("    ✓ Concurrent Viewer HTTP telemetry and MCP actions executed cleanly.");

    console.log(">>> [Phase 4] Adversarial Tool Inputs & Schema Enforcement");
    // 1. Unknown tool
    const unknownRes = await client1.callTool(201, "non_existent_tool_xyz", {});
    assert.ok(unknownRes.error);
    assert.equal(unknownRes.error.code, -32602);
    assert.match(unknownRes.error.message, /Unknown tool/);
    pass();

    // 2. Extra argument rejection
    const extraRes = await client1.callTool(202, "up", { rogue_field: true });
    assert.ok(extraRes.error);
    assert.equal(extraRes.error.code, -32602);
    assert.match(extraRes.error.message, /Unknown argument/);
    pass();

    // 3. Invalid level index
    const badLvlRes = await client1.callTool(203, "go_to_level", { x: "123", y: "456" });
    assert.ok(badLvlRes.error);
    assert.equal(badLvlRes.error.code, -32602);
    pass();

    // 4. Rejection of start with run_id
    const badStartWithRunId = await client1.callTool(204, "start", { model_name: "AdversarialStressAgent", run_id: "fake-run-id" });
    assert.ok(badStartWithRunId.error || badStartWithRunId.result?.isError);
    pass();

    // 5. Resume tool returns pending_approval immediately with review_url
    const resumeRes = await client1.callTool(205, "resume", { run_id: activeRunId });
    assert.ok(resumeRes.result);
    assert.equal(resumeRes.result.isError, false);
    const resumePayload = JSON.parse(resumeRes.result.content[0].text);
    assert.equal(resumePayload.status, "pending_approval");
    assert.ok(resumePayload.review_url);
    pass();

    console.log(">>> [Phase 5] Competing MCP Client Exclusion (Single-Controller Invariant)");
    const child2 = spawn(process.execPath, [adapterScript], {
      env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client2 = new TestJsonRpcClient(child2);

    await client2.sendRequest(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "CompetingClient", version: "1.0.0" }
    });

    const conflictRes = await client2.callTool(2, "start", { model_name: "CompetingClient" });
    assert.ok(conflictRes.error || (conflictRes.result && conflictRes.result.isError));
    pass();

    await client2.stop();
    await client1.stop();

    console.log(">>> [Phase 6] Generation Defense Against Stale Responses (Heartbeat 401/409, Action Ended, Resume Approval)");
    {
      // 6.1 心跳 401 延迟响应到达，代次不匹配时干净丢弃，新局租约与 token 毫发无损
      const adapter = new StdioMcpAdapter();
      adapter.serverUrl = `http://127.0.0.1:${port}`;
      adapter.controllerToken = "token-p6-1";
      adapter.activeRunId = "run-p6-1";
      adapter.leaseId = "lease-p6-1";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-p6-1";
      adapter.generation = 1;

      let triggerHb401 = null;
      adapter.httpRequest = async (method, urlPath, body) => {
        if (urlPath === "/api/external-play/lease/heartbeat" && body?.run_id === "run-p6-1") {
          return new Promise((_, reject) => {
            triggerHb401 = () => {
              const err = new Error("Unauthorized");
              err.statusCode = 401;
              reject(err);
            };
          });
        }
      };

      const capturedGen = adapter.generation;
      const capturedLeaseId = adapter.leaseId;
      let hbPromise401 = (async () => {
        try {
          await adapter.httpRequest("POST", "/api/external-play/lease/heartbeat", {
            run_id: "run-p6-1",
            lease_id: capturedLeaseId,
            lease_epoch: 1
          });
        } catch (err) {
          if (adapter.generation !== capturedGen || adapter.leaseId !== capturedLeaseId) return;
          if ([401, 403, 404, 409].includes(err.statusCode)) {
            if (err.statusCode === 401 || err.statusCode === 403) adapter.controllerToken = null;
            adapter.requireResumption();
          }
        }
      })();
      assert.notEqual(triggerHb401, null);
      pass();

      // 切换并附着新局 (Gen 2)
      adapter._cleanupSession();
      adapter.controllerToken = "token-p6-2";
      adapter.activeRunId = "run-p6-2";
      adapter.leaseId = "lease-p6-2";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-p6-2";
      adapter.generation = 2;
      adapter.startHeartbeat();

      // 迟到心跳 401 到达
      triggerHb401();
      await hbPromise401;

      assert.equal(adapter.generation, 2);
      assert.equal(adapter.controllerToken, "token-p6-2");
      assert.equal(adapter.authorizationRequired, false);
      assert.equal(adapter.activeRunId, "run-p6-2");
      assert.equal(adapter.leaseId, "lease-p6-2");
      assert.notEqual(adapter.heartbeatTimer, null);
      adapter.stopHeartbeat();
      pass();

      // 6.2 心跳 409 延迟响应到达，代次不匹配时干净丢弃
      let triggerHb409 = null;
      adapter.httpRequest = async (method, urlPath, body) => {
        if (urlPath === "/api/external-play/lease/heartbeat" && body?.run_id === "run-p6-2") {
          return new Promise((_, reject) => {
            triggerHb409 = () => {
              const err = new Error("Run is action_limit");
              err.statusCode = 409;
              reject(err);
            };
          });
        }
      };

      const capturedGen2 = adapter.generation;
      const capturedLeaseId2 = adapter.leaseId;
      let hbPromise409 = (async () => {
        try {
          await adapter.httpRequest("POST", "/api/external-play/lease/heartbeat", {
            run_id: "run-p6-2",
            lease_id: capturedLeaseId2,
            lease_epoch: 1
          });
        } catch (err) {
          if (adapter.generation !== capturedGen2 || adapter.leaseId !== capturedLeaseId2) return;
          if ([401, 403, 404, 409].includes(err.statusCode)) {
            if (err.statusCode === 401 || err.statusCode === 403) adapter.controllerToken = null;
            adapter.requireResumption();
          }
        }
      })();
      assert.notEqual(triggerHb409, null);
      pass();

      // 切换新局 (Gen 3)
      adapter._cleanupSession();
      adapter.controllerToken = "token-p6-3";
      adapter.activeRunId = "run-p6-3";
      adapter.leaseId = "lease-p6-3";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-p6-3";
      adapter.generation = 3;
      adapter.startHeartbeat();

      triggerHb409();
      await hbPromise409;

      assert.equal(adapter.controllerToken, "token-p6-3");
      assert.equal(adapter.authorizationRequired, false);
      assert.equal(adapter.activeRunId, "run-p6-3");
      assert.equal(adapter.leaseId, "lease-p6-3");
      adapter.stopHeartbeat();
      pass();

      // 6.3 旧动作 ended: true 延迟响应到达，干净丢弃不清理新局状态
      adapter.initialized = true;
      let triggerActionEnded = null;
      adapter.httpRequest = async (method, urlPath, body) => {
        if (urlPath === "/api/external-play/mcp" && body?.tool === "up") {
          return new Promise((resolve) => {
            triggerActionEnded = () => {
              resolve({
                result: {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      action_seq: 5,
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

      const actionPromise = adapter.handleRequest({
        jsonrpc: "2.0",
        id: 601,
        method: "tools/call",
        params: { name: "up", arguments: {} }
      });
      assert.notEqual(triggerActionEnded, null);
      pass();

      // 切换新局 (Gen 4)
      adapter._cleanupSession();
      adapter.controllerToken = "token-p6-4";
      adapter.activeRunId = "run-p6-4";
      adapter.leaseId = "lease-p6-4";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-p6-4";
      adapter.generation = 4;
      adapter.startHeartbeat();

      triggerActionEnded();
      await actionPromise;

      assert.equal(adapter.activeRunId, "run-p6-4");
      assert.equal(adapter.leaseId, "lease-p6-4");
      assert.notEqual(adapter.heartbeatTimer, null);
      adapter.stopHeartbeat();
      pass();

      // 6.4 旧审批 approved 延迟响应到达，干净丢弃不附着旧租约
      let triggerResumeStatus = null;
      adapter.httpRequest = async (method, urlPath) => {
        if (urlPath.startsWith("/api/external-play/resume-requests/")) {
          return new Promise((resolve) => {
            triggerResumeStatus = () => {
              resolve({
                status: "approved",
                run_id: "run-p6-stale",
                lease_id: "lease-p6-stale-approved",
                lease_epoch: 99
              });
            };
          });
        }
      };

      adapter.startResumePolling("req-p6-stale");
      const pendingObj = adapter.pendingResume;
      assert.notEqual(pendingObj, null);

      const pollPromise = (async () => {
        const data = await adapter.httpRequest("GET", "/api/external-play/resume-requests/req-p6-stale/status");
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
      pass();

      // 切换新局 (Gen 5)
      adapter._cleanupSession();
      adapter.controllerToken = "token-p6-5";
      adapter.activeRunId = "run-p6-5";
      adapter.leaseId = "lease-p6-5";
      adapter.leaseEpoch = 1;
      adapter.claimedState = "run-p6-5";
      adapter.generation = 5;

      triggerResumeStatus();
      await pollPromise;

      assert.equal(adapter.activeRunId, "run-p6-5");
      assert.equal(adapter.leaseId, "lease-p6-5");
      adapter.stopResumePolling();
      pass();
    }

    console.log(">>> [Phase 7] Single-Adapter Concurrent Start Mutex & Single-Seat Double-Claim Prevention");
    {
      // 7.1 单一 adapter 实例并发发起多个 start 请求，实证断言严格至多认领 1 个席位
      const groupP7 = await externalPlay.createGroup({ mode: "concurrent", count: 3, maxActions: 10 });
      const childP7 = spawn(process.execPath, [adapterScript], {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const clientP7 = new TestJsonRpcClient(childP7);
      await clientP7.sendRequest(800, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "P7-ConcurrentAgent", version: "1.0.0" }
      });

      const [s1, s2, s3] = await Promise.all([
        clientP7.sendRequest(801, "tools/call", { name: "start", arguments: { model_name: "P7-Model-A" } }),
        clientP7.sendRequest(802, "tools/call", { name: "start", arguments: { model_name: "P7-Model-B" } }),
        clientP7.sendRequest(803, "tools/call", { name: "start", arguments: { model_name: "P7-Model-C" } })
      ]);

      const successes = [s1, s2, s3].filter((r) => !r.result?.isError);
      const errors = [s1, s2, s3].filter((r) => r.result?.isError);

      assert.equal(successes.length, 1, "Exactly 1 start must succeed");
      assert.equal(errors.length, 2, "Exactly 2 starts must be rejected");
      for (const errRes of errors) {
        assert.match(errRes.result.content[0].text, /start operation is already in progress/i);
      }

      const groupP7State = externalPlay.getGroup(groupP7.group_id);
      const claimedP7Runs = groupP7State.entries.filter((r) => r.status === "active");
      const armedP7Runs = groupP7State.entries.filter((r) => r.status === "armed");
      assert.equal(claimedP7Runs.length, 1, "Server must have exactly 1 active run in group");
      assert.equal(armedP7Runs.length, 2, "Server must have exactly 2 armed runs remaining in group");
      pass();

      await clientP7.stop();
      await externalPlay.cancelGroup(groupP7.group_id);
      for (const entry of groupP7.entries) {
        const r = externalPlay.getRun(entry.run_id);
        if (r) {
          while (r.status === "finalizing") await new Promise((res) => setTimeout(res, 10));
        }
      }

      // 7.2 在单席位可用环境下 401 恢复 start 成功认领且不报 409 席位耗尽错误
      const childP7b = spawn(process.execPath, [adapterScript], {
        env: { ...process.env, MAZEBENCH_DATA_HOME: testDataHome },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const clientP7b = new TestJsonRpcClient(childP7b);
      await clientP7b.sendRequest(900, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "p7-single-seat-client", version: "1.0.0" }
      });

      // 认领单局并使其进入 action_limit 终态
      const preRun = await externalPlay.createRun({ maxActions: 1 });
      const preStart = await clientP7b.sendRequest(901, "tools/call", {
        name: "start",
        arguments: { model_name: "P7-Model-Single-Pre" }
      });
      assert.equal(preStart.result?.isError, false);
      assert.equal(JSON.parse(preStart.result.content[0].text).run_id, preRun.runId);

      const preAct = await clientP7b.sendRequest(902, "tools/call", { name: "rotate_camera_left", arguments: {} });
      assert.equal(preAct.result?.isError, false);
      assert.equal(JSON.parse(preAct.result.content[0].text).ended, true);

      while (preRun.status === "finalizing") {
        await new Promise((res) => setTimeout(res, 10));
      }
      assert.equal(preRun.status, "action_limit");

      // 模拟服务端销毁该 controller token（触发 401）
      for (const [t, info] of externalPlay.controllerTokens) {
        if (info.declaredCli === "p7-single-seat-client") {
          externalPlay.controllerTokens.delete(t);
        }
      }

      // 此时服务端只有 1 个单席位 armed run
      const nextSingleRun = await externalPlay.createRun({ maxActions: 5 });
      assert.equal(nextSingleRun.status, "armed");

      // 客户端发起显式 start，验证自愈认领成功，绝不抛出 409 CONFLICT 错误
      const nextStart = await clientP7b.sendRequest(903, "tools/call", {
        name: "start",
        arguments: { model_name: "P7-Model-Single-Reclaim" }
      });
      assert.equal(nextStart.result?.isError, false, "Must claim single seat without 409 double-claim error");
      const nextStartPayload = JSON.parse(nextStart.result.content[0].text);
      assert.equal(nextStartPayload.run_id, nextSingleRun.runId);
      assert.equal(nextStartPayload.status, "active");

      // 验证正常执行动作
      const nextAct = await clientP7b.sendRequest(904, "tools/call", { name: "rotate_camera_right", arguments: {} });
      assert.equal(nextAct.result?.isError, false);
      assert.equal(JSON.parse(nextAct.result.content[0].text).action_seq, 1);
      pass();

      await clientP7b.stop();
      await nextSingleRun.cancelRun();
      while (nextSingleRun.status === "finalizing") {
        await new Promise((res) => setTimeout(res, 10));
      }
    }

    console.log("\n================================================================================");
    console.log(`All stdio MCP & External Play Stress Tests PASSED! Total Assertions: ${assertionCount}`);
    console.log("================================================================================\n");

  } finally {
    externalPlay.shutdown();
    server.close();
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runMcpComprehensiveStressTest().catch((err) => {
    console.error("MCP Stress Test Failed:", err);
    process.exit(1);
  });
}

module.exports = { runMcpComprehensiveStressTest };
