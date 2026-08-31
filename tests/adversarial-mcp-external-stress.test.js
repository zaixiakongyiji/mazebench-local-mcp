const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

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
    assert.equal(toolsRes.result.tools.length, 13);
    pass();

    console.log(">>> [Phase 2] Game Session Claim & Rapid Action Storm (40 steps)");
    const startRes = await client1.callTool(3, "start", {});
    assert.ok(startRes.result);
    assert.equal(startRes.result.isError, false);
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
    const activeRunId = externalPlay.activeRunId;
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

    const conflictRes = await client2.callTool(2, "start", {});
    assert.ok(conflictRes.error || (conflictRes.result && conflictRes.result.isError));
    pass();

    await client2.stop();
    await client1.stop();

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
