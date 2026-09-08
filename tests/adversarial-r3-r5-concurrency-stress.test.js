/**
 * Extreme Concurrency & Timing Boundary Adversarial Stress Test Suite for R3 & R5
 *
 * Requirements Challenged:
 * 1. R3: Lease Expiry Concurrency & Timing Race
 *    - Boundary timing: flood of concurrent heartbeat & executeAction at lease expiry threshold
 *    - 100% rejection with 409 CONFLICT inside sessionMutex when expired
 *    - Zero lease extension post-expiry; zero unhandled lockup / deadlock
 *    - Timer cleanup (_handleLeaseTimeout) vs active expiry check dual-defense security
 * 2. R5: Rejected Action Idempotency Retry & Error Mutation
 *    - High-concurrency multi-client retries of rejected actions using same operation_id
 *    - 100% consistent structured error response (isError: true, content non-empty), zero undefined, zero HTTP empty 200
 *    - Adversarial mutations: parameter variation, cross-controller conflict, legacy replay fallback
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");

const { createRequestRouter } = require("../server/router");
const { ExternalPlayService } = require("../server/external-play");
const { validateJournalRecord } = require("../shared/validators.standalone");

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}), "Connection": "close" };
    let bodyStr = null;
    if (options.body !== undefined && options.body !== null) {
      bodyStr = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    const req = http.request(url, { ...options, headers, agent: false }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          if (data) json = JSON.parse(data);
        } catch (e) {
          // ignore non-json
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawBody: data,
          body: json
        });
      });
    });
    req.on("error", reject);
    if (bodyStr) {
      req.end(bodyStr);
    } else {
      req.end();
    }
  });
}

async function runAdversarialStressSuite() {
  console.log("================================================================================");
  console.log("Starting R3 & R5 Concurrency & Timing Boundary Adversarial Stress Test Suite...");
  console.log("================================================================================\n");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-r3-r5-stress-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  let totalTests = 0;
  let passedTests = 0;

  function recordPass(testName) {
    totalTests++;
    passedTests++;
    console.log(`  [PASS] Test ${totalTests}: ${testName}`);
  }

  // Standalone isolated service for stress tests
  const service = new ExternalPlayService({
    dataHome: testDataHome,
    port: 39555,
    defaultMaxActions: 100
  });
  await service.initialize();

  const newController = async (name) => {
    const session = await service.handleControllerSession(service.mcpBootstrapNonce, { name });
    const ctrl = service.validateControllerToken(`Bearer ${session.controller_token}`);
    return { ...ctrl, rawToken: session.controller_token };
  };

  // HTTP server wired to this service
  const router = createRequestRouter({
    externalPlay: service,
    readJsonBody: async (req) => {
      return new Promise((resolve, reject) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => {
          try {
            resolve(d ? JSON.parse(d) : {});
          } catch (e) {
            reject(e);
          }
        });
        req.on("error", reject);
      });
    },
    sendJson: (res, status, payload) => {
      const data = JSON.stringify(payload);
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(data),
        "Connection": "close"
      });
      res.end(data);
    },
    publicFileRoutes: new Map()
  });

  const httpServer = http.createServer((req, res) => router.handleRequest(req, res));
  let httpPort = 0;
  await new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      httpPort = httpServer.address().port;
      service.serverPort = httpPort;
      resolve();
    });
  });
  const httpBaseUrl = `http://127.0.0.1:${httpPort}`;

  try {
    // ============================================================================
    // SECTION 1: R3 对抗压力测试 (租约过期并发与时序竞争)
    // ============================================================================
    console.log(">>> [SECTION 1] R3: 租约过期并发与时序极限竞争测试");

    // ----------------------------------------------------------------------------
    // Test 1: 已过期时刻的高并发心跳与动作风暴 (Post-expiry 100% 409 & No Renewal)
    // ----------------------------------------------------------------------------
    {
      const ctrl = await newController("ctrl-r3-post-expiry");
      const run = await service.createRun({ maxActions: 100 });
      const lease = await service.claimRun(ctrl, { model_name: "R3-Tester-1" });

      // 人为将租约到期时间设为过去 100ms
      const expiredTimestamp = Date.now() - 100;
      run.currentLease.expiresAt = expiredTimestamp;

      // 同时发起 60 个并发调用（30 个 heartbeat，30 个 executeAction）
      const CONCURRENCY = 60;
      const promises = [];

      for (let i = 0; i < CONCURRENCY; i++) {
        if (i % 2 === 0) {
          promises.push(
            run.heartbeat(ctrl, lease.lease_id, lease.lease_epoch)
              .then(() => ({ type: "heartbeat", ok: true }))
              .catch((err) => ({ type: "heartbeat", ok: false, err }))
          );
        } else {
          promises.push(
            run.executeAction(
              ctrl,
              lease.lease_id,
              lease.lease_epoch,
              "rotate_camera_left",
              {},
              `op-r3-expired-${i}`
            )
              .then(() => ({ type: "action", ok: true }))
              .catch((err) => ({ type: "action", ok: false, err }))
          );
        }
      }

      const results = await Promise.all(promises);

      // 验证：100% 的调用必须被拒绝，成功率必须为 0
      const successes = results.filter((r) => r.ok);
      assert.equal(successes.length, 0, "所有调用必须 100% 失败，绝不允许在已过期状态下成功");

      // 验证每一个失败均为 409 CONFLICT 且包含 expired
      for (const res of results) {
        assert.equal(res.err.status, 409, "必须返回 409 HTTP 状态码");
        assert.equal(res.err.code, "CONFLICT", "错误码必须为 CONFLICT");
        assert.match(res.err.message, /expired/i, "错误信息必须指出租约已过期");
      }

      // 验证租约过期时间绝未被非法延长
      assert.equal(run.currentLease.expiresAt, expiredTimestamp, "过期租约时间绝对不可被 heartbeat 延长");
      // 验证未发生任何动作提交
      assert.equal(run.lastActionSeq, 0, "过期租约绝对不可提交任何动作");

      run.cleanup();
      recordPass("R3-1: 已过期状态下 60 路并发 heartbeat/action 100% 被 409 拦截且租约绝不续期");
    }

    // ----------------------------------------------------------------------------
    // Test 2: 租约即时到期临界区毫秒级并发时序竞争 (Brink Expiration Timing Race)
    // ----------------------------------------------------------------------------
    {
      const ctrl = await newController("ctrl-r3-brink-race");
      const run = await service.createRun({ maxActions: 100 });
      const lease = await service.claimRun(ctrl, { model_name: "R3-Tester-2" });

      // 设置租约在 20ms 后到期
      const initialExpiresAt = Date.now() + 20;
      run.currentLease.expiresAt = initialExpiresAt;

      // 等待 25ms 跨越到期界限，但在跨越界限的同时密集发射并发请求
      await new Promise((resolve) => setTimeout(resolve, 25));

      const CONCURRENCY = 50;
      const calls = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        calls.push(
          run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            "rotate_camera_right",
            {},
            `op-r3-brink-${i}`
          )
            .then(() => ({ ok: true }))
            .catch((err) => ({ ok: false, err }))
        );
      }

      const results = await Promise.all(calls);
      // 此时已超过 20ms，所有进入锁的请求必须被 409 拦截
      const succeeded = results.filter((r) => r.ok);
      assert.equal(succeeded.length, 0, "跨越到期时间后的动作必须全部被拦截");
      assert.equal(run.lastActionSeq, 0, "动作序列号不得增加");

      run.cleanup();
      recordPass("R3-2: 毫秒级临界时序跨越后 50 路并发动作 100% 拒绝并锁内拦截");
    }

    // ----------------------------------------------------------------------------
    // Test 3: 定时器后台触发与前端并发抢锁双重防御安全性 (Timer vs Mutex Contention)
    // ----------------------------------------------------------------------------
    {
      const ctrl = await newController("ctrl-r3-timer-race");
      const run = await service.createRun({ maxActions: 100 });
      const lease = await service.claimRun(ctrl, { model_name: "R3-Tester-3" });

      // 设置租约过期时间为当前时刻前 1ms
      run.currentLease.expiresAt = Date.now() - 1;

      // 同时并发启动：
      // 1. 定时器超时清理 _handleLeaseTimeout()
      // 2. 20 个并发 heartbeat
      // 3. 20 个并发 executeAction
      const timeoutPromise = run._handleLeaseTimeout();
      const concurrentRequests = [];

      for (let i = 0; i < 20; i++) {
        concurrentRequests.push(
          run.heartbeat(ctrl, lease.lease_id, lease.lease_epoch)
            .then(() => ({ type: "heartbeat", ok: true }))
            .catch((err) => ({ type: "heartbeat", ok: false, err }))
        );
        concurrentRequests.push(
          run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            "rotate_camera_left",
            {},
            `op-r3-timer-race-${i}`
          )
            .then(() => ({ type: "action", ok: true }))
            .catch((err) => ({ type: "action", ok: false, err }))
        );
      }

      const [_, ...reqResults] = await Promise.all([timeoutPromise, ...concurrentRequests]);

      // 验证：所有 40 个请求全部被拒绝，无死锁，无一漏网
      const successReqs = reqResults.filter((r) => r.ok);
      assert.equal(successReqs.length, 0, "双重防御下所有请求必须 100% 拒绝");
      for (const res of reqResults) {
        assert.equal(res.err.status, 409);
        assert.equal(res.err.code, "CONFLICT");
      }

      // 验证定时器成功持久化了 lease_revoked 审计记录
      const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
      const revokedRecords = journalLines.filter((r) => r.type === "lease_revoked" && r.reason === "heartbeat_timeout");
      assert.equal(revokedRecords.length, 1, "WAL 必须有且仅有 1 条 heartbeat_timeout 的 lease_revoked 记录");
      assert.equal(run.currentLease, null, "租约必须已完全撤销并置为 null");

      run.cleanup();
      recordPass("R3-3: 定时器清理与锁内到期校验双重防御竞争无死锁、无状态穿透且 WAL 正确提交");
    }

    // ----------------------------------------------------------------------------
    // Test 4: HTTP 路由层真实端到端租约过期高并发对抗 (HTTP End-to-End Expiry Storm)
    // ----------------------------------------------------------------------------
    {
      const run = await service.createRun({ maxActions: 100 });
      const ctrl = await newController("ctrl-r3-http-stress");
      const claimRes = await service.claimRun(ctrl, { model_name: "HTTP-R3-Client" });

      // 设置租约过期
      run.currentLease.expiresAt = Date.now() - 50;

      // 并发 20 个 HTTP Heartbeat + 20 个 HTTP Action (via /api/external-play/lease/heartbeat and /api/external-play/mcp)
      const httpCalls = [];
      for (let i = 0; i < 20; i++) {
        httpCalls.push(
          httpRequest(`${httpBaseUrl}/api/external-play/lease/heartbeat`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${ctrl.rawToken}`,
              "Host": `127.0.0.1:${httpPort}`
            },
            body: {
              run_id: run.runId,
              lease_id: claimRes.lease_id,
              lease_epoch: claimRes.lease_epoch
            }
          })
        );

        httpCalls.push(
          httpRequest(`${httpBaseUrl}/api/external-play/mcp`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${ctrl.rawToken}`,
              "Host": `127.0.0.1:${httpPort}`
            },
            body: {
              run_id: run.runId,
              lease_id: claimRes.lease_id,
              lease_epoch: claimRes.lease_epoch,
              tool: "rotate_camera_right",
              arguments: {},
              operation_id: `op-http-expired-${i}`
            }
          })
        );
      }

      const httpResponses = await Promise.all(httpCalls);
      assert.equal(httpResponses.length, 40);

      for (const resp of httpResponses) {
        assert.equal(resp.statusCode, 409, "HTTP 状态码必须全为 409");
        assert.ok(resp.body, "HTTP 响应必须有 JSON body");
        assert.equal(resp.body.code, "CONFLICT", "错误码必须为 CONFLICT");
        assert.match(resp.body.error, /expired/i, "错误提示必须包含 expired");
      }

      run.cleanup();
      recordPass("R3-4: HTTP 路由层 40 路并发 Heartbeat/Action 面对过期租约 100% 返回 409 CONFLICT");
    }

    // ============================================================================
    // SECTION 2: R5 对抗压力测试 (拒绝动作幂等性重试变异)
    // ============================================================================
    console.log("\n>>> [SECTION 2] R5: 被拒绝动作的高并发幂等重试与错误变异隔离测试");

    // ----------------------------------------------------------------------------
    // Test 5: 非法参数动作被拒后 50 路高并发同 operation_id 幂等重试 (Concurrent Rejection Idempotency)
    // ----------------------------------------------------------------------------
    {
      const ctrl = await newController("ctrl-r5-reject-concurrency");
      const run = await service.createRun({ maxActions: 100 });
      const lease = await service.claimRun(ctrl, { model_name: "R5-Tester-1" });

      const opId = "op-r5-concurrent-invalid-arg-1";

      // 首次执行：非法参数触发拒绝 (go_to_level 参数需要 x 与 y 单字母)
      const firstResult = await run.executeAction(
        ctrl,
        lease.lease_id,
        lease.lease_epoch,
        "go_to_level",
        { invalid_field: 12345 },
        opId
      );

      assert.ok(firstResult, "初次被拒绝响应必须非空");
      assert.equal(firstResult.isError, true, "初次响应 isError 必须为 true");
      assert.equal(firstResult.resultType, "complete", "resultType 必须为 complete");
      assert.ok(Array.isArray(firstResult.content) && firstResult.content.length > 0, "content 必须为非空数组");

      // 并发发射 50 个完全相同的重试请求
      const CONCURRENCY = 50;
      const retryPromises = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        retryPromises.push(
          run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            "go_to_level",
            { invalid_field: 12345 },
            opId
          )
        );
      }

      const retryResults = await Promise.all(retryPromises);
      assert.equal(retryResults.length, CONCURRENCY);

      for (let i = 0; i < CONCURRENCY; i++) {
        const res = retryResults[i];
        assert.ok(res !== undefined && res !== null, `重试 ${i} 绝不能返回 undefined 或 null`);
        assert.deepEqual(res, firstResult, `重试 ${i} 必须与初次拒绝响应完全 deepEqual 一致`);
        assert.equal(res.isError, true, `重试 ${i} isError 必须为 true`);
      }

      // 验证权威 WAL 记录：只能有 1 条该 operation_id 的 action_rejected 记录
      const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
      const matchedRecords = journalLines.filter((r) => r.operation_id === opId);
      assert.equal(matchedRecords.length, 1, "WAL 中必须有且仅有 1 条 action_rejected 记录，绝不产生重复序号");
      assert.equal(matchedRecords[0].type, "action_rejected");
      assert.equal(validateJournalRecord(matchedRecords[0]), true, "记录必须通过 JSON schema 校验");

      run.cleanup();
      recordPass("R5-1: 非法参数被拒动作 50 路高并发重试 100% 返回一致结构化错误，WAL 仅一条记录");
    }

    // ----------------------------------------------------------------------------
    // Test 6: 初次执行与重试并发竞争风暴 (Race on First Execution & Retries)
    // ----------------------------------------------------------------------------
    {
      const ctrl = await newController("ctrl-r5-initial-race");
      const run = await service.createRun({ maxActions: 100 });
      const lease = await service.claimRun(ctrl, { model_name: "R5-Tester-2" });

      const opId = "op-r5-first-exec-storm";

      // 不等待初次完成，同时发起 30 个相同 operation_id 的非法动作请求
      const CONCURRENCY = 30;
      const stormPromises = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        stormPromises.push(
          run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            "action_sequence",
            { actions: "NOT_AN_ARRAY" }, // 非法参数
            opId
          )
        );
      }

      const stormResults = await Promise.all(stormPromises);
      assert.equal(stormResults.length, CONCURRENCY);

      const baseline = stormResults[0];
      assert.ok(baseline, "基准响应必须非空");
      assert.equal(baseline.isError, true, "基准响应 isError 必须为 true");

      for (let i = 1; i < CONCURRENCY; i++) {
        assert.deepEqual(stormResults[i], baseline, `并发竞争请求 ${i} 必须与基准响应完全一致`);
      }

      // WAL 中必须只有 1 条记录
      const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
      const matched = journalLines.filter((r) => r.operation_id === opId);
      assert.equal(matched.length, 1, "初次并发抢锁风暴下 WAL 必须只有一条记录");

      run.cleanup();
      recordPass("R5-2: 初次执行与重试 30 路同时抢锁，锁内串行提交与幂等命中完全平滑");
    }

    // ----------------------------------------------------------------------------
    // Test 7: HTTP 端到端真实路由被拒绝重试——杜绝空 200 (HTTP End-to-End Empty 200 Prevention)
    // ----------------------------------------------------------------------------
    {
      const run = await service.createRun({ maxActions: 100 });
      const ctrl = await newController("ctrl-r5-http-empty-200");
      const claimRes = await service.claimRun(ctrl, { model_name: "HTTP-R5-Client" });

      const opId = "op-http-reject-prevent-empty-200";

      // 1. 发起初次非法动作 (POST to /api/external-play/mcp)
      const firstResp = await httpRequest(`${httpBaseUrl}/api/external-play/mcp`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ctrl.rawToken}`,
          "Host": `127.0.0.1:${httpPort}`
        },
        body: {
          run_id: run.runId,
          lease_id: claimRes.lease_id,
          lease_epoch: claimRes.lease_epoch,
          tool: "go_to_level",
          arguments: { bad: "args" },
          operation_id: opId
        }
      });

      assert.equal(firstResp.statusCode, 200, "MCP 协议层拒绝在 HTTP 层应返回 200 携带 isError");
      assert.ok(firstResp.rawBody && firstResp.rawBody.length > 0, "HTTP 响应体绝对不可为空");
      assert.ok(firstResp.body, "响应体必须能成功解析为 JSON");
      assert.equal(firstResp.body.isError, true, "初次 HTTP 响应 body.isError 必须为 true");

      // 2. 发起 30 路并发幂等重试
      const RETRY_CONCURRENCY = 30;
      const retryCalls = [];
      for (let i = 0; i < RETRY_CONCURRENCY; i++) {
        retryCalls.push(
          httpRequest(`${httpBaseUrl}/api/external-play/mcp`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${ctrl.rawToken}`,
              "Host": `127.0.0.1:${httpPort}`
            },
            body: {
              run_id: run.runId,
              lease_id: claimRes.lease_id,
              lease_epoch: claimRes.lease_epoch,
              tool: "go_to_level",
              arguments: { bad: "args" },
              operation_id: opId
            }
          })
        );
      }

      const retryResponses = await Promise.all(retryCalls);
      assert.equal(retryResponses.length, RETRY_CONCURRENCY);

      for (let i = 0; i < RETRY_CONCURRENCY; i++) {
        const resp = retryResponses[i];
        assert.equal(resp.statusCode, 200, `重试 ${i} HTTP 状态码必须为 200`);
        assert.ok(resp.rawBody && resp.rawBody.length > 0, `重试 ${i} HTTP rawBody 绝对不可为空字符串或 0 字节`);
        assert.ok(resp.body, `重试 ${i} 必须能被解析为 JSON 对象，绝不能是 null/undefined`);
        assert.equal(resp.body.isError, true, `重试 ${i} body.isError 必须为 true`);
        assert.deepEqual(resp.body, firstResp.body, `重试 ${i} 返回内容必须与初次响应完全一致`);
      }

      run.cleanup();
      recordPass("R5-3: HTTP 真实路由 30 路并发重试返回完整 JSON 响应，彻底杜绝 undefined 空 200");
    }

    // ----------------------------------------------------------------------------
    // Test 8: 拒绝动作幂等性参数变异与跨 Controller 错误隔离 (Mutation & Isolation)
    // ----------------------------------------------------------------------------
    {
      const ctrlA = await newController("ctrl-r5-isolation-A");
      const ctrlB = await newController("ctrl-r5-isolation-B");
      const run = await service.createRun({ maxActions: 100 });
      const lease = await service.claimRun(ctrlA, { model_name: "Isolation-A" });

      const opIdMutate = "op-r5-mutate-test";

      // 1. Controller A 触发非法操作
      await run.executeAction(
        ctrlA,
        lease.lease_id,
        lease.lease_epoch,
        "go_to_level",
        { invalid: "param1" },
        opIdMutate
      );

      // 变异测试 1: 同一 Controller，相同 opId，但更改参数 arguments
      await assert.rejects(
        async () => {
          await run.executeAction(
            ctrlA,
            lease.lease_id,
            lease.lease_epoch,
            "go_to_level",
            { invalid: "DIFFERENT_PARAM" },
            opIdMutate
          );
        },
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, "IDEMPOTENCY_CONFLICT");
          return true;
        },
        "改变 arguments 必须返回 409 IDEMPOTENCY_CONFLICT"
      );

      // 变异测试 2: 同一 Controller，相同 opId，但更改工具 tool
      await assert.rejects(
        async () => {
          await run.executeAction(
            ctrlA,
            lease.lease_id,
            lease.lease_epoch,
            "rotate_camera_right",
            {},
            opIdMutate
          );
        },
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, "IDEMPOTENCY_CONFLICT");
          return true;
        },
        "改变 tool 必须返回 409 IDEMPOTENCY_CONFLICT"
      );

      // 跨 Controller 隔离测试 3: Controller B 试图使用 Controller A 的 opIdMutate
      await assert.rejects(
        async () => {
          await run.executeAction(
            ctrlB,
            lease.lease_id,
            lease.lease_epoch,
            "go_to_level",
            { invalid: "param1" },
            opIdMutate
          );
        },
        (err) => {
          // Controller B 不是当前租约持有者，抛出 lease error 或 IDEMPOTENCY_CONFLICT
          assert.equal(err.status, 409);
          return true;
        },
        "跨 Controller 调用必须返回 409 CONFLICT"
      );

      run.cleanup();
      recordPass("R5-4: 参数变异 (arguments/tool) 严格返回 409 IDEMPOTENCY_CONFLICT，跨 Controller 隔离完整");
    }

    // ----------------------------------------------------------------------------
    // Test 9: 历史未存储 sanitized_result 的极端回放容错重试 (Legacy Fallback Concurrency)
    // ----------------------------------------------------------------------------
    {
      const ctrl = await newController("ctrl-r5-legacy-fallback");
      const run = await service.createRun({ maxActions: 100 });
      const lease = await service.claimRun(ctrl, { model_name: "Legacy-R5" });

      const opIdLegacy = "op-legacy-rejected-no-sanitized";

      // 模拟旧版本崩溃前写入的 WAL 记录（缺少 sanitized_result 字段）
      const legacyRecord = {
        journal_seq: run.lastJournalSeq + 1,
        timestamp: new Date().toISOString(),
        run_id: run.runId,
        type: "action_rejected",
        operation_id: opIdLegacy,
        request_fingerprint: crypto.createHash("sha256").update(JSON.stringify({ tool: "go_to_level", args: { bad: 1 } })).digest("hex"),
        controller_id: ctrl.controllerId,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        event_id: run.lastEventId + 1,
        tool: "go_to_level",
        arguments: { bad: 1 },
        error_payload: {
          code: "INVALID_ARGUMENT",
          message: "Legacy rejection reason"
        }
        // 故意不包含 sanitized_result 和 final_response
      };

      await run.appendJournalRecord(legacyRecord);

      // 模拟 20 路并发对此历史记录发起幂等重试
      const CONCURRENCY = 20;
      const fallbackPromises = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        fallbackPromises.push(
          run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            "go_to_level",
            { bad: 1 },
            opIdLegacy
          )
        );
      }

      const fallbackResults = await Promise.all(fallbackPromises);
      assert.equal(fallbackResults.length, CONCURRENCY);

      for (let i = 0; i < CONCURRENCY; i++) {
        const res = fallbackResults[i];
        assert.ok(res !== undefined, `Fallback ${i} 绝不能返回 undefined`);
        assert.equal(res.isError, true, `Fallback ${i} isError 必须为 true`);
        assert.equal(res.resultType, "complete");
        assert.ok(Array.isArray(res.content) && res.content.length > 0);
        const parsed = JSON.parse(res.content[0].text);
        assert.equal(parsed.error, "Legacy rejection reason");
        assert.equal(parsed.ok, false);
      }

      run.cleanup();
      recordPass("R5-5: 历史缺失 sanitized_result 的老旧记录回放后，20 路并发重试均成功降级构造结构化错误");
    }

    console.log("\n================================================================================");
    console.log(`Summary: ${passedTests} / ${totalTests} adversarial stress scenarios PASSED.`);
    console.log("================================================================================\n");

  } finally {
    // 关闭 HTTP 服务器并清理临时目录
    await new Promise((res) => httpServer.close(res));
    try {
      fs.rmSync(testDataHome, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  }
}

runAdversarialStressSuite().catch((err) => {
  console.error("Adversarial stress test failed:", err);
  process.exit(1);
});
