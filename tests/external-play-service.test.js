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
      () => assertSummaryInvariants({ ...preStartSummary, gems_collected: 11 }),
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

    // 2. Initialize service and default armed run creation
    console.log("  [Test 2] Service initialization and default armed run creation");
    const service = new ExternalPlayService({ port: 3001 });
    await service.initialize();

    assert.equal(service.serviceState, "READY");
    assert.ok(service.activeRunId);
    assert.ok(service.activeRunId.startsWith("ext-"));

    const initialRun = service.getRun(service.activeRunId);
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

    const startRes = await initialRun.startOrAttach(controllerInfo, "op-start-1");
    assert.equal(startRes.status, "active");
    assert.equal(startRes.lease_epoch, 1);
    assert.ok(startRes.lease_id);
    assert.equal(initialRun.status, "active");
    assert.ok(initialRun.startedAt);
    assert.ok(initialRun.deadlineAt);
    assert.ok(Number.isFinite(initialRun.deadlineMonotonicMs));
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
    assert.equal(initialRun.lastActionSeq, 1);
    assert.equal(initialRun.lastJournalSeq, 3);
    const firstActionRecord = JSON.parse(fs.readFileSync(initialRun.actionsPath, "utf8").trim().split("\n")[0]);
    assert.ok(
      firstActionRecord.viewer_transition.actor_deltas.every((delta) => /:actor:\d+$/.test(delta.id)),
      "all actor deltas, including the player, must use canonical viewer actor IDs"
    );

    const rotateRes = await initialRun.executeAction(
      controllerInfo,
      startRes.lease_id,
      startRes.lease_epoch,
      "rotate_camera_right",
      {},
      "op-cam-1"
    );
    assert.equal(rotateRes.isError, false);
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

    // 10. Finalize / Won or Timed out & Invariants
    console.log("  [Test 10] Finalize run and summary invariants");
    await initialRun._startFinalize("timed_out", "Test timeout");
    // Wait briefly for finalize worker
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(initialRun.status, "timed_out");
    assert.ok(deliveredEnded, "ended SSE event must be delivered to subscriber before connection close");
    assert.ok(fs.existsSync(initialRun.summaryPath));

    const summaryContent = JSON.parse(fs.readFileSync(initialRun.summaryPath, "utf8"));
    assert.equal(summaryContent.outcome, "timed_out");
    assert.equal(summaryContent.run_id, initialRun.runId);
    assert.ok(validateSummary(summaryContent));

    // Summary programmatic invariants:
    assert.ok(summaryContent.gems_collected >= 0 && summaryContent.gems_collected <= summaryContent.gems_total);
    assert.ok(summaryContent.rooms_visited >= 1);
    assert.ok(summaryContent.actions_total >= 2);
    assert.ok(summaryContent.progress_curve.length >= 2);

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
    assert.ok(restartedService.activeRunId);

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
      const raceRun = raceService.getRun(raceService.activeRunId);
      const raceControllerSession = await raceService.handleControllerSession(
        raceService.mcpBootstrapNonce,
        { name: "deadline-race-client" }
      );
      const raceController = raceService.validateControllerToken(`Bearer ${raceControllerSession.controller_token}`);
      const raceStart = await raceRun.startOrAttach(raceController, "race-start");

      const preservedDeadline = raceStart.deadline_at;
      if (raceRun.leaseTimer) clearTimeout(raceRun.leaseTimer);
      raceRun.leaseTimer = null;
      raceRun.currentLease.expiresAt = Date.now() - 1;
      const takeoverSession = await raceService.handleControllerSession(
        raceService.mcpBootstrapNonce,
        { name: "deadline-race-takeover" }
      );
      const takeoverController = raceService.validateControllerToken(`Bearer ${takeoverSession.controller_token}`);
      const takeover = await raceRun.startOrAttach(takeoverController, "race-takeover");
      assert.equal(takeover.lease_epoch, raceStart.lease_epoch + 1);
      assert.equal(takeover.deadline_at, preservedDeadline, "lease takeover must not reset the run deadline");
      const takeoverJournal = fs.readFileSync(raceRun.journalPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        takeoverJournal.slice(-2).map((record) => [record.type, record.reason || null]),
        [["lease_revoked", "heartbeat_timeout"], ["lease_attached", null]]
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
      const failureRun = failureService.getRun(failureService.activeRunId);
      const failureControllerSession = await failureService.handleControllerSession(
        failureService.mcpBootstrapNonce,
        { name: "finalize-failure-client" }
      );
      const failureController = failureService.validateControllerToken(`Bearer ${failureControllerSession.controller_token}`);
      await failureRun.startOrAttach(failureController, "failure-start");
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
    } finally {
      failureService.shutdown();
    }

    // 14. Duration & win_threshold parameter contract and boundary checks
    console.log("  [Test 14] Duration & win_threshold strict bounds validation");
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

    // 15. Atomic replacement of unclaimed default armed run
    console.log("  [Test 15] Atomic replacement of unclaimed default armed run");
    const replaceDataHome = path.join(testDataHome, "atomic-replace");
    const replaceService = new ExternalPlayService({ dataHome: replaceDataHome, port: 3007 });
    await replaceService.initialize();
    try {
      const oldArmedRunId = replaceService.activeRunId;
      const oldArmedRun = replaceService.getRun(oldArmedRunId);
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

      // 16. Conflict when creating run while active run exists
      console.log("  [Test 16] Conflict rejection when active run exists");
      const ctrlSession = await replaceService.handleControllerSession(replaceService.mcpBootstrapNonce, { name: "replace-test" });
      const ctrl = replaceService.validateControllerToken(`Bearer ${ctrlSession.controller_token}`);
      await newRun.startOrAttach(ctrl, "start-op-1");
      assert.equal(newRun.status, "active");

      await assert.rejects(
        replaceService.createRun({ durationMs: 120000 }),
        (err) => err?.status === 409 && (err?.code === "RUN_ACTIVE" || err?.code === "CONFLICT"),
        "createRun while run is active must fail with 409"
      );

      // 17. Atomic rejection when MCP concurrently claims armed run
      console.log("  [Test 17] Atomic rejection when armed run is already claimed");
      const raceDataHome = path.join(testDataHome, "atomic-race");
      const raceService2 = new ExternalPlayService({ dataHome: raceDataHome, port: 3008 });
      await raceService2.initialize();
      try {
        const armedRun = raceService2.getRun(raceService2.activeRunId);
        const ctrlSession2 = await raceService2.handleControllerSession(raceService2.mcpBootstrapNonce, { name: "race-test-2" });
        const ctrl2 = raceService2.validateControllerToken(`Bearer ${ctrlSession2.controller_token}`);
        await armedRun.startOrAttach(ctrl2, "claim-op-1");

        await assert.rejects(
          raceService2.createRun({ durationMs: 180000 }),
          (err) => err?.status === 409,
          "createRun after claim must fail with 409"
        );
      } finally {
        raceService2.shutdown();
      }
    } finally {
      replaceService.shutdown();
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
