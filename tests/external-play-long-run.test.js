const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StdioMcpAdapter } = require("../scripts/maze-external-mcp");
const { createRequestHandler, externalPlay } = require("../server/app");

async function testTransport() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/partial") { res.writeHead(200); res.write('{'); setTimeout(() => res.destroy(), 10); }
    if (req.url === "/ok") res.end('{"ok":true}');
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const adapter = new StdioMcpAdapter();
  adapter.serverUrl = `http://127.0.0.1:${server.address().port}`;
  adapter.httpTimeoutMs = 80;
  try {
    await assert.rejects(adapter.httpRequest("GET", "/stall", null, {}, 1), { code: "ETIMEDOUT" });
    assert.equal(adapter.activeRequests.size, 0);
    adapter.httpTimeoutMs = 5000;
    await assert.rejects(adapter.httpRequest("GET", "/partial", null, {}, 2), { code: "ECONNRESET" });
    assert.equal(adapter.activeRequests.size, 0);
    assert.deepEqual(await adapter.httpRequest("GET", "/ok"), { ok: true });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testStartRetry() {
  const adapter = new StdioMcpAdapter();
  adapter.controllerToken = "controller";
  adapter.initialized = true;
  const operations = [];
  let claim;
  adapter.httpRequest = async (method, url, body) => {
    assert.equal(url, "/api/external-play/mcp");
    operations.push(body.operation_id);
    claim ||= { run_id: "ext-test", lease_id: "lease", lease_epoch: 1 };
    if (operations.length === 1) throw Object.assign(new Error("response lost after claim"), { code: "ETIMEDOUT" });
    return claim;
  };
  adapter.startHeartbeat = () => {};
  const write = process.stdout.write;
  const replies = [];
  process.stdout.write = chunk => { replies.push(JSON.parse(chunk)); return true; };
  try {
    const call = id => adapter.handleRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "start", arguments: { model_name: "retry-test" } } });
    await call(901);
    assert.equal(replies.at(-1).result.isError, true);
    await call(902);
    assert.equal(replies.at(-1).result.isError, false);
    assert.equal(operations.length, 2);
    assert.equal(operations[0], operations[1], "丢失认领响应后沿用相同幂等 ID");
    assert.equal(adapter.activeRunId, "ext-test");
    adapter.pendingStart = { operationId: "unknown-start", fingerprint: "old-model" };
    adapter.attachResumedLease({ run_id: "ext-resumed", lease_id: "approved-lease", lease_epoch: 2 });
    assert.equal(adapter.pendingStart, null, "获批恢复后清理已解决的未知认领，避免阻塞后续新局");
  } finally { process.stdout.write = write; }
}

async function testHeartbeatSingleFlight() {
  const adapter = new StdioMcpAdapter();
  adapter.activeRunId = "ext-heartbeat";
  adapter.leaseId = "lease";
  adapter.leaseEpoch = 1;
  let tick;
  let release;
  let calls = 0;
  adapter.httpRequest = async () => { calls++; await new Promise(resolve => { release = resolve; }); };
  const interval = global.setInterval;
  global.setInterval = fn => { tick = fn; return null; };
  try { adapter.startHeartbeat(); } finally { global.setInterval = interval; }
  const first = tick();
  await tick();
  assert.equal(calls, 1, "心跳等待期间不能发起重叠请求");
  release();
  await first;
  const next = tick();
  assert.equal(calls, 2, "前一个请求完成后恢复发送");
  release();
  await next;
}

async function run() {
  await testTransport();
  await testStartRetry();
  await testHeartbeatSingleFlight();
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "maze-long-run-"));
  externalPlay.options.dataHome = dataHome;
  const server = http.createServer(createRequestHandler());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  externalPlay.serverPort = server.address().port;
  await externalPlay.initialize();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await externalPlay.createRun({ max_actions: 60000 });
    const session = await externalPlay.handleControllerSession(externalPlay.mcpBootstrapNonce, { name: "long-run-test" });
    const info = externalPlay.validateControllerToken(`Bearer ${session.controller_token}`);
    await externalPlay.claimRun(info, { model_name: "test" }, "long-start");
    const token = externalPlay.controllerTokens.get(session.controller_token);
    token.createdAt = Date.now() - 23 * 3600000;
    const heartbeat = () => fetch(`${base}/api/external-play/lease/heartbeat`, {
      method: "POST", headers: { Authorization: `Bearer ${session.controller_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: run.runId, lease_id: run.currentLease?.leaseId, lease_epoch: run.currentLease?.leaseEpoch })
    });
    assert.equal((await heartbeat()).status, 200);
    token.createdAt = Date.now() - 48 * 3600000;
    assert.ok(externalPlay.validateControllerToken(`Bearer ${session.controller_token}`), "成功心跳跨过最初的 24 小时期限");
    const renewedAt = token.renewedAt;
    run.currentLease.expiresAt = Date.now() - 1;
    assert.equal((await heartbeat()).status, 409);
    assert.equal(token.renewedAt, renewedAt, "过期租约不能续期凭据");
    token.renewedAt = Date.now() - 25 * 3600000;
    assert.equal((await heartbeat()).status, 401);
    externalPlay.renewControllerToken(info);
    assert.equal(externalPlay.controllerTokens.has(session.controller_token), false, "已过期凭据不能复活");

    // 5 万步的 WAL 投影用已有对象建立索引；分页不能访问动作文件或日志。
    for (let seq = 1; seq <= 50000; seq++) run._applyJournalRecord({
      type: "action_committed", action_seq: seq, event_id: seq,
      action_record: { seq, tool: "left", sanitized_status: { collected_gems_count: seq >= 321 ? 1 : 0 } }
    });
    const viewerHeaders = { Authorization: `Bearer ${externalPlay.generateViewerToken(run.runId)}` };
    const originalRead = fs.readFileSync;
    let forbiddenReads = 0;
    fs.readFileSync = function(file, ...args) {
      if (file === run.actionsPath || file === run.journalPath) { forbiddenReads++; throw new Error("分页不得扫描文件"); }
      return originalRead.call(this, file, ...args);
    };
    try {
      for (const from of [1, 25000, 49901]) {
        const response = await fetch(`${base}/api/external-play/runs/${run.runId}/actions?from_seq=${from}&limit=100`, { headers: viewerHeaders });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.actions.length, 100);
        assert.equal(data.actions[0].seq, from);
        assert.equal(data.actions[99].seq, from + 99);
      }
      const expired = await fetch(`${base}/api/external-play/runs/${run.runId}/events?after_event_id=0`, { headers: viewerHeaders });
      assert.equal(expired.status, 410);
      const controller = new AbortController();
      const stream = await fetch(`${base}/api/external-play/runs/${run.runId}/events?after_event_id=49999`, { signal: controller.signal, headers: viewerHeaders });
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /"action_seq":50000/);
      controller.abort();
      assert.equal(forbiddenReads, 0);
    } finally { fs.readFileSync = originalRead; }
    console.log("Long-run transport, authorization and 50,000-action pagination tests PASSED");
  } finally {
    externalPlay.shutdown();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
