const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  ExternalPlayService,
  RunInstance,
  SummaryBuilder,
  assertSummaryInvariants,
  resolveDataHome,
  assertIsolation,
  mapToolToMessage,
  sanitizeObservationForMcp,
  extractViewerState,
  buildViewerTransition,
  buildSanitizedStatus
} = require("../server/external-play");
const {
  validateJournalRecord,
  validateActionRecord,
  validateViewerState,
  validateSummary,
  computeViewerStateHash
} = require("../shared/validators.standalone");
const { createRequestRouter } = require("../server/router");

async function runTests() {
  console.log("Starting ExternalPlayService unit & integration tests...");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-test-home-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  try {
    const preStartSummary = SummaryBuilder.buildSummary({
      runId: "ext-00000000-0000-4000-8000-000000000000",
      startedAt: null,
      status: "finalizing",
      manifest: { created_at: new Date().toISOString() },
      gameSession: null,
      winThreshold: 10,
      lastActionSeq: 0,
      declaredCli: null,
      currentLease: null
    }, "cancelled");
    assert.equal(preStartSummary.started_at, null);
    assert.equal(preStartSummary.rooms_visited, 0);
    assert.deepEqual(preStartSummary.progress_curve, [{ action_seq: 0, gems: 0, rooms: 0 }]);
    assert.throws(
      () => assertSummaryInvariants({ ...preStartSummary, gems_collected: 101 }),
      /gems_collected/
    );
    assert.throws(
      () => assertSummaryInvariants({
        ...preStartSummary,
        started_at: new Date(Date.now() + 1000).toISOString(),
        elapsed_seconds: 0,
        rooms_visited: 1,
        progress_curve: [{ action_seq: 0, gems: 0, rooms: 1 }]
      }),
      /ended_at/
    );

    // 1. Isolation assertion test
    console.log("  [Test 1] Path isolation assertions");
    assert.doesNotThrow(() => {
      assertIsolation(path.join(testDataHome, "external-runs"), testDataHome);
      assertIsolation(path.join(testDataHome, "server.json"), testDataHome);
    });

    assert.throws(() => {
      assertIsolation(path.resolve(__dirname, "..", "server.json"), testDataHome);
    }, /Isolation assertion failed/);

    // 2. Initialize service without creating a run record
    console.log("  [Test 2] Service initialization stays idle until manual run creation");
    const service = new ExternalPlayService({ port: 3001, defaultMaxActions: 3 });
    await service.initialize();

    assert.equal(service.serviceState, "READY");
    assert.equal(service.activeRunId, null);
    assert.equal(service.runs.size, 0);
    assert.deepEqual(fs.readdirSync(service.runsDir), []);

    const idleServerJson = JSON.parse(fs.readFileSync(service.serverJsonPath, "utf8"));
    assert.equal(idleServerJson.active_run_id, null);

    const initialRun = await service.createRun({ maxActions: 3 });
    assert.equal(service.activeRunId, initialRun.runId);
    assert.ok(initialRun.runId.startsWith("ext-"));

    assert.ok(initialRun);
    assert.equal(initialRun.status, "armed");
    assert.equal(initialRun.lastJournalSeq, 1);
    await assert.rejects(initialRun.observe(), { status: 409, code: "CONFLICT" });

    // Verify server.json written with all required fields
    assert.ok(fs.existsSync(service.serverJsonPath));
    const serverJson = JSON.parse(fs.readFileSync(service.serverJsonPath, "utf8"));
    assert.equal(serverJson.active_run_id, service.activeRunId);
    assert.equal(serverJson.instance_id, service.instanceId);
    assert.equal(serverJson.port, 3001);
    assert.ok(serverJson.url);
    assert.ok(serverJson.pid);
    assert.equal(serverJson.bootstrap_nonce, undefined);
    assert.ok(serverJson.mcp_bootstrap_nonce);

    // 3. Controller Session Nonce Rotation & Token TTL
    console.log("  [Test 3] Controller session nonce exchange and rotation");
    const oldMcpNonce = serverJson.mcp_bootstrap_nonce;
    const sessionRes = await service.handleControllerSession(oldMcpNonce, { name: "test-client" });
    assert.ok(sessionRes.controller_token);
    assert.ok(sessionRes.controller_id.startsWith("test-client"));
    assert.equal(sessionRes.instance_id, service.instanceId);

    // Verify nonce rotated in server.json
    const updatedServerJson = JSON.parse(fs.readFileSync(service.serverJsonPath, "utf8"));
    assert.notEqual(updatedServerJson.mcp_bootstrap_nonce, oldMcpNonce);

    // Old nonce must now fail
    await assert.rejects(async () => {
      await service.handleControllerSession(oldMcpNonce);
    }, { status: 403 });

    // 4. Start Run: armed -> active
    console.log("  [Test 4] Claim and start run (armed -> active)");
    const controllerInfo = service.validateControllerToken(`Bearer ${sessionRes.controller_token}`);
    assert.ok(controllerInfo);

    const startRes = await initialRun.startOrAttach(controllerInfo, "op-start-1", null, { modelName: "Test Model" });
    assert.equal(startRes.status, "active");
    assert.equal(startRes.lease_epoch, 1);
    assert.ok(startRes.lease_id);
    assert.equal(initialRun.status, "active");
    assert.ok(initialRun.startedAt);
    assert.equal(initialRun.deadlineAt, null);
    assert.equal(initialRun.deadlineMonotonicMs, null);
    assert.equal(initialRun.maxActions, 3);
    assert.equal(startRes.max_actions, 3);
    assert.equal(initialRun.lastJournalSeq, 2);

    // Deduplication test: re-calling start with same op-id returns cached response
    const dupStartRes = await initialRun.startOrAttach(controllerInfo, "op-start-1");
    assert.deepEqual(dupStartRes, startRes);

    // Second controller attaching while active lease is held returns 409
    const secondCtrl = { controllerId: "ctrl-2", declaredCli: "other" };
    await assert.rejects(async () => {
      await initialRun.startOrAttach(secondCtrl, "op-start-2");
    }, { status: 409 });

    // 5. Heartbeat & In-memory renewal
    console.log("  [Test 5] Lease heartbeat and renewal");
    const hbRes = await initialRun.heartbeat(controllerInfo, startRes.lease_id, startRes.lease_epoch);
    assert.ok(hbRes.ok);
    assert.ok(hbRes.lease_expires_at);

    // Stale epoch heartbeat rejected
    await assert.rejects(async () => {
      await initialRun.heartbeat(controllerInfo, startRes.lease_id, 999);
    }, { status: 409 });

    // 6. Action Execution: move, camera, undo & Viewer Transition
    console.log("  [Test 6] Action execution and state progression");
    const moveRes = await initialRun.executeAction(
      controllerInfo,
      startRes.lease_id,
      startRes.lease_epoch,
      "down",
      {},
      "op-move-1"
    );
    assert.equal(moveRes.isError, false);
    assert.equal(JSON.parse(moveRes.content[0].text).ended, false);
    assert.equal(initialRun.lastActionSeq, 1);
    assert.equal(initialRun.lastJournalSeq, 3);
    const firstActionRecord = JSON.parse(fs.readFileSync(initialRun.actionsPath, "utf8").trim().split("\n")[0]);
    assert.ok(
      firstActionRecord.viewer_transition.actor_deltas.every((delta) => /:actor:\d+$/.test(delta.id)),
      "all actor deltas, including the player, must use canonical viewer actor IDs"
    );

    // External Play treats gems as score only. Its sanitized observation does
    // not expose the engine's legacy 100-gem terminal signal.
    assert.equal(sanitizeObservationForMcp({ game_won: true }).game_won, false);
    const rotateRes = await initialRun.executeAction(
      controllerInfo,
      startRes.lease_id,
      startRes.lease_epoch,
      "rotate_camera_right",
      {},
      "op-cam-1"
    );
    assert.equal(rotateRes.isError, false);
    const rotatePayload = JSON.parse(rotateRes.content[0].text);
    assert.equal(rotatePayload.game_won, false);
    assert.equal(rotatePayload.ended, false);
    assert.equal(initialRun.lastActionSeq, 2);
    assert.equal(initialRun.lastJournalSeq, 4);

    // 7. Observe two-phase protocol
    console.log("  [Test 7] Two-phase lock-free observe protocol");
    const obsRes = await initialRun.observe();
    assert.equal(obsRes.status, "active");
    assert.equal(obsRes.action_seq, 2);
    assert.ok(obsRes.viewer_state_hash);
    assert.equal(obsRes.viewer_state_hash.length, 64);

    // A reader must fail closed if the journal watermark advances without the
    // projection becoming visible within the bounded wait.
    const projectedBeforeLagProbe = initialRun.projectedJournalSeq;
    initialRun.projectedJournalSeq = initialRun.lastJournalSeq - 1;
    await assert.rejects(
      initialRun.observe(),
      (error) => error?.status === 503 && error?.code === "PROJECTION_LAG"
    );
    assert.equal(initialRun.watermarkWaiters.length, 0, "timed-out projection waiters must be removed");
    initialRun.projectedJournalSeq = projectedBeforeLagProbe;

    // 8. Action Rejection (invalid tool & illegal goto)
    console.log("  [Test 8] Action rejection handling");
    const badToolRes = await initialRun.executeAction(
      controllerInfo,
      startRes.lease_id,
      startRes.lease_epoch,
      "invalid_tool_name",
      {},
      "op-bad-1"
    );
    assert.equal(badToolRes.isError, true);
    assert.equal(initialRun.lastJournalSeq, 5);

    const badGotoRes = await initialRun.executeAction(
      controllerInfo,
      startRes.lease_id,
      startRes.lease_epoch,
      "go_to_level",
      { x: "Z", y: "Z" }, // unvisited room
      "op-bad-goto"
    );
    assert.equal(badGotoRes.isError, true);
    assert.equal(initialRun.lastJournalSeq, 6);

    // 9. SSE Subscriber Delivery Verification (including terminal ended event)
    console.log("  [Test 9] SSE subscriber live broadcast and terminal ended delivery");
    let deliveredEnded = false;
    let deliveredAction = false;
    const mockSubscriber = {
      write(chunk) {
        if (chunk.includes("event: ended")) deliveredEnded = true;
        if (chunk.includes("event: action")) deliveredAction = true;
      },
      end() {}
    };
    initialRun.subscribers.add(mockSubscriber);

    // 10. The final allowed action returns ended=true and finalizes the run.
    console.log("  [Test 10] Action limit finalization and summary invariants");
    const limitRes = await initialRun.executeAction(
      controllerInfo,
      startRes.lease_id,
      startRes.lease_epoch,
      "rotate_camera_left",
      {},
      "op-action-limit"
    );
    const limitPayload = JSON.parse(limitRes.content[0].text);
    assert.equal(limitPayload.ended, true);
    assert.equal(limitPayload.action_seq, 3);
    assert.equal(limitPayload.actions_remaining, 0);
    // Wait briefly for finalize worker
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(initialRun.status, "action_limit");
    assert.ok(deliveredEnded, "ended SSE event must be delivered to subscriber before connection close");
    assert.ok(fs.existsSync(initialRun.summaryPath));

    const summaryContent = JSON.parse(fs.readFileSync(initialRun.summaryPath, "utf8"));
    assert.equal(summaryContent.outcome, "action_limit");
    assert.equal(summaryContent.run_id, initialRun.runId);
    assert.ok(validateSummary(summaryContent));

    // Summary programmatic invariants:
    assert.ok(summaryContent.gems_collected >= 0 && summaryContent.gems_collected <= summaryContent.gems_total);
    assert.ok(summaryContent.rooms_visited >= 1);
    assert.ok(summaryContent.actions_total >= 2);
    assert.ok(summaryContent.progress_curve.length >= 2);
    assert.equal(service.activeRunId, null, "a finished run must not remain active");

    // Post-finalization mutations must be rejected
    await assert.rejects(async () => {
      await initialRun.executeAction(controllerInfo, startRes.lease_id, startRes.lease_epoch, "up", {}, "op-post-term");
    }, { status: 409 });

    // 11. Server Restart Recovery & Sequence Continuity
    console.log("  [Test 11] Server restart recovery, journal replay and multi-run quarantine");
    service.shutdown();

    // Verify journal file on disk has strict consecutive seqs 1..N
    const journalLines = fs.readFileSync(initialRun.journalPath, "utf8").trim().split("\n").map(JSON.parse);
    const seqs = journalLines.map((r) => r.journal_seq);
    for (let i = 0; i < seqs.length; i++) {
      assert.equal(seqs[i], i + 1, `Journal sequence must be contiguous at index ${i}`);
    }

    const authoritativeActionLines = fs.readFileSync(initialRun.actionsPath, "utf8")
      .trim()
      .split("\n");
    assert.ok(authoritativeActionLines.length >= 2);
    fs.writeFileSync(
      initialRun.actionsPath,
      `${authoritativeActionLines[0]}\n${authoritativeActionLines[1].slice(0, -8)}`,
      "utf8"
    );

    const restartedService = new ExternalPlayService({ port: 3002 });
    await restartedService.initialize();

    assert.equal(restartedService.serviceState, "READY");
    assert.equal(restartedService.activeRunId, null, "restart must not create a replacement run");
    assert.equal(restartedService.runs.size, 1, "restart must recover history without adding records");

    const recoveredRun = restartedService.getRun(initialRun.runId);
    assert.ok(recoveredRun);
    assert.ok(recoveredRun.baseViewerState, "baseViewerState must not be null after restart");
    assert.ok(recoveredRun.baseViewerStateDigest, "baseViewerStateDigest must be preserved after restart");
    assert.ok(fs.existsSync(recoveredRun.actionsPath), "actionsPath must exist on disk after restart");
    assert.equal(recoveredRun.declaredCli, "test-client", "declaredCli must be recovered after restart");
    assert.deepEqual(
      fs.readFileSync(recoveredRun.actionsPath, "utf8").trim().split("\n"),
      authoritativeActionLines,
      "restart must rebuild a partial actions.jsonl tail from the authoritative WAL"
    );

    restartedService.shutdown();

    const sameSeqTamper = JSON.parse(authoritativeActionLines[1]);
    sameSeqTamper.command_text = "tampered-but-parseable";
    fs.writeFileSync(
      recoveredRun.actionsPath,
      `${authoritativeActionLines[0]}\n${JSON.stringify(sameSeqTamper)}\n`,
      "utf8"
    );
    const contentRecoveryService = new ExternalPlayService({ port: 3004 });
    await contentRecoveryService.initialize();
    try {
      const contentRecoveredRun = contentRecoveryService.getRun(initialRun.runId);
      assert.deepEqual(
        fs.readFileSync(contentRecoveredRun.actionsPath, "utf8").trim().split("\n"),
        authoritativeActionLines,
        "matching sequence numbers must not hide tampered action content"
      );
    } finally {
      contentRecoveryService.shutdown();
    }

    // 12. Deadline/action race: both contenders share the session lock and
    // must produce exactly one terminal intent with no post-deadline action.
    console.log("  [Test 12] Deadline boundary race is single-winner and fail-closed");
    const raceDataHome = path.join(testDataHome, "deadline-race");
    const raceService = new ExternalPlayService({ dataHome: raceDataHome, port: 3003 });
    await raceService.initialize();
    try {
      const raceRun = await raceService.createRun({ durationMs: 60000 });
      const raceControllerSession = await raceService.handleControllerSession(
        raceService.mcpBootstrapNonce,
        { name: "deadline-race-client" }
      );
      const raceController = raceService.validateControllerToken(`Bearer ${raceControllerSession.controller_token}`);
      const raceStart = await raceRun.startOrAttach(raceController, "race-start", null, { modelName: "Race Model" });

      const preservedDeadline = raceStart.deadline_at;
      if (raceRun.leaseTimer) clearTimeout(raceRun.leaseTimer);
      raceRun.leaseTimer = null;
      raceRun.currentLease.expiresAt = Date.now() - 1;
      const takeoverSession = await raceService.handleControllerSession(
        raceService.mcpBootstrapNonce,
        { name: "deadline-race-takeover" }
      );
      const takeoverController = raceService.validateControllerToken(`Bearer ${takeoverSession.controller_token}`);
      const takeover = await raceRun.attachApprovedLease(takeoverController, "req-test-12", false, "race-takeover");
      assert.equal(takeover.lease_epoch, raceStart.lease_epoch + 1);
      assert.equal(takeover.deadline_at, preservedDeadline, "lease takeover must not reset the run deadline");
      const takeoverJournal = fs.readFileSync(raceRun.journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        takeoverJournal.slice(-2).map((record) => [record.type, record.reason || null]),
        [["lease_revoked", "authorized_resumption"], ["lease_attached", null]]
      );

      if (raceRun.deadlineTimer) clearTimeout(raceRun.deadlineTimer);
      raceRun.deadlineTimer = null;
      raceRun.deadlineAt = new Date(Date.now() - 1).toISOString();

      const contenders = await Promise.allSettled([
        raceRun.executeAction(
          takeoverController,
          takeover.lease_id,
          takeover.lease_epoch,
          "down",
          {},
          "race-action"
        ),
        raceRun._handleDeadlineTimeout()
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(raceRun.status, "timed_out");
      assert.equal(raceRun.lastActionSeq, 0, "an action at or after the deadline must not commit");
      const raceJournal = fs.readFileSync(raceRun.journalPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(raceJournal.filter((record) => record.type === "finalize_intent").length, 1);
      assert.equal(raceJournal.filter((record) => record.type === "action_committed").length, 0);
      assert.ok(
        contenders.some((result) => result.status === "fulfilled"),
        "at least one deadline contender must complete normally"
      );
    } finally {
      raceService.shutdown();
    }

    console.log("  [Test 13] Finalize worker failure persists a terminal run_failed record");
    const failureDataHome = path.join(testDataHome, "finalize-failure");
    const failureService = new ExternalPlayService({ dataHome: failureDataHome, port: 3005 });
    await failureService.initialize();
    try {
      const failureRun = await failureService.createRun();
      const failureControllerSession = await failureService.handleControllerSession(
        failureService.mcpBootstrapNonce,
        { name: "finalize-failure-client" }
      );
      const failureController = failureService.validateControllerToken(`Bearer ${failureControllerSession.controller_token}`);
      await failureRun.startOrAttach(failureController, "failure-start", null, { modelName: "Failure Model" });
      failureRun._writeSummaryAtomically = () => {
        throw new Error("synthetic summary storage failure");
      };
      await failureRun._startFinalize("cancelled", "exercise failure terminal path");
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(failureRun.status, "failed");
      const failureJournal = fs.readFileSync(failureRun.journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failedRecord = failureJournal.find((record) => record.type === "run_failed");
      assert.ok(failedRecord);
      assert.match(failedRecord.partial_summary_digest, /^[0-9a-f]{64}$/);
      assert.equal(failedRecord.final_response.outcome, "failed");
      assert.equal(failureService.activeRunId, null);
    } finally {
      failureService.shutdown();
    }

    // 14. max_actions, legacy duration, and win_threshold parameter bounds
    console.log("  [Test 14] Action, legacy duration, and win_threshold strict bounds validation");
    const paramDataHome = path.join(testDataHome, "param-validation");
    const paramService = new ExternalPlayService({ dataHome: paramDataHome, port: 3006 });
    await paramService.initialize();
    try {
      // Invalid durationMs (< 60000, > 21600000, float, string, negative)
      for (const invalidDuration of [59999, 0, -1000, 21600001, 100000.5, "60000", NaN, null, false]) {
        await assert.rejects(
          paramService.createRun({ durationMs: invalidDuration }),
          (err) => err?.status === 400 && err?.code === "INVALID_ARGUMENT",
          `durationMs ${invalidDuration} must be rejected with 400 INVALID_ARGUMENT`
        );
      }

      for (const invalidMaxActions of [0, -1, 100001, 10.5, "256", NaN, null, false]) {
        await assert.rejects(
          paramService.createRun({ maxActions: invalidMaxActions }),
          (err) => err?.status === 400 && err?.code === "INVALID_ARGUMENT",
          `maxActions ${invalidMaxActions} must be rejected with 400 INVALID_ARGUMENT`
        );
      }

      // Invalid winThreshold (< 1, > 100, float, string, negative)
      for (const invalidThreshold of [0, -1, 101, 10.5, "10", NaN, null, false]) {
        await assert.rejects(
          paramService.createRun({ winThreshold: invalidThreshold }),
          (err) => err?.status === 400 && err?.code === "INVALID_ARGUMENT",
          `winThreshold ${invalidThreshold} must be rejected with 400 INVALID_ARGUMENT`
        );
      }
    } finally {
      paramService.shutdown();
    }

    // 15. Atomic replacement of an unclaimed manually created armed run
    console.log("  [Test 15] Atomic replacement of an unclaimed manual armed run");
    const replaceDataHome = path.join(testDataHome, "atomic-replace");
    const replaceService = new ExternalPlayService({ dataHome: replaceDataHome, port: 3007 });
    await replaceService.initialize();
    try {
      const oldArmedRun = await replaceService.createRun();
      const oldArmedRunId = oldArmedRun.runId;
      assert.ok(oldArmedRun);
      assert.equal(oldArmedRun.status, "armed");

      // Replace with custom duration (10 min = 600,000 ms) and win threshold (25 gems)
      const newRun = await replaceService.createRun({
        durationMs: 600000,
        winThreshold: 25
      });

      assert.notEqual(newRun.runId, oldArmedRunId);
      assert.equal(replaceService.activeRunId, newRun.runId);
      assert.equal(newRun.durationMs, 600000);
      assert.equal(newRun.winThreshold, 25);
      assert.equal(newRun.manifest.duration_ms, 600000);
      assert.equal(newRun.manifest.win_threshold, 25);

      // Verify server.json updated with new active_run_id
      const updatedServerJson = JSON.parse(fs.readFileSync(replaceService.serverJsonPath, "utf8"));
      assert.equal(updatedServerJson.active_run_id, newRun.runId);

      // Verify old run was finalized as cancelled with reason reconfigured_before_start
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(oldArmedRun.status, "cancelled");
      const oldJournal = fs.readFileSync(oldArmedRun.journalPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const intentRecord = oldJournal.find((r) => r.type === "finalize_intent");
      assert.ok(intentRecord);
      assert.equal(intentRecord.reason, "reconfigured_before_start");
      assert.equal(intentRecord.target_outcome, "cancelled");

      const finalizedRecord = oldJournal.find((r) => r.type === "run_finalized");
      assert.ok(finalizedRecord);
      assert.equal(finalizedRecord.outcome, "cancelled");

      // 16. A claimed run no longer blocks preparation of the next session.
      console.log("  [Test 16] Create next armed session while a claimed run remains active");
      const ctrlSession = await replaceService.handleControllerSession(replaceService.mcpBootstrapNonce, { name: "replace-test" });
      const ctrl = replaceService.validateControllerToken(`Bearer ${ctrlSession.controller_token}`);
      await newRun.startOrAttach(ctrl, "start-op-1", null, { modelName: "Replace Model" });
      assert.equal(newRun.status, "active");

      const nextRun = await replaceService.createRun({ durationMs: 120000 });
      assert.equal(nextRun.status, "armed");
      assert.equal(replaceService.activeRunId, nextRun.runId);

      // 17. A successful claim removes the run from the available queue.
      console.log("  [Test 17] Claimed run leaves the queue before the next session is created");
      const raceDataHome = path.join(testDataHome, "atomic-race");
      const raceService2 = new ExternalPlayService({ dataHome: raceDataHome, port: 3008 });
      await raceService2.initialize();
      try {
        const armedRun = await raceService2.createRun();
        const ctrlSession2 = await raceService2.handleControllerSession(raceService2.mcpBootstrapNonce, { name: "race-test-2" });
        const ctrl2 = raceService2.validateControllerToken(`Bearer ${ctrlSession2.controller_token}`);
        await armedRun.startOrAttach(ctrl2, "claim-op-1", null, { modelName: "Race Model 2" });

        const followingRun = await raceService2.createRun({ durationMs: 180000 });
        assert.notEqual(followingRun.runId, armedRun.runId);
        assert.equal(raceService2.activeRunId, followingRun.runId);
      } finally {
        raceService2.shutdown();
      }
    } finally {
      replaceService.shutdown();
    }

    // 18. Time-limited session lifecycle, durationMs preservation, and MCP time_remaining response
    console.log("  [Test 18] Time-limited session creation, durationMs preservation, and MCP time_remaining response");
    const timedDataHome = path.join(testDataHome, "timed-session");
    const timedService = new ExternalPlayService({ dataHome: timedDataHome, port: 3009 });
    await timedService.initialize();
    try {
      const timedRun = await timedService.createRun({ durationMs: 60000 });
      assert.equal(timedRun.maxActions, null);
      assert.equal(timedRun.durationMs, 60000);
      assert.equal(timedRun.status, "armed");

      const timedCtrlSession = await timedService.handleControllerSession(timedService.mcpBootstrapNonce, { name: "timed-test-client" });
      const timedCtrl = timedService.validateControllerToken(`Bearer ${timedCtrlSession.controller_token}`);

      const startRes = await timedRun.startOrAttach(timedCtrl, "timed-start-op", null, { modelName: "Timed Model" });
      assert.equal(startRes.status, "active");
      assert.ok(startRes.deadline_at);
      assert.equal(timedRun.maxActions, null);

      const startContent = JSON.parse(startRes.sanitized_result.content[0].text);
      assert.equal(startContent.duration_ms, 60000);
      assert.ok(startContent.deadline_at);
      assert.ok(typeof startContent.time_remaining_ms === "number" && startContent.time_remaining_ms > 0);

      const actRes = await timedRun.executeAction(timedCtrl, timedRun.currentLease.leaseId, timedRun.currentLease.leaseEpoch, "down", {}, "timed-act-1");
      assert.equal(actRes.isError, false);
      const actContent = JSON.parse(actRes.content[0].text);
      assert.equal(actContent.duration_ms, 60000);
      assert.ok(actContent.deadline_at);
      assert.ok(typeof actContent.time_remaining_ms === "number" && actContent.time_remaining_ms > 0);
    } finally {
      timedService.shutdown();
    }

    console.log("  [Test 19] Frozen world bundle drives initial state and restart recovery");
    const { buildGameWorldBundle } = require("../server/app");
    const frozenBundle = JSON.parse(JSON.stringify(buildGameWorldBundle("maze")));
    delete frozenBundle.worldRevision;
    const frozenStartState = frozenBundle.levelStates[frozenBundle.defaultLevelId];
    const frozenPlayer = frozenStartState.actors.find((actor) => actor.type === "player" || actor.type === "circle_player");
    assert.ok(frozenPlayer);
    const frozenPlayerX = (frozenPlayer.x + 1) % frozenStartState.width;
    frozenPlayer.x = frozenPlayerX;

    const frozenDataHome = path.join(testDataHome, "frozen-world");
    const frozenService = new ExternalPlayService({
      dataHome: frozenDataHome,
      port: 3010,
      worldBundleProvider: () => frozenBundle
    });
    await frozenService.initialize();
    let frozenRunId;
    try {
      const frozenRun = await frozenService.createRun({ maxActions: 3 });
      frozenRunId = frozenRun.runId;
      assert.equal(frozenRun.baseViewerState.current_room, frozenBundle.defaultLevelId);
      assert.equal(frozenRun.baseViewerState.player.x, frozenPlayerX);
    } finally {
      frozenService.shutdown();
    }

    const frozenRestart = new ExternalPlayService({ dataHome: frozenDataHome, port: 3011 });
    await frozenRestart.initialize();
    try {
      const recoveredFrozenRun = frozenRestart.getRun(frozenRunId);
      assert.ok(recoveredFrozenRun);
      assert.equal(recoveredFrozenRun.currentViewerState.current_room, frozenBundle.defaultLevelId);
      assert.equal(recoveredFrozenRun.currentViewerState.player.x, frozenPlayerX);
    } finally {
      frozenRestart.shutdown();
    }

    console.log("  [Test 20] Quarantine recovery cleans up timers without unhandled ENOENT");
    const test20DataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-test20-"));
    const test20InitService = new ExternalPlayService({ dataHome: test20DataHome, port: 3021, defaultMaxActions: null });
    await test20InitService.initialize();
    const test20Run = await test20InitService.createRun({ durationMs: 60000 });
    const test20Controller = await test20InitService.handleControllerSession(test20InitService.mcpBootstrapNonce, { name: "test20-ctrl" });
    const test20ControllerInfo = test20InitService.validateControllerToken(`Bearer ${test20Controller.controller_token}`);
    await test20Run.startOrAttach(test20ControllerInfo, "test20-start", null, { modelName: "test20-model" });
    test20InitService.shutdown();

    // Adjust journal seq 2 deadline_at to past (remaining <= 0) and append a corrupt line (seq 3)
    const test20JournalPath = path.join(test20DataHome, "external-runs", test20Run.runId, "journal.jsonl");
    const test20JournalLines = fs.readFileSync(test20JournalPath, "utf8").trim().split("\n");
    const test20StartedRecord = JSON.parse(test20JournalLines[1]);
    test20StartedRecord.deadline_at = new Date(Date.now() - 5000).toISOString();
    test20JournalLines[1] = JSON.stringify(test20StartedRecord);
    test20JournalLines.push("MALFORMED_JSON_LINE");
    fs.writeFileSync(test20JournalPath, test20JournalLines.join("\n") + "\n", "utf8");

    const test20Service = new ExternalPlayService({ dataHome: test20DataHome, port: 3021 });
    await test20Service.initialize();
    try {
      assert.equal(test20Service.serviceState, "READY");
      assert.equal(test20Service.getRun(test20Run.runId), null);
      assert.ok(fs.existsSync(path.join(test20DataHome, "external-quarantine", test20Run.runId)));
      // Wait past zero-delay deadline timeout to confirm no unhandled ENOENT crash happens
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(test20Service.serviceState, "READY");
    } finally {
      test20Service.shutdown();
      fs.rmSync(test20DataHome, { recursive: true, force: true });
    }

    console.log("  [Test 21] Clear active run failure does not corrupt child run summary");
    const test21Run = await service.createRun({ maxActions: 1 });
    const test21Controller = { controllerId: "ctrl-test21", declaredCli: "test21-harness" };
    const test21Start = await test21Run.startOrAttach(test21Controller, "test21-start", null, { modelName: "test21-model" });

    // Mock _clearActiveRun to throw an error simulating result.json storage failure
    const originalClear = service._clearActiveRun.bind(service);
    service._clearActiveRun = () => {
      throw new Error("Synthetic _clearActiveRun failure from groupStore");
    };

    try {
      await test21Run.executeAction(
        test21Controller,
        test21Start.lease_id,
        test21Start.lease_epoch,
        "rotate_camera_left",
        {},
        "test21-action"
      );
      const deadline = Date.now() + 3000;
      while (!["action_limit", "failed"].includes(test21Run.status)) {
        if (Date.now() > deadline) throw new Error("Test 21 timeout waiting for action_limit");
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(test21Run.status, "action_limit");
      const summaryContent = JSON.parse(fs.readFileSync(test21Run.summaryPath, "utf8"));
      assert.equal(summaryContent.outcome, "action_limit");
      assert.equal(summaryContent.is_partial, false);
      assert.equal(summaryContent.actions_total, 1);
    } finally {
      service._clearActiveRun = originalClear;
    }

    console.log("  [Test 22] Spectator page and API serve frozen level state");
    const { createPageRenderer } = require("../server/pages");
    const { createRequestRouter } = require("../server/router");

    const bundle22 = JSON.parse(JSON.stringify(buildGameWorldBundle("maze")));
    const defaultLevelId22 = bundle22.defaultLevelId;
    bundle22.levelStates[defaultLevelId22].levelLabel = "FROZEN_LEVEL_MARKER_TEST";

    const pageRenderer = createPageRenderer({
      capabilities: { external_play: true, local_mcp: true },
      getGame: () => ({ id: "maze", name: "Maze", worldMap: { levels: [{ id: defaultLevelId22 }] } }),
      getLevel: () => ({ id: defaultLevelId22, fileName: `${defaultLevelId22}.json` }),
      getLevelState: () => ({ width: 10, height: 10, levelLabel: "LIVE_LEAK_MARKER" }),
      buildAuthorPageData: () => ({ blockAdder: {}, defaultFloorToken: "F", existingLevels: [], game: { id: "maze" }, palette: [], toolboxCatalog: [] }),
      worldMaps: { defaultLevelIdForGame: () => defaultLevelId22 }
    });

    const frozenRunSample = await service.createRun({ maxActions: 1, frozenWorldBundle: bundle22 });
    const spectatorHtml = pageRenderer.renderExternalPlayRunPage(frozenRunSample);
    assert.ok(spectatorHtml.includes("/api/external-play/runs/" + encodeURIComponent(frozenRunSample.runId) + "/maze"));
    assert.ok(spectatorHtml.includes("FROZEN_LEVEL_MARKER_TEST"), "spectator page must use frozen level state");
    assert.ok(!spectatorHtml.includes("LIVE_LEAK_MARKER"), "spectator page must not use live getLevelState");

    let apiStatus = null;
    let apiJson = null;
    const mockReq = {
      method: "GET",
      url: `/api/external-play/runs/${encodeURIComponent(frozenRunSample.runId)}/maze/${encodeURIComponent(defaultLevelId22)}`,
      headers: { host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" },
      socket: { remoteAddress: "127.0.0.1" }
    };
    const mockRes = {
      writeHead(status) { apiStatus = status; },
      end(body) { if (body) apiJson = JSON.parse(body); }
    };
    const { handleRequest } = createRequestRouter({
      externalPlay: service,
      publicFileRoutes: new Map(),
      sendJson: (res, status, payload) => {
        res.writeHead(status);
        res.end(JSON.stringify(payload));
      },
      getLevelState: () => ({ width: 10, height: 10, levelLabel: "LIVE_LEAK_MARKER" }),
      getLevel: () => ({ id: defaultLevelId22 }),
      getGame: () => ({ id: "maze" })
    });
    await handleRequest(mockReq, mockRes);
    assert.equal(apiStatus, 200);
    assert.equal(apiJson.levelLabel, "FROZEN_LEVEL_MARKER_TEST");

    console.log("  [Test 23] External Play Claim & Auth Resume Spec Invariants");
    const test23DataHome = path.join(testDataHome, "claim-auth-invariants");
    const test23Service = new ExternalPlayService({ dataHome: test23DataHome, port: 3018, defaultMaxActions: 2 });
    await test23Service.initialize();
    try {
      const runA = await test23Service.createRun();
      const ctrlASession = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl-A" });
      const ctrlA = test23Service.validateControllerToken(`Bearer ${ctrlASession.controller_token}`);

      // 1. start strictly rejects run_id
      await assert.rejects(
        test23Service.claimRun(ctrlA, { model_name: "Model A", run_id: runA.runId }, "op-start-invalid"),
        (err) => err?.status === 400 && err?.code === "INVALID_ARGUMENT",
        "start with run_id must be rejected with 400 INVALID_ARGUMENT"
      );

      // 2. Normal claim
      const claimARes = await test23Service.claimRun(ctrlA, { model_name: "Model A" }, "op-start-A");
      assert.equal(claimARes.run_id, runA.runId);
      assert.equal(claimARes.status, "active");
      assert.equal(claimARes.lease_epoch, 1);

      // 3. Bound controller cannot claim another run while active
      await assert.rejects(
        test23Service.claimRun(ctrlA, { model_name: "Model A" }, "op-start-A2"),
        (err) => err?.status === 409 && err?.code === "ALREADY_BOUND"
      );

      // 4. Same operation_id retry returns exact cached result
      const retryARes = await test23Service.claimRun(ctrlA, { model_name: "Model A" }, "op-start-A");
      assert.deepEqual(retryARes, claimARes);

      // 5. Another controller attempts resume
      const ctrlBSession = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl-B" });
      const ctrlB = test23Service.validateControllerToken(`Bearer ${ctrlBSession.controller_token}`);

      const resumeReq = await test23Service.createResumeRequest(ctrlB, runA.runId);
      assert.equal(resumeReq.status, "pending_approval");
      assert.ok(resumeReq.request_id);

      // Since ctrlA's lease is currently active, ordinary approval without force must return 409 LEASE_ACTIVE
      await assert.rejects(
        test23Service.approveResumeRequest(resumeReq.request_id, { force: false }),
        (err) => err?.status === 409 && err?.code === "LEASE_ACTIVE",
        "approving active lease without force: true must return 409 LEASE_ACTIVE"
      );

      // Approving with force: true succeeds
      const approveRes = await test23Service.approveResumeRequest(resumeReq.request_id, { force: true });
      assert.equal(approveRes.status, "approved");

      const statusRes = await test23Service.getResumeRequestStatus(ctrlB, resumeReq.request_id);
      assert.equal(statusRes.status, "approved");
      assert.equal(statusRes.lease_epoch, 2);
      assert.notEqual(statusRes.lease_id, claimARes.lease_id);

      // WAL audit verification
      const runAJournal = fs.readFileSync(runA.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const revokeRec = runAJournal.find((r) => r.type === "lease_revoked" && r.controller_id === ctrlA.controllerId);
      assert.ok(revokeRec, "revoke record must exist for superseded controller");
      assert.equal(revokeRec.reason, "forced_takeover");

      const attachRec = runAJournal.find((r) => r.type === "lease_attached" && r.controller_id === ctrlB.controllerId);
      assert.ok(attachRec, "attach record must exist for new controller");
      assert.equal(attachRec.request_id, resumeReq.request_id);
      assert.equal(attachRec.previous_controller_id, ctrlA.controllerId);
      assert.equal(attachRec.forced, true);
      assert.equal(attachRec.lease_epoch, 2);

      // 6. Finalize runA and verify that ctrlA's old start retry on superseded lease is rejected and does NOT claim newly created runB
      await runA.cancelRun();
      while (runA.status === "finalizing") {
        await new Promise((r) => setTimeout(r, 10));
      }

      const runB = await test23Service.createRun();
      assert.notEqual(runB.runId, runA.runId);

      // Re-send op-start-A (retry of old operation on superseded lease):
      // Must reject with 409 CONFLICT (superseded/revoked) and NOT claim runB
      await assert.rejects(
        test23Service.claimRun(ctrlA, { model_name: "Model A" }, "op-start-A"),
        (err) => err?.status === 409 && err?.code === "CONFLICT",
        "Late retry on superseded lease must be rejected with 409 CONFLICT"
      );
      assert.equal(runB.status, "armed", "runB must remain armed and unclaimed");

      // 7. Test 24: Concurrent approval mutual exclusion & force takeover protection
      console.log("  [Test 24] Concurrent approval mutual exclusion & force protection");
      const run24 = await test23Service.createRun();
      const ctrl24SessionA = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl24-A" });
      const ctrl24A = test23Service.validateControllerToken(`Bearer ${ctrl24SessionA.controller_token}`);
      await test23Service.claimRun(ctrl24A, { model_name: "Model 24A" });

      // Two applicant controllers submit resume requests
      const ctrl24SessionB = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl24-B" });
      const ctrl24B = test23Service.validateControllerToken(`Bearer ${ctrl24SessionB.controller_token}`);
      const reqB = await test23Service.createResumeRequest(ctrl24B, run24.runId);

      const ctrl24SessionC = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl24-C" });
      const ctrl24C = test23Service.validateControllerToken(`Bearer ${ctrl24SessionC.controller_token}`);
      const reqC = await test23Service.createResumeRequest(ctrl24C, run24.runId);

      // Force ctrl24A lease to expire so an ordinary approval without force can succeed
      run24.currentLease.expiresAt = Date.now() - 1000;

      // Concurrently approve reqB and reqC with force: false
      const [resB, resC] = await Promise.allSettled([
        test23Service.approveResumeRequest(reqB.request_id, { force: false }),
        test23Service.approveResumeRequest(reqC.request_id, { force: false })
      ]);

      const fulfilled = [resB, resC].filter((r) => r.status === "fulfilled");
      const rejected = [resB, resC].filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "Exactly one ordinary approval must succeed");
      assert.equal(rejected.length, 1, "The competing ordinary approval must be rejected");
      assert.equal(rejected[0].reason.status, 409, "Rejected competitor must receive 409");
      assert.ok(
        rejected[0].reason.code === "LEASE_ACTIVE" || rejected[0].reason.code === "CONFLICT",
        `Rejected competitor must fail with LEASE_ACTIVE or CONFLICT, got: ${rejected[0].reason.code}`
      );
      assert.equal(run24.currentLease.leaseEpoch, 2, "Lease epoch must be exactly 2, not overwritten to 3");

      // 8. Test 25: Old controller binding cleared after takeover, freeing controller to claim next seat
      console.log("  [Test 25] Old controller binding is cleared upon takeover, freeing controller");
      const nextRun25 = await test23Service.createRun();
      const claim25Res = await test23Service.claimRun(ctrl24A, { model_name: "Model 24A-New" });
      assert.equal(claim25Res.run_id, nextRun25.runId, "Old controller must be able to claim a new run");
      assert.equal(claim25Res.status, "active");

      // 9. Test 26: Stale / invalidated applicant controller cannot be approved
      console.log("  [Test 26] Invalidated applicant controller is rejected during approval without revoking incumbent");
      const run26 = await test23Service.createRun();
      const ctrl26SessionIncumbent = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl26-incumbent" });
      const ctrl26Incumbent = test23Service.validateControllerToken(`Bearer ${ctrl26SessionIncumbent.controller_token}`);
      const incumbentClaim = await test23Service.claimRun(ctrl26Incumbent, { model_name: "Incumbent Model" });

      const ctrl26SessionApplicant = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl26-applicant" });
      const ctrl26Applicant = test23Service.validateControllerToken(`Bearer ${ctrl26SessionApplicant.controller_token}`);
      const req26 = await test23Service.createResumeRequest(ctrl26Applicant, run26.runId);

      // Invalidate applicant token
      test23Service.controllerTokens.delete(ctrl26SessionApplicant.controller_token);

      await assert.rejects(
        test23Service.approveResumeRequest(req26.request_id, { force: true }),
        (err) => err?.status === 410 && err?.code === "EXPIRED",
        "Approval must fail with 410 EXPIRED when applicant token is invalidated"
      );

      // Verify incumbent lease is untouched
      assert.equal(run26.currentLease.controllerId, ctrl26Incumbent.controllerId, "Incumbent lease must remain intact");
      assert.equal(run26.currentLease.leaseId, incumbentClaim.lease_id);
      assert.equal(run26.currentLease.leaseEpoch, 1);

      // 10. Test 27: Unbound and detached controller cannot observe a run
      console.log("  [Test 27] Unbound and detached controller cannot observe an un-leased or disconnected run");
      const run27 = await test23Service.createRun();
      const ctrl27Session = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "ctrl27" });
      const ctrl27 = test23Service.validateControllerToken(`Bearer ${ctrl27Session.controller_token}`);

      // Unbound controller trying to observe armed run
      await assert.rejects(
        run27.observe(ctrl27),
        (err) => err?.status === 409 && err?.code === "CONFLICT",
        "Observing armed run must be rejected"
      );

      // Start run, then detach lease (making currentLease null)
      await test23Service.claimRun(ctrl27, { model_name: "Model 27" });
      await run27.detach(ctrl27, run27.currentLease.leaseId, run27.currentLease.leaseEpoch);
      assert.equal(run27.currentLease, null, "Lease must be detached/null");

      // Another stranger controller tries to observe the disconnected run
      const strangerSession = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name: "stranger" });
      const stranger = test23Service.validateControllerToken(`Bearer ${strangerSession.controller_token}`);

      await assert.rejects(
        run27.observe(stranger),
        (err) => err?.status === 409 && err?.code === "CONFLICT",
        "Stranger controller cannot observe a disconnected run with null currentLease"
      );

      const newController = async (name) => {
        const session = await test23Service.handleControllerSession(test23Service.mcpBootstrapNonce, { name });
        return test23Service.validateControllerToken(`Bearer ${session.controller_token}`);
      };

      console.log("  [Test 28] Approval and claim serialize controller bindings in both orders");
      for (const first of ["approve", "claim"]) {
        const owner = await newController(`race-owner-${first}`);
        const applicant = await newController(`race-applicant-${first}`);
        const target = await test23Service.createRun({ maxActions: 100 });
        await test23Service.claimRun(owner, { model_name: "Race owner" });
        const req = await test23Service.createResumeRequest(applicant, target.runId);
        const spare = await test23Service.createRun({ maxActions: 100 });
        const approve = () => test23Service.approveResumeRequest(req.request_id, { force: true });
        const claim = () => test23Service.claimRun(applicant, { model_name: "Race applicant" });
        const blockedRun = first === "approve" ? target : spare;
        const method = first === "approve" ? "_attachApprovedLeaseLocked" : "start";
        const original = blockedRun[method];
        let entered;
        let release;
        const enteredPromise = new Promise((resolve) => { entered = resolve; });
        const gate = new Promise((resolve) => { release = resolve; });
        blockedRun[method] = async function (...args) {
          entered();
          await gate;
          return original.apply(this, args);
        };
        try {
          const firstResult = (first === "approve" ? approve() : claim());
          await enteredPromise;
          const secondResult = (first === "approve" ? claim() : approve());
          const settled = Promise.allSettled([firstResult, secondResult]);
          await new Promise((resolve) => setImmediate(resolve));
          release();
          const results = await settled;
          assert.equal(results[0].status, "fulfilled");
          assert.equal(results[1].status, "rejected");
          assert.ok(["ALREADY_BOUND", "IDENTITY_MISMATCH"].includes(results[1].reason.code));
          const owned = [target, spare].filter((run) => run.currentLease?.controllerId === applicant.controllerId);
          assert.equal(owned.length, 1, "One controller must never hold two leases");
          assert.equal(test23Service.controllerRunBindings.get(applicant.controllerId), owned[0].runId);
        } finally {
          release();
          blockedRun[method] = original;
        }
      }

      console.log("  [Test 29] Resume cache validates lease and returns live progress");
      for (const revoke of ["expired", "timeout", "detach", "takeover"]) {
        const owner = await newController(`cache-owner-${revoke}`);
        const applicant = await newController(`cache-applicant-${revoke}`);
        const run = await test23Service.createRun({ maxActions: 100 });
        await test23Service.claimRun(owner, { model_name: "Cache owner" });
        const req = await test23Service.createResumeRequest(applicant, run.runId);
        await test23Service.approveResumeRequest(req.request_id, { force: true });
        const attached = await test23Service.getResumeRequestStatus(applicant, req.request_id);
        await run.executeAction(applicant, attached.lease_id, attached.lease_epoch, "rotate_camera_left", {}, `cache-action-${revoke}`);
        const live = await test23Service.createResumeRequest(applicant, run.runId);
        assert.equal(live.action_seq, 1);
        assert.equal(live.actions_remaining, 99);
        if (revoke === "expired" || revoke === "timeout") {
          run.currentLease.expiresAt = Date.now() - 1;
          if (revoke === "timeout") await run._handleLeaseTimeout();
        } else if (revoke === "detach") {
          await run.detach(applicant, attached.lease_id, attached.lease_epoch);
        } else {
          const next = await newController("cache-next");
          const nextReq = await test23Service.createResumeRequest(next, run.runId);
          await test23Service.approveResumeRequest(nextReq.request_id, { force: true });
        }
        const status = await test23Service.getResumeRequestStatus(applicant, req.request_id);
        assert.equal(status.status, "expired");
        assert.equal(status.lease_id, undefined);
        const pending = await test23Service.createResumeRequest(applicant, run.runId);
        assert.equal(pending.status, "pending_approval");
        assert.notEqual(pending.request_id, req.request_id);
        assert.equal(pending.lease_id, undefined);
        await test23Service.getResumeRequestStatus(applicant, req.request_id);
        assert.equal(test23Service.controllerResumeIndex.get(applicant.controllerId), pending.request_id);
      }

      console.log("  [Test 30] Takeover clears bindings even after detach or lease timeout");
      for (const revoke of ["detach", "timeout"]) {
        const owner = await newController(`binding-owner-${revoke}`);
        const applicant = await newController(`binding-applicant-${revoke}`);
        const run = await test23Service.createRun({ maxActions: 100 });
        const lease = await test23Service.claimRun(owner, { model_name: "Binding owner" });
        if (revoke === "detach") {
          await run.detach(owner, lease.lease_id, lease.lease_epoch);
        } else {
          run.currentLease.expiresAt = Date.now() - 1;
          await run._handleLeaseTimeout();
        }
        assert.equal(run.currentLease, null);
        const req = await test23Service.createResumeRequest(applicant, run.runId);
        await test23Service.approveResumeRequest(req.request_id);
        assert.equal(test23Service.controllerRunBindings.has(owner.controllerId), false);
        const next = await test23Service.createRun();
        const claim = await test23Service.claimRun(owner, { model_name: "Next model" });
        assert.equal(claim.run_id, next.runId);
      }

      console.log("  [Test 31] Authoritative WAL commit with projection fault tolerance (AC-R1)");
      const ctrl31 = await newController("ctrl31-wal-fault");
      const run31 = await test23Service.createRun({ maxActions: 100 });
      const lease31 = await test23Service.claimRun(ctrl31, { model_name: "Model 31" });

      // 1. 模拟 actions.jsonl 写入故障注入
      const originalAppendFileSync = fs.appendFileSync;
      let appendAttempts = 0;
      fs.appendFileSync = function (filePath, data, options) {
        if (typeof filePath === "string" && filePath.includes(run31.runId) && filePath.endsWith("actions.jsonl")) {
          appendAttempts++;
          throw new Error("Synthetic projection failure appending to actions.jsonl");
        }
        return originalAppendFileSync.apply(this, arguments);
      };

      let replayRun = null;
      try {
        const opId1 = "op-wal-fault-1";
        // 执行动作：actions.jsonl 次级投影抛错，但权威 WAL 必须成功提交且不向调用方外抛异常
        const result1 = await run31.executeAction(
          ctrl31,
          lease31.lease_id,
          lease31.lease_epoch,
          "rotate_camera_left",
          {},
          opId1
        );
        assert.ok(result1, "executeAction 应当正常返回结果，不被次级投影错误中断");
        assert.equal(appendAttempts, 1, "应当触发并捕获 actions.jsonl 写入异常");

        // 2. 验证权威 WAL (journal.jsonl) 记录了 action_committed 且序号严格更新
        const journalLines = fs.readFileSync(run31.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        const actionCommittedRecords = journalLines.filter((r) => r.type === "action_committed");
        assert.equal(actionCommittedRecords.length, 1, "WAL 必须持久化记录 action_committed");
        assert.equal(actionCommittedRecords[0].operation_id, opId1);
        const seq1 = actionCommittedRecords[0].journal_seq;
        assert.equal(run31.lastJournalSeq, seq1, "内存 lastJournalSeq 必须与权威 WAL 最新序号同步");
        assert.ok(run31.operationIndex.has(opId1), "operationIndex 必须包含已提交的 opId");

        // 3. 相同 operation_id 重试：必须命中幂等缓存，且 WAL 绝不产生重复记录与序号
        const retryResult = await run31.executeAction(
          ctrl31,
          lease31.lease_id,
          lease31.lease_epoch,
          "rotate_camera_left",
          {},
          opId1
        );
        assert.deepEqual(retryResult, result1, "幂等重试应返回已缓存结果");
        const journalLinesAfterRetry = fs.readFileSync(run31.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(journalLinesAfterRetry.length, journalLines.length, "WAL 绝不应追加重复记录");

        // 恢复 fs.appendFileSync
        fs.appendFileSync = originalAppendFileSync;

        // 4. 后续新动作保持序号严格自增且连续
        const opId2 = "op-wal-fault-2";
        const result2 = await run31.executeAction(
          ctrl31,
          lease31.lease_id,
          lease31.lease_epoch,
          "rotate_camera_left",
          {},
          opId2
        );
        assert.ok(result2);
        const journalLinesAfterNext = fs.readFileSync(run31.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        const allSeqs = journalLinesAfterNext.map((r) => r.journal_seq);
        for (let i = 0; i < allSeqs.length; i++) {
          assert.equal(allSeqs[i], i + 1, `journal_seq 必须严格递增连贯: expected ${i + 1}, got ${allSeqs[i]}`);
        }

        // 5. 重启重放 journal：replayJournal 平滑通过且基于权威 WAL 自动调和 actions.jsonl
        replayRun = new (run31.constructor)(
          test23Service,
          run31.runId,
          run31.runDir,
          run31.manifest
        );
        await replayRun.replayJournal();
        assert.equal(replayRun.lastJournalSeq, run31.lastJournalSeq, "重放必须恢复出一致的 journal seq");

        const replayedActionLines = fs.readFileSync(run31.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(replayedActionLines.length, 2, "actions.jsonl 必须在 replayJournal 中完整对齐重建");
      } finally {
        fs.appendFileSync = originalAppendFileSync;
        if (replayRun) replayRun.cleanup();
        if (run31) run31.cleanup();
      }

      console.log("  [Test 32] Strict lease expiry check inside session mutex (AC-R3)");
      const ctrl32 = await newController("ctrl32-lease-expiry");
      const run32 = await test23Service.createRun({ maxActions: 100 });
      const lease32 = await test23Service.claimRun(ctrl32, { model_name: "Model 32" });

      try {
        // 人为模拟租约已过期
        const expiredTime = Date.now() - 500;
        run32.currentLease.expiresAt = expiredTime;

        // 1. 在锁内调用 heartbeat，必须被拒绝 (409 CONFLICT) 且不得续期
        await assert.rejects(
          async () => {
            await run32.heartbeat(ctrl32, lease32.lease_id, lease32.lease_epoch);
          },
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, "CONFLICT");
            assert.match(err.message, /expired/i);
            return true;
          },
          "过期租约的 heartbeat 必须返回 409 CONFLICT"
        );
        assert.equal(run32.currentLease.expiresAt, expiredTime, "heartbeat 绝不可延长已过期租约的时间");

        // 2. 在锁内调用 executeAction，必须被拒绝 (409 CONFLICT) 且动作不得执行
        await assert.rejects(
          async () => {
            await run32.executeAction(
              ctrl32,
              lease32.lease_id,
              lease32.lease_epoch,
              "rotate_camera_left",
              {},
              "op-expired-action-1"
            );
          },
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, "CONFLICT");
            assert.match(err.message, /expired/i);
            return true;
          },
          "过期租约的 executeAction 必须返回 409 CONFLICT"
        );
        assert.equal(run32.lastActionSeq, 0, "过期租约不得提交任何动作");
        // 3. 在锁内调用 observe，必须被拒绝 (409 CONFLICT) 且不得返回观察
        await assert.rejects(
          async () => {
            await run32.observe(ctrl32);
          },
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, "CONFLICT");
            assert.match(err.message, /expired/i);
            return true;
          },
          "过期租约的 observe 必须返回 409 CONFLICT"
        );
      } finally {
        if (run32) run32.cleanup();
      }

      console.log("  [Test 33] Idempotent retry of rejected actions returns structured error (AC-R5)");
      const ctrl33 = await newController("ctrl33-rejected-idempotency");
      const run33 = await test23Service.createRun({ maxActions: 100 });
      const lease33 = await test23Service.claimRun(ctrl33, { model_name: "Model 33" });

      try {
        const opIdReject = "op-rejected-idempotent-1";

        // 1. 触发动作拒绝 (非法参数或非法指令)
        const rejectResult1 = await run33.executeAction(
          ctrl33,
          lease33.lease_id,
          lease33.lease_epoch,
          "go_to_level",
          { x: "1", y: "2" },
          opIdReject
        );

        assert.ok(rejectResult1, "初次被拒绝响应必须非空");
        assert.equal(rejectResult1.isError, true, "初次被拒绝响应 isError 必须为 true");
        assert.equal(rejectResult1.resultType, "complete", "resultType 必须为 complete");
        assert.ok(Array.isArray(rejectResult1.content) && rejectResult1.content.length > 0, "响应 content 必须非空数组");

        // 验证权威 WAL 记录了 action_rejected 且包含 sanitized_result，并通过 schema 校验
        const journalLines = fs.readFileSync(run33.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        const rejectedRecord = journalLines.find((r) => r.type === "action_rejected" && r.operation_id === opIdReject);
        assert.ok(rejectedRecord, "WAL 必须包含 action_rejected 记录");
        assert.equal(validateJournalRecord(rejectedRecord), true, "action_rejected 记录必须符合 JSON schema");
        assert.deepEqual(rejectedRecord.sanitized_result, rejectResult1, "WAL 中 sanitized_result 必须与初次响应一致");

        // 2. 相同 operation_id 重试：必须返回完全相同的结构化错误响应，绝不可返回 undefined 或空响应
        const retryRejectResult = await run33.executeAction(
          ctrl33,
          lease33.lease_id,
          lease33.lease_epoch,
          "go_to_level",
          { x: "1", y: "2" },
          opIdReject
        );
        assert.deepEqual(retryRejectResult, rejectResult1, "幂等重试必须返回相同的结构化错误响应");
        assert.equal(retryRejectResult.isError, true);

        // 3. 相同 operation_id 但不同参数：必须抛出 IDEMPOTENCY_CONFLICT
        await assert.rejects(
          async () => {
            await run33.executeAction(
              ctrl33,
              lease33.lease_id,
              lease33.lease_epoch,
              "rotate_camera_right",
              {},
              opIdReject
            );
          },
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, "IDEMPOTENCY_CONFLICT");
            return true;
          },
          "相同 operation_id 篡改参数必须返回 IDEMPOTENCY_CONFLICT"
        );

        // 4. 验证历史未缓存 sanitized_result 的 action_rejected 回退行为
        const fallbackOpId = "op-historical-fallback";
        run33.operationIndex.set(fallbackOpId, {
          journal_seq: 999,
          type: "action_rejected",
          operation_id: fallbackOpId,
          controller_id: ctrl33.controllerId,
          error_payload: { message: "Legacy error without sanitized_result" }
        });
        const fallbackResult = await run33.executeAction(
          ctrl33,
          lease33.lease_id,
          lease33.lease_epoch,
          "rotate_camera_left",
          {},
          fallbackOpId
        );
        assert.ok(fallbackResult, "历史回退响应不得为 undefined");
        assert.equal(fallbackResult.isError, true);
        assert.equal(fallbackResult.resultType, "complete");
      } finally {
        if (run33) run33.cleanup();
      }

      console.log("  [Test 34] Actions replica reconciliation before finalization & accurate novelty calculation");
      const ctrl34 = await newController("ctrl34-reconcile-novelty");
      const run34 = await test23Service.createRun({ maxActions: 100 });
      const lease34 = await test23Service.claimRun(ctrl34, { model_name: "Model 34" });

      try {
        // 1. 动作 1: 原地旋转，正常写入 WAL 与 actions.jsonl
        await run34.executeAction(
          ctrl34,
          lease34.lease_id,
          lease34.lease_epoch,
          "rotate_camera_left",
          {},
          "op-rot-1"
        );

        // 2. 动作 2: 再次原地旋转，模拟次级副本写入失败（抛错）
        const origAppend = fs.appendFileSync;
        fs.appendFileSync = (file, data, opt) => {
          if (typeof file === "string" && file.endsWith("actions.jsonl")) {
            throw new Error("Synthetic failure on 2nd rotation actions replica");
          }
          return origAppend(file, data, opt);
        };

        try {
          await run34.executeAction(
            ctrl34,
            lease34.lease_id,
            lease34.lease_epoch,
            "rotate_camera_left",
            {},
            "op-rot-2"
          );
        } finally {
          fs.appendFileSync = origAppend;
        }

        // 此时 actions.jsonl 缺少第二步（仅有 1 步）
        const unalignedActions = fs.readFileSync(run34.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(unalignedActions.length, 1, "注入写入失败后，actions.jsonl 暂时缺失第 2 步动作");

        // 3. 执行最终结算（_startFinalize）
        await run34._startFinalize("won", "Goal reached");
        // 等待异步 finalizeWorker 执行完毕
        await new Promise((resolve) => setTimeout(resolve, 150));

        // 4. 验证结算前 actions.jsonl 已自动向权威 WAL 完整对齐
        const reconciledActions = fs.readFileSync(run34.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(reconciledActions.length, 2, "结算前 actions.jsonl 必须向权威 WAL 完整对齐（2 步动作）");

        // 5. 验证从权威数据源计算的 novelty：两次原地旋转（同一坐标）novelty 应为 50，绝不固化为错误的 100
        const { getRunFinalNovelty } = require("../server/run-rankings");
        const finalNovelty = getRunFinalNovelty(run34.runDir);
        assert.equal(finalNovelty, 50, `两次原地旋转的 novelty 必须精确为 50，实际值为 ${finalNovelty}`);
      } finally {
        if (run34) run34.cleanup();
      }

      console.log("  [Test 35] Controlled session extension with authoritative terminal verification & binding cleanup");
      const ctrl35A = await newController("ctrl35-terminal-reclaim");
      const run35A = await test23Service.createRun({ maxActions: 10 });
      const lease35A = await test23Service.claimRun(ctrl35A, { model_name: "Model 35A" });
      assert.equal(test23Service.controllerRunBindings.get(ctrl35A.controllerId), run35A.runId);

      let run35B = null;
      try {
        // 1. 终态 run 携带 previous_run_id 成功签发凭据、返回 previous_run 快照并清理旧绑定
        await run35A._startFinalize("won", "Goal reached successfully");
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(run35A.status, "won");

        // 模拟旧局残存的 controller 绑定（例如异步清理滞后或异常残留）
        const residualCtrlId = `residual-${ctrl35A.controllerId}`;
        test23Service.controllerRunBindings.set(residualCtrlId, run35A.runId);
        assert.equal(test23Service.controllerRunBindings.get(residualCtrlId), run35A.runId);

        // 1a. 对抗测试：使用非法 nonce 携带 terminal runId，必须立即被 403 阻断，严禁泄露状态且严禁清理旧绑定
        const nonceBeforeBadTerminal = test23Service.mcpBootstrapNonce;
        await assert.rejects(
          test23Service.handleControllerSession(
            "WRONG_BOOTSTRAP_NONCE",
            { name: "adversary-terminal" },
            { previousRunId: run35A.runId }
          ),
          (err) => {
            assert.equal(err.status, 403);
            assert.equal(err.code, "FORBIDDEN");
            assert.equal(err.run_id, undefined);
            assert.equal(err.status_name, undefined);
            return true;
          },
          "非法 nonce 探测 terminal run 必须立即返回 403 FORBIDDEN"
        );
        assert.equal(
          test23Service.controllerRunBindings.get(residualCtrlId),
          run35A.runId,
          "未认证的非法请求严禁清理旧绑定"
        );
        assert.equal(test23Service.mcpBootstrapNonce, nonceBeforeBadTerminal, "非法请求严禁消耗 nonce");

        // 1b. 终态 run 携带合法 nonce 与 previous_run_id 成功签发凭据、返回 previous_run 快照并清理旧绑定
        const nonceBeforeSuccess = test23Service.mcpBootstrapNonce;
        const sessionRes35A = await test23Service.handleControllerSession(
          nonceBeforeSuccess,
          { name: "ctrl35-reconnect" },
          { previousRunId: run35A.runId }
        );

        assert.ok(sessionRes35A.controller_token);
        assert.ok(sessionRes35A.controller_id.startsWith("ctrl35-reconnect"));
        assert.equal(sessionRes35A.instance_id, test23Service.instanceId);
        assert.deepEqual(sessionRes35A.previous_run, {
          run_id: run35A.runId,
          ended: true,
          status: "won"
        });
        assert.equal(test23Service.controllerRunBindings.has(residualCtrlId), false, "旧绑定必须在终态核验后清理");
        assert.equal(test23Service.controllerRunBindings.has(ctrl35A.controllerId), false, "原有绑定也已清理");
        assert.notEqual(test23Service.mcpBootstrapNonce, nonceBeforeSuccess, "成功签发后 nonce 必须轮转");

        // 2. 处于 active 状态的 run 携带 previous_run_id 必须拒绝 (RUN_RESUME_REQUIRED)，且严禁消耗 nonce
        const ctrl35B = await newController("ctrl35-active-holder");
        run35B = await test23Service.createRun({ maxActions: 10 });
        await test23Service.claimRun(ctrl35B, { model_name: "Model 35B" });
        assert.equal(run35B.status, "active");

        // 2a. 对抗测试：使用非法 nonce 携带 active runId，必须直接返回 403 FORBIDDEN，严禁泄露 RUN_RESUME_REQUIRED 或 active 状态
        const nonceBeforeBadActive = test23Service.mcpBootstrapNonce;
        await assert.rejects(
          test23Service.handleControllerSession(
            "WRONG_BOOTSTRAP_NONCE",
            { name: "adversary-active" },
            { previousRunId: run35B.runId }
          ),
          (err) => {
            assert.equal(err.status, 403);
            assert.equal(err.code, "FORBIDDEN");
            assert.equal(err.run_id, undefined);
            assert.equal(err.status_name, undefined);
            return true;
          },
          "非法 nonce 探测 active run 必须直接抛出 403 FORBIDDEN 且不泄露状态"
        );
        assert.equal(
          test23Service.controllerRunBindings.get(ctrl35B.controllerId),
          run35B.runId,
          "非法请求严禁影响 active 绑定"
        );
        assert.equal(test23Service.mcpBootstrapNonce, nonceBeforeBadActive, "非法请求严禁消耗 nonce");

        const nonceBeforeActiveReject = test23Service.mcpBootstrapNonce;
        await assert.rejects(
          test23Service.handleControllerSession(
            nonceBeforeActiveReject,
            { name: "ctrl35-active-reclaim" },
            { previousRunId: run35B.runId }
          ),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, "RUN_RESUME_REQUIRED");
            assert.equal(err.run_id, run35B.runId);
            assert.equal(err.status_name, "active");
            return true;
          },
          "Active run 带 previous_run_id 必须抛出 409 RUN_RESUME_REQUIRED"
        );
        assert.equal(test23Service.mcpBootstrapNonce, nonceBeforeActiveReject, "校验失败严禁消耗 nonce");

        // 3. 不存在的 run 携带 previous_run_id 必须拒绝 (PREVIOUS_RUN_UNVERIFIED)，且严禁消耗 nonce
        const ghostRunId = "ext-00000000-ghost-4000-8000-000000000000";

        // 3a. 对抗测试：使用非法 nonce 携带 ghost runId，必须直接返回 403 FORBIDDEN，严禁泄露 PREVIOUS_RUN_UNVERIFIED
        const nonceBeforeBadGhost = test23Service.mcpBootstrapNonce;
        await assert.rejects(
          test23Service.handleControllerSession(
            "WRONG_BOOTSTRAP_NONCE",
            { name: "adversary-ghost" },
            { previousRunId: ghostRunId }
          ),
          (err) => {
            assert.equal(err.status, 403);
            assert.equal(err.code, "FORBIDDEN");
            assert.equal(err.run_id, undefined);
            assert.equal(err.status_name, undefined);
            return true;
          },
          "非法 nonce 探测 ghost run 必须直接抛出 403 FORBIDDEN 且不泄露未验证状态"
        );
        assert.equal(test23Service.mcpBootstrapNonce, nonceBeforeBadGhost, "非法请求严禁消耗 nonce");

        const nonceBeforeNotFoundReject = test23Service.mcpBootstrapNonce;
        await assert.rejects(
          test23Service.handleControllerSession(
            nonceBeforeNotFoundReject,
            { name: "ctrl35-ghost-reclaim" },
            { previousRunId: ghostRunId }
          ),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, "PREVIOUS_RUN_UNVERIFIED");
            assert.equal(err.run_id, ghostRunId);
            return true;
          },
          "不存在的 run 必须抛出 409 PREVIOUS_RUN_UNVERIFIED"
        );
        assert.equal(test23Service.mcpBootstrapNonce, nonceBeforeNotFoundReject, "校验失败严禁消耗 nonce");

        // 4. 无 previous_run_id 时完全保持向后兼容（不返回 previous_run 字段，且正常消费轮转 nonce）
        const nonceBeforeLegacy = test23Service.mcpBootstrapNonce;
        const legacySessionRes = await test23Service.handleControllerSession(
          nonceBeforeLegacy,
          { name: "ctrl35-legacy" }
        );
        assert.ok(legacySessionRes.controller_token);
        assert.ok(legacySessionRes.controller_id.startsWith("ctrl35-legacy"));
        assert.equal(legacySessionRes.previous_run, undefined);
        assert.notEqual(test23Service.mcpBootstrapNonce, nonceBeforeLegacy);

        // 5. 对终态 run 发起 createResumeRequest 必须抛出 409 RUN_ENDED
        const ctrl35Legacy = test23Service.validateControllerToken(`Bearer ${legacySessionRes.controller_token}`);
        await assert.rejects(
          test23Service.createResumeRequest(ctrl35Legacy, run35A.runId),
          (err) => {
            assert.equal(err.status, 409);
            assert.equal(err.code, "RUN_ENDED");
            assert.equal(err.run_id, run35A.runId);
            assert.equal(err.ended, true);
            return true;
          },
          "对终态 run 请求 resume 必须抛出 409 RUN_ENDED"
        );

        // 6. 非法 previous_run_id 类型（空字符串或非字符串）必须抛出 400 INVALID_ARGUMENT，且严禁消耗 nonce
        const nonceBeforeInvalidArg = test23Service.mcpBootstrapNonce;
        await assert.rejects(
          test23Service.handleControllerSession(
            nonceBeforeInvalidArg,
            { name: "ctrl35-invalid" },
            { previousRunId: "   " }
          ),
          (err) => {
            assert.equal(err.status, 400);
            assert.equal(err.code, "INVALID_ARGUMENT");
            return true;
          },
          "空白 previous_run_id 必须抛出 400 INVALID_ARGUMENT"
        );
        assert.equal(test23Service.mcpBootstrapNonce, nonceBeforeInvalidArg, "参数校验失败严禁消耗 nonce");

        // 6b. 合法 nonce 下 clientInfo.name 参数非法（含控制字符或超长）必须抛出 400 INVALID_ARGUMENT 且严禁提前消耗/轮转 nonce
        const nonceBeforeBadClient = test23Service.mcpBootstrapNonce;
        await assert.rejects(
          test23Service.handleControllerSession(
            nonceBeforeBadClient,
            { name: "bad\x00client" }
          ),
          (err) => {
            assert.equal(err.status, 400);
            assert.equal(err.code, "INVALID_ARGUMENT");
            return true;
          },
          "含控制字符的 clientInfo.name 必须抛出 400 INVALID_ARGUMENT"
        );
        assert.equal(test23Service.mcpBootstrapNonce, nonceBeforeBadClient, "clientInfo.name 校验失败严禁提前消耗轮转 nonce");

        // 7. 路由层 (server/router.js) 端到端集成测试
        const router35 = createRequestRouter({
          externalPlay: test23Service,
          publicFileRoutes: new Map(),
          readJsonBody: async (req) => req.body || {},
          sendJson: (res, status, payload) => {
            res.writeHead(status);
            res.end(JSON.stringify(payload));
          },
          getLevelState: () => ({ width: 10, height: 10 }),
          getLevel: () => ({ id: "lvl-1" }),
          getGame: () => ({ id: "maze" }),
          worldMaps: {
            defaultLevelIdForGame: () => "lvl-1",
            isMazeWorldLevelId: () => false
          }
        });

        const dispatchMockPost = async (url, body) => {
          let resStatus = null;
          let resJson = null;
          const req = {
            method: "POST",
            url,
            headers: {
              host: "127.0.0.1:3018",
              "sec-fetch-site": "same-origin",
              "content-type": "application/json"
            },
            socket: { remoteAddress: "127.0.0.1" },
            body
          };
          const res = {
            writeHead(status) { resStatus = status; },
            end(data) { if (data) resJson = JSON.parse(data); }
          };
          await router35.handleRequest(req, res);
          return { status: resStatus, body: resJson };
        };

        // 7a. 路由层成功处理终态 previous_run_id
        const routerNonce1 = test23Service.mcpBootstrapNonce;
        const routeResSuccess = await dispatchMockPost("/api/external-play/controller/session", {
          mcp_bootstrap_nonce: routerNonce1,
          clientInfo: { name: "router-client" },
          previous_run_id: run35A.runId
        });
        assert.equal(routeResSuccess.status, 200);
        assert.ok(routeResSuccess.body.controller_token);
        assert.deepEqual(routeResSuccess.body.previous_run, {
          run_id: run35A.runId,
          ended: true,
          status: "won"
        });

        // 7b. 路由层拒绝 active previous_run_id 并返回 409 RUN_RESUME_REQUIRED
        const routerNonce2 = test23Service.mcpBootstrapNonce;
        const routeResActive = await dispatchMockPost("/api/external-play/controller/session", {
          mcp_bootstrap_nonce: routerNonce2,
          clientInfo: { name: "router-client" },
          previous_run_id: run35B.runId
        });
        assert.equal(routeResActive.status, 409);
        assert.equal(routeResActive.body.code, "RUN_RESUME_REQUIRED");
        assert.equal(routeResActive.body.run_id, run35B.runId);
        assert.equal(routeResActive.body.status, "active");

        // 7c. 路由层拒绝不存在的 previous_run_id 并返回 409 PREVIOUS_RUN_UNVERIFIED
        const routeResNotFound = await dispatchMockPost("/api/external-play/controller/session", {
          mcp_bootstrap_nonce: routerNonce2,
          clientInfo: { name: "router-client" },
          previous_run_id: "ext-non-existent"
        });
        assert.equal(routeResNotFound.status, 409);
        assert.equal(routeResNotFound.body.code, "PREVIOUS_RUN_UNVERIFIED");
        assert.equal(routeResNotFound.body.run_id, "ext-non-existent");

        // 7d. 路由层使用非法 nonce 携带 previous_run_id 必须直接返回 403 FORBIDDEN 且不泄露状态
        const routeResBadNonce = await dispatchMockPost("/api/external-play/controller/session", {
          mcp_bootstrap_nonce: "WRONG_NONCE",
          clientInfo: { name: "router-client" },
          previous_run_id: run35A.runId
        });
        assert.equal(routeResBadNonce.status, 403);
        assert.equal(routeResBadNonce.body.code, "FORBIDDEN");
        assert.equal(routeResBadNonce.body.status, undefined);
        assert.equal(routeResBadNonce.body.run_id, undefined);
      } finally {
        if (run35A) run35A.cleanup();
        if (run35B) run35B.cleanup();
      }
    } finally {
      await new Promise((r) => setTimeout(r, 60));
      test23Service.shutdown();
    }

    console.log("All ExternalPlayService unit & integration tests PASSED!");
  } finally {
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
}

module.exports = { runTests };
