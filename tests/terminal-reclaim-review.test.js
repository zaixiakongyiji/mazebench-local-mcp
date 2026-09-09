const assert = require("node:assert/strict");
const { StdioMcpAdapter } = require("../scripts/maze-external-mcp");

const request = (id, name, args = {}) => ({ id, method: "tools/call", params: { name, arguments: args } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const proof = () => ({ previous_run: { run_id: "old", ended: true, status: "action_limit" },
  controller_token: "new-token", controller_id: "new-controller", instance_id: "instance" });
const result = (ended = false) => ({ content: [{ type: "text", text: JSON.stringify({ ended }) }] });
const adapter = () => {
  const a = new StdioMcpAdapter();
  Object.assign(a, { initialized: true, claimedState: "old", activeRunId: "old", leaseId: "lease",
    leaseEpoch: 1, controllerToken: "token", instanceId: "instance" });
  a.startHeartbeat = () => {};
  return a;
};

async function runTests() {
  // 捕获并校验真实 JSON-RPC 回复，避免仅检查内存状态而漏掉客户端挂起。
  const output = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { output.push(JSON.parse(String(chunk))); return true; };
  const response = (id) => {
    const messages = output.filter((m) => m.id === id);
    assert.equal(messages.length, 1, `Request ${id} must receive exactly one response`);
    return messages[0];
  };
  try {
    for (const statusCode of [401, 403]) {
      const a = adapter();
      a.httpRequest = async () => { throw Object.assign(new Error("Unauthorized"), { statusCode }); };
      await a.handleRequest(request(statusCode, "action_sequence", { actions: ["up"] }));
      assert.equal(response(statusCode).result.isError, true);
      assert.equal(a.authorizationRequired, true);
    }

    const a = adapter();
    a.authorizationRequired = true;
    a._authenticateWithPreviousRun = async () => proof();
    a.httpRequest = async () => { throw Object.assign(new Error("NO_AVAILABLE_RUN"), { statusCode: 409 }); };
    await a.handleRequest(request(10, "start", { model_name: "model" }));
    assert.match(response(10).result.content[0].text, /NO_AVAILABLE_RUN/);
    assert.equal(a.authorizationRequired, false);

    // 两个恢复入口都必须拒绝畸形确认，并阻止取消后的迟到确认继续认领。
    for (const initiallyLocked of [true, false]) {
      for (const mutation of [
        (p) => { p.previous_run.run_id = "other"; },
        (p) => { p.previous_run.status = "active"; },
        (p) => { p.previous_run.ended = false; },
        (p) => { p.controller_token = ""; },
        (p) => { p.controller_id = null; },
        (p) => { p.instance_id = "other-instance"; },
        (p) => { delete p.previous_run; }
      ]) {
        const b = adapter(); b.authorizationRequired = initiallyLocked;
        const data = proof(); mutation(data);
        b._authenticateWithPreviousRun = async () => data;
        let calls = 0;
        b.httpRequest = async () => { calls++; throw Object.assign(new Error("Unauthorized"), { statusCode: 401 }); };
        const id = 1000 + output.length;
        await b.handleRequest(request(id, "start", { model_name: "model" }));
        assert.equal(response(id).result.isError, true);
        assert.equal(calls, initiallyLocked ? 0 : 1);
        assert.equal(b.claimedState, "old");
      }
      for (const disconnect of [false, true]) {
        const b = adapter(); b.authorizationRequired = initiallyLocked;
        const gate = deferred(); const entered = deferred();
        b._authenticateWithPreviousRun = () => { entered.resolve(); return gate.promise; };
        let claims = 0;
        b.httpRequest = async (m, u, body) => {
          if (body?.tool === "start") {
            if (!initiallyLocked && claims++ === 0) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
            if (initiallyLocked) claims++;
          }
          return {};
        };
        const id = 2000 + output.length;
        const pending = b.handleRequest(request(id, "start", { model_name: "model" }));
        await entered.promise;
        if (disconnect) await b.detach();
        else await b.handleRequest({ method: "notifications/cancelled", params: { requestId: id } });
        gate.resolve(proof()); await pending;
        assert.equal(claims, initiallyLocked ? 0 : 1);
        assert.ok(response(id).error || response(id).result.isError);
      }
    }

    for (const first of ["start", "resume"]) {
      const b = adapter(); const gate = deferred(); const entered = deferred();
      b.authorizationRequired = true;
      b._authenticateWithPreviousRun = () => { entered.resolve(); return gate.promise; };
      let calls = 0;
      b.httpRequest = async () => { calls++; entered.resolve(); return gate.promise; };
      const id = 3000 + output.length;
      const args = (name) => name === "start" ? { model_name: "model" } : { run_id: "old" };
      const pending = b.handleRequest(request(id, first, args(first)));
      await entered.promise;
      const second = first === "start" ? "resume" : "start";
      await b.handleRequest(request(id + 1, second, args(second)));
      assert.equal(response(id + 1).result.isError, true);
      assert.equal(calls, first === "start" ? 0 : 1);
      await b.handleRequest({ method: "notifications/cancelled", params: { requestId: id } });
      gate.resolve(first === "start" ? proof() : { status: "approved", run_id: "old", lease_id: "late", lease_epoch: 2 });
      await pending;
      assert.equal(response(id).error.code, -32800);
      assert.notEqual(b.leaseId, "late");
    }

    for (const sequence of [true, false]) {
      const b = adapter(); const gate = deferred(); const targets = [];
      b.httpRequest = async (m, u, body) => { targets.push(body.run_id); return gate.promise; };
      const id = 4000 + output.length;
      const pending = b.handleRequest(request(id, sequence ? "action_sequence" : "up", sequence ? { actions: ["up", "down"] } : {}));
      b.attachResumedLease({ run_id: "new", lease_id: "new-lease", lease_epoch: 2 });
      gate.resolve(result(false)); await pending;
      assert.deepEqual(targets, ["old"]);
      assert.equal(response(id).result.isError, true);
      assert.equal(b.activeRunId, "new");
    }
  } finally {
    process.stdout.write = write;
  }
  console.log("terminal-reclaim-review: PASS (errors, cancellation, proof validation, transition mutex, stale responses)");
}

if (require.main === module) runTests().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { runTests };
