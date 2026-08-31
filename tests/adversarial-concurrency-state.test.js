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
  assertIsolation
} = require("../server/external-play");
const {
  validateJournalRecord,
  validateActionRecord,
  validateViewerState,
  validateSummary,
  computeViewerStateHash
} = require("../shared/validators.standalone");

async function runAdversarialTests() {
  console.log("================================================================================");
  console.log("Starting Milestone 1 Concurrency & State Transition Adversarial Stress Tests...");
  console.log("================================================================================\n");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-adversarial-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  const testFindings = [];

  try {
    // =========================================================================
    // SECTION 1: Unclaimed Armed Run Atomic Replacement Stress
    // =========================================================================
    console.log(">>> [SECTION 1] Unclaimed Armed Run Atomic Replacement Stress");

    // Test 1.1: Rapid serial replacements (10 iterations)
    console.log("  [Test 1.1] Rapid serial createRun replacements");
    const serialHome = path.join(testDataHome, "serial-replace");
    const serialService = new ExternalPlayService({ dataHome: serialHome, port: 4001 });
    await serialService.initialize();

    try {
      let currentActiveId = serialService.activeRunId;
      const createdRunIds = [currentActiveId];

      for (let i = 1; i <= 10; i++) {
        const durationMs = 60000 * (i + 1); // 2min, 3min, ...
        const winThreshold = 10 + i;

        const newRun = await serialService.createRun({ durationMs, winThreshold });
        assert.ok(newRun);
        assert.notEqual(newRun.runId, currentActiveId, `Iteration ${i}: New runId must differ from previous`);
        assert.equal(serialService.activeRunId, newRun.runId);
        assert.equal(newRun.status, "armed");
        assert.equal(newRun.durationMs, durationMs);
        assert.equal(newRun.winThreshold, winThreshold);

        // Verify previous run was marked cancelled with reconfigured_before_start
        const prevRun = serialService.getRun(currentActiveId);
        assert.ok(prevRun, `Previous run ${currentActiveId} must exist in memory`);

        // Wait briefly for async finalize worker to complete journal write
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(prevRun.status, "cancelled", `Previous run ${currentActiveId} must be cancelled`);

        const prevJournal = fs.readFileSync(prevRun.journalPath, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));

        const finalizeIntent = prevJournal.find((r) => r.type === "finalize_intent");
        assert.ok(finalizeIntent, `Previous run ${currentActiveId} must contain finalize_intent in WAL`);
        assert.equal(finalizeIntent.reason, "reconfigured_before_start");
        assert.equal(finalizeIntent.target_outcome, "cancelled");

        const runFinalized = prevJournal.find((r) => r.type === "run_finalized");
        assert.ok(runFinalized, `Previous run ${currentActiveId} must contain run_finalized in WAL`);
        assert.equal(runFinalized.outcome, "cancelled");

        // Verify server.json reflects new active_run_id
        const sJson = JSON.parse(fs.readFileSync(serialService.serverJsonPath, "utf8"));
        assert.equal(sJson.active_run_id, newRun.runId);

        currentActiveId = newRun.runId;
        createdRunIds.push(newRun.runId);
      }

      console.log(`    ✓ [PASS] Successfully performed 10 consecutive atomic replacements. Total runs created: ${createdRunIds.length}`);
    } catch (err) {
      console.error(`    ✗ [FAIL] Test 1.1 failed:`, err.message);
      testFindings.push({ test: "1.1 Rapid serial createRun", error: err.message, stack: err.stack });
    } finally {
      serialService.shutdown();
    }

    // Test 1.2: Massive parallel burst of createRun (20 parallel requests)
    console.log("  [Test 1.2] Massive parallel burst of createRun (20 parallel requests)");
    const parallelHome = path.join(testDataHome, "parallel-replace");
    const parallelService = new ExternalPlayService({ dataHome: parallelHome, port: 4002 });
    await parallelService.initialize();

    try {
      const initialArmedId = parallelService.activeRunId;
      const initialRun = parallelService.getRun(initialArmedId);
      assert.equal(initialRun.status, "armed");

      const burstCount = 20;
      const promises = [];
      for (let i = 0; i < burstCount; i++) {
        promises.push(parallelService.createRun({
          durationMs: 60000 * ((i % 10) + 1),
          winThreshold: 10 + (i % 50)
        }));
      }

      const results = await Promise.allSettled(promises);

      const rejected = results.filter((r) => r.status === "rejected");
      if (rejected.length > 0) {
        throw new Error(
          `Expected all 20 parallel createRun requests to resolve cleanly under admissionMutex, but ${rejected.length} requests failed. First error: ${rejected[0].reason?.message || JSON.stringify(rejected[0].reason)}`
        );
      }

      for (let i = 0; i < burstCount; i++) {
        assert.equal(results[i].status, "fulfilled");
        assert.ok(results[i].value?.runId);
      }

      // Allow finalize workers to settle
      await new Promise((r) => setTimeout(r, 200));

      // Exactly one non-terminal run must remain
      const allRuns = parallelService.listRuns();
      const nonTerminal = allRuns.filter((r) => ["armed", "active", "finalizing"].includes(r.status));
      assert.equal(nonTerminal.length, 1, `Expected exactly 1 non-terminal run, found ${nonTerminal.length}`);
      assert.equal(nonTerminal[0].status, "armed");
      assert.equal(nonTerminal[0].run_id, parallelService.activeRunId);

      // Verify all cancelled runs have reconfigured_before_start
      const cancelledRuns = allRuns.filter((r) => r.status === "cancelled");
      assert.equal(cancelledRuns.length, burstCount, `Expected ${burstCount} cancelled runs (including initial)`);
      for (const cRunInfo of cancelledRuns) {
        const cRun = parallelService.getRun(cRunInfo.run_id);
        const journal = fs.readFileSync(cRun.journalPath, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const finalizeIntent = journal.find((r) => r.type === "finalize_intent");
        assert.ok(finalizeIntent);
        assert.equal(finalizeIntent.reason, "reconfigured_before_start");
      }

      const finalServerJson = JSON.parse(fs.readFileSync(parallelService.serverJsonPath, "utf8"));
      assert.equal(finalServerJson.active_run_id, parallelService.activeRunId);
      console.log(`    ✓ [PASS] Parallel burst of 20 createRun resolved cleanly without any 409 or deadlock. Final active run: ${parallelService.activeRunId}`);
    } catch (err) {
      console.error(`    ✗ [FAIL] Test 1.2 failed:`, err.message);
      testFindings.push({ test: "1.2 Parallel burst of createRun", error: err.message, stack: err.stack });
    } finally {
      parallelService.shutdown();
    }


    // =========================================================================
    // SECTION 2: Resolute 409 Conflict Rejection & Non-Destructive Active Run
    // =========================================================================
    console.log("\n>>> [SECTION 2] Resolute 409 Conflict & State Integrity Preservation");

    console.log("  [Test 2.1] Concurrent createRun rejection during active leased session");
    const activeHome = path.join(testDataHome, "active-conflict");
    const activeService = new ExternalPlayService({ dataHome: activeHome, port: 4003 });
    await activeService.initialize();

    try {
      const activeRun = activeService.getRun(activeService.activeRunId);
      const session = await activeService.handleControllerSession(activeService.mcpBootstrapNonce, { name: "active-tester" });
      const controller = activeService.validateControllerToken(`Bearer ${session.controller_token}`);

      const startRes = await activeRun.startOrAttach(controller, "active-start-1");
      assert.equal(activeRun.status, "active");
      assert.equal(startRes.status, "active");

      // Execute a move to establish non-zero action seq
      const moveRes = await activeRun.executeAction(controller, startRes.lease_id, startRes.lease_epoch, "down", {}, "op-move-1");
      assert.equal(moveRes.isError, false);
      assert.equal(activeRun.lastActionSeq, 1);

      // Now launch 15 parallel createRun requests while active
      const attackPromises = [];
      for (let i = 0; i < 15; i++) {
        attackPromises.push(activeService.createRun({ durationMs: 120000, winThreshold: 15 }));
      }
      const attackResults = await Promise.allSettled(attackPromises);

      // Every single request must be rejected with 409 RUN_ACTIVE
      for (let i = 0; i < attackResults.length; i++) {
        assert.equal(attackResults[i].status, "rejected", `Attack request ${i} must be rejected`);
        const err = attackResults[i].reason;
        assert.equal(err.status, 409, `Attack request ${i} must return HTTP 409`);
        assert.equal(err.code, "RUN_ACTIVE", `Attack request ${i} must return RUN_ACTIVE code`);
      }

      // Assert Active Run State is completely intact & uncorrupted
      assert.equal(activeRun.status, "active", "Active run status must remain active");
      assert.equal(activeRun.lastActionSeq, 1, "Action sequence must remain 1");
      assert.equal(activeRun.currentLease.controllerId, controller.controllerId);
      assert.equal(activeRun.currentLease.leaseId, startRes.lease_id);
      assert.equal(activeRun.currentLease.leaseEpoch, startRes.lease_epoch);
      assert.equal(activeService.activeRunId, activeRun.runId);

      // Active controller can continue performing game actions seamlessly
      const secondMove = await activeRun.executeAction(controller, startRes.lease_id, startRes.lease_epoch, "right", {}, "op-move-2");
      assert.equal(secondMove.isError, false);
      assert.equal(activeRun.lastActionSeq, 2);

      const serverJson = JSON.parse(fs.readFileSync(activeService.serverJsonPath, "utf8"));
      assert.equal(serverJson.active_run_id, activeRun.runId);

      console.log(`    ✓ [PASS] All 15 concurrent createRun requests rejected with 409. Active session remained 100% uncorrupted and operational.`);
    } catch (err) {
      console.error(`    ✗ [FAIL] Test 2.1 failed:`, err.message);
      testFindings.push({ test: "2.1 Concurrent createRun rejection during active session", error: err.message, stack: err.stack });
    } finally {
      activeService.shutdown();
    }

    console.log("  [Test 2.2] Rejection during finalizing and recovery after terminal state");
    const finalizingHome = path.join(testDataHome, "finalizing-conflict");
    const finalizingService = new ExternalPlayService({ dataHome: finalizingHome, port: 4004 });
    await finalizingService.initialize();

    try {
      const run = finalizingService.getRun(finalizingService.activeRunId);
      const session = await finalizingService.handleControllerSession(finalizingService.mcpBootstrapNonce, { name: "fin-tester" });
      const controller = finalizingService.validateControllerToken(`Bearer ${session.controller_token}`);
      await run.startOrAttach(controller, "fin-start");

      // Trigger finalize intent
      await run._startFinalize("won", "Player collected all gems");
      assert.equal(run.status, "finalizing");

      // createRun during finalizing must reject with 409
      await assert.rejects(
        finalizingService.createRun({ durationMs: 180000 }),
        (err) => err?.status === 409 && err?.code === "RUN_ACTIVE",
        "createRun during finalizing state must be rejected with 409"
      );

      // Wait for run to reach terminal status
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(run.status, "won");

      // After terminal state, createRun must succeed smoothly
      const nextRun = await finalizingService.createRun({ durationMs: 240000, winThreshold: 12 });
      assert.ok(nextRun);
      assert.notEqual(nextRun.runId, run.runId);
      assert.equal(nextRun.status, "armed");
      assert.equal(finalizingService.activeRunId, nextRun.runId);

      console.log(`    ✓ [PASS] Correctly rejected createRun during finalizing, and cleanly permitted new run creation after terminal state.`);
    } catch (err) {
      console.error(`    ✗ [FAIL] Test 2.2 failed:`, err.message);
      testFindings.push({ test: "2.2 Finalizing rejection & terminal recovery", error: err.message, stack: err.stack });
    } finally {
      finalizingService.shutdown();
    }


    // =========================================================================
    // SECTION 3: High-Concurrency Race Matrix (startOrAttach vs createRun)
    // =========================================================================
    console.log("\n>>> [SECTION 3] High-Concurrency Race Matrix (startOrAttach vs createRun)");

    console.log("  [Test 3.1] 50-iteration intense race condition loop (claim vs replace)");
    let startWins = 0;
    let createWins = 0;

    try {
      for (let iter = 1; iter <= 50; iter++) {
        const raceHome = path.join(testDataHome, `race-loop-${iter}`);
        const raceService = new ExternalPlayService({ dataHome: raceHome, port: 4100 + iter });
        await raceService.initialize();

        try {
          const armedRun = raceService.getRun(raceService.activeRunId);
          const session = await raceService.handleControllerSession(raceService.mcpBootstrapNonce, { name: `racer-${iter}` });
          const controller = raceService.validateControllerToken(`Bearer ${session.controller_token}`);

          // Fire startOrAttach and createRun simultaneously
          const pStart = armedRun.startOrAttach(controller, `race-op-${iter}`);
          const pCreate = raceService.createRun({ durationMs: 120000 + (iter * 1000), winThreshold: 15 });

          const results = await Promise.allSettled([pStart, pCreate]);
          const startResult = results[0];
          const createResult = results[1];

          // Exactly one must fulfill and one must reject with 409
          const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
          const rejectedCount = results.filter((r) => r.status === "rejected").length;

          assert.equal(fulfilledCount, 1, `Iteration ${iter}: Exactly 1 contender must succeed (found ${fulfilledCount})`);
          assert.equal(rejectedCount, 1, `Iteration ${iter}: Exactly 1 contender must fail (found ${rejectedCount})`);

          if (startResult.status === "fulfilled") {
            startWins++;
            // Controller claimed the armed run first
            assert.equal(startResult.value.status, "active");
            assert.equal(armedRun.status, "active");
            assert.equal(raceService.activeRunId, armedRun.runId);

            // createRun must have failed with 409
            const createErr = createResult.reason;
            assert.equal(createErr.status, 409, `Iteration ${iter}: createRun must fail with 409 when start wins`);
            assert.ok(
              createErr.code === "RUN_ALREADY_CLAIMED" || createErr.code === "RUN_ACTIVE",
              `Iteration ${iter}: error code must be RUN_ALREADY_CLAIMED or RUN_ACTIVE, got ${createErr.code}`
            );

            // Verify controller lease is active and functional
            assert.equal(armedRun.currentLease.controllerId, controller.controllerId);
          } else {
            createWins++;
            // createRun acquired lock and reconfigured armed run before startOrAttach
            const newRun = createResult.value;
            assert.equal(newRun.status, "armed");
            assert.notEqual(newRun.runId, armedRun.runId);
            assert.equal(raceService.activeRunId, newRun.runId);

            // startOrAttach on old run must have failed with 409
            const startErr = startResult.reason;
            assert.equal(startErr.status, 409, `Iteration ${iter}: startOrAttach on cancelled run must fail with 409`);

            // Allow finalize worker to write cancelled status
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(armedRun.status, "cancelled");
          }

          // Verify server.json always points to the actual valid active run
          const sJson = JSON.parse(fs.readFileSync(raceService.serverJsonPath, "utf8"));
          assert.equal(sJson.active_run_id, raceService.activeRunId);
        } finally {
          raceService.shutdown();
        }
      }

      console.log(`    ✓ [PASS] Completed 50 race iterations: startOrAttach won ${startWins} times, createRun won ${createWins} times.`);
      console.log(`    ✓ [PASS] In 100% of iterations, the mutual exclusion held: zero split-brain, zero double-active sessions, zero 500s.`);
    } catch (err) {
      console.error(`    ✗ [FAIL] Test 3.1 failed:`, err.message);
      testFindings.push({ test: "3.1 50-iteration race loop", error: err.message, stack: err.stack });
    }

    console.log("\n  [Test 3.2] Extreme multi-contender burst: 10 Controllers + 10 createRun contenders");
    const burstHome = path.join(testDataHome, "extreme-burst");
    const burstService = new ExternalPlayService({ dataHome: burstHome, port: 4200 });
    await burstService.initialize();

    try {
      const initialRun = burstService.getRun(burstService.activeRunId);

      // Create 10 controller sessions
      const controllers = [];
      for (let i = 0; i < 10; i++) {
        const nonce = burstService.mcpBootstrapNonce;
        const sess = await burstService.handleControllerSession(nonce, { name: `burst-ctrl-${i}` });
        controllers.push(burstService.validateControllerToken(`Bearer ${sess.controller_token}`));
      }

      // Mix 10 startOrAttach calls on initialRun with 10 createRun calls
      const burstContenders = [];
      for (let i = 0; i < 10; i++) {
        burstContenders.push({
          type: "start",
          id: `ctrl-${i}`,
          promise: initialRun.startOrAttach(controllers[i], `burst-op-start-${i}`)
        });
        burstContenders.push({
          type: "create",
          id: `create-${i}`,
          promise: burstService.createRun({ durationMs: 60000 * ((i % 5) + 1), winThreshold: 10 + i })
        });
      }

      // Shuffle order to maximize non-deterministic arrival
      burstContenders.sort(() => Math.random() - 0.5);

      const burstResults = await Promise.allSettled(burstContenders.map((c) => c.promise));

      // Wait for all async workers
      await new Promise((r) => setTimeout(r, 200));

      const allRuns = burstService.listRuns();
      const nonTerminalRuns = allRuns.filter((r) => ["armed", "active", "finalizing"].includes(r.status));
      assert.equal(nonTerminalRuns.length, 1, `Exactly 1 non-terminal run must remain after extreme burst (found ${nonTerminalRuns.length})`);

      const activeRunOnServer = burstService.getRun(burstService.activeRunId);
      assert.ok(activeRunOnServer);
      assert.ok(["armed", "active"].includes(activeRunOnServer.status));

      // Verify server.json
      const burstServerJson = JSON.parse(fs.readFileSync(burstService.serverJsonPath, "utf8"));
      assert.equal(burstServerJson.active_run_id, burstService.activeRunId);

      // Verify all journals are sequentially intact
      for (const runInfo of allRuns) {
        const rInst = burstService.getRun(runInfo.run_id);
        const jLines = fs.readFileSync(rInst.journalPath, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        for (let idx = 0; idx < jLines.length; idx++) {
          assert.equal(jLines[idx].journal_seq, idx + 1, `Journal sequence on ${rInst.runId} must be consecutive 1..N`);
        }
      }

      console.log(`    ✓ [PASS] Extreme 20-way contention handled cleanly. System settled in deterministic state (${activeRunOnServer.status}). All WALs 100% integral.`);
    } catch (err) {
      console.error(`    ✗ [FAIL] Test 3.2 failed:`, err.message);
      testFindings.push({ test: "3.2 Extreme 20-way contention burst", error: err.message, stack: err.stack });
    } finally {
      burstService.shutdown();
    }

    console.log("\n================================================================================");
    if (testFindings.length === 0) {
      console.log("ALL ADVERSARIAL CONCURRENCY & STATE TRANSITION STRESS TESTS PASSED (100% SUCCESS)!");
    } else {
      console.log(`ADVERSARIAL STRESS TEST COMPLETED WITH ${testFindings.length} FAILURE(S)!`);
      testFindings.forEach((f) => console.log(`  - [${f.test}] ${f.error}`));
    }
    console.log("================================================================================\n");

    if (testFindings.length > 0) {
      throw new Error(`Adversarial test failed with ${testFindings.length} issue(s). See output above.`);
    }
  } finally {
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runAdversarialTests().catch((err) => {
    console.error("Adversarial test exited with error:", err.message);
    process.exit(1);
  });
}

module.exports = { runAdversarialTests };
