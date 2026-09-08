/**
 * Adversarial Empirical Challenge Suite for Milestone 1
 *
 * Focus Areas:
 * 1. Two-phase lock order & concurrency: admissionMutex vs run.sessionMutex under in-flight actions & settlements (Deadlock verification).
 * 2. Old controller binding cleanup & strict revocation of control on terminal runs.
 * 3. Authoritative 409 RUN_ENDED stability across all 5 terminal statuses in createResumeRequest.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  ExternalPlayService,
  RunInstance
} = require("../server/external-play");
const { TERMINAL_STATUSES } = require("../server/external-run-groups");
const { createRequestRouter } = require("../server/router");

async function runAdversarialM1Challenge() {
  console.log("================================================================================");
  console.log("Starting Adversarial Empirical Challenge Suite: Milestone 1 Lock Order & Reclaim");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-m1-challenge-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  let service = null;

  try {
    service = new ExternalPlayService({ port: 3042, defaultMaxActions: 5 });
    await service.initialize();

    const newController = async (name = "challenger-client") => {
      const nonce = service.mcpBootstrapNonce;
      const res = await service.handleControllerSession(nonce, { name });
      const info = service.validateControllerToken(`Bearer ${res.controller_token}`);
      assert.ok(info, "Controller token must be valid");
      return { ...info, token: res.controller_token };
    };

    // -------------------------------------------------------------------------
    // SECTION 1: Two-Phase Lock Order & Concurrency Deadlock Stress
    // -------------------------------------------------------------------------
    console.log("\n[Section 1] Two-Phase Lock Order & Deadlock Stress Testing");

    // Test 1.1: In-flight action execution vs concurrent handleControllerSession Phase A
    console.log("  [Test 1.1] In-flight executeAction holding sessionMutex vs Phase A admission check");
    {
      const ctrl1 = await newController("ctrl1-inflight");
      const run1 = await service.createRun({ maxActions: 5 });
      const lease1 = await service.claimRun(ctrl1, { model_name: "Model 1" });
      assert.equal(run1.status, "active");

      // We simulate a slow / heavy action by temporarily instrumenting executeAction or holding sessionMutex
      let actionStarted = false;
      let actionFinished = false;

      const slowActionPromise = (async () => {
        // Acquire sessionMutex on run1 and delay to simulate active action processing
        await run1.sessionMutex.withLock(async () => {
          actionStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 150));
          actionFinished = true;
        });
      })();

      // Wait until the slow action is inside sessionMutex
      while (!actionStarted) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Concurrently invoke handleControllerSession with previousRunId = run1.runId
      // This enters admissionMutex, then tries to acquire run1.sessionMutex.
      // Simultaneously, invoke claimRun for another armed run (competes for admissionMutex).
      const run2 = await service.createRun({ maxActions: 5 });
      const ctrl2 = await newController("ctrl2-competing");

      const nonceBefore = service.mcpBootstrapNonce;

      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("DEADLOCK DETECTED in Test 1.1! Timeout after 3000ms")), 3000);
        timer.unref?.();
      });

      const concurrentSessionPromise = service.handleControllerSession(
        nonceBefore,
        { name: "ctrl1-reclaim-attempt" },
        { previousRunId: run1.runId }
      );

      const concurrentClaimPromise = service.claimRun(ctrl2, { model_name: "Model 2" });

      // Run with deadlock detector
      const results = await Promise.race([
        Promise.allSettled([slowActionPromise, concurrentSessionPromise, concurrentClaimPromise]),
        timeoutPromise
      ]);

      const [actionRes, sessionRes, claimRes] = results;

      assert.equal(actionRes.status, "fulfilled", "Slow action must complete without deadlock");
      assert.equal(actionFinished, true);

      // Session attempt on still-active run must be rejected with 409 RUN_RESUME_REQUIRED
      assert.equal(sessionRes.status, "rejected", "Phase A must reject active run");
      assert.equal(sessionRes.reason.status, 409);
      assert.equal(sessionRes.reason.code, "RUN_RESUME_REQUIRED");
      assert.equal(sessionRes.reason.run_id, run1.runId);
      assert.equal(sessionRes.reason.status_name, "active");

      // Nonce must NOT be consumed
      assert.equal(service.mcpBootstrapNonce, nonceBefore, "Nonce must not be consumed when Phase A rejects");

      // Competing claimRun must have succeeded once admissionMutex was freed
      assert.equal(claimRes.status, "fulfilled", "claimRun must succeed without deadlock");
      assert.equal(claimRes.value.status, "active");
      assert.equal(run2.status, "active");

      run1.cleanup();
      run2.cleanup();
      console.log("    -> PASSED: Zero deadlock between in-flight action and Phase A. Nonce preserved.");
    }

    // Test 1.2: Concurrency during run settlement/finalization vs Phase A
    console.log("  [Test 1.2] Concurrency between _runFinalizeWorker (settlement) and handleControllerSession");
    {
      const ctrlA = await newController("ctrlA-settlement");
      const runA = await service.createRun({ maxActions: 2 });
      const leaseA = await service.claimRun(ctrlA, { model_name: "Model Settlement" });
      assert.equal(runA.status, "active");

      // Start settlement asynchronously
      const finalizePromise = runA._startFinalize("action_limit", "Reached limit");

      const nonceBefore = service.mcpBootstrapNonce;

      // Launch multiple concurrent handleControllerSession requests during settlement
      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("DEADLOCK DETECTED in Test 1.2! Timeout after 4000ms")), 4000);
        timer.unref?.();
      });

      const reqCount = 5;
      const sessionAttempts = Array.from({ length: reqCount }, (_, i) =>
        service.handleControllerSession(
          nonceBefore,
          { name: `ctrlA-reclaim-${i}` },
          { previousRunId: runA.runId }
        )
      );

      const allResults = await Promise.race([
        Promise.allSettled([finalizePromise, ...sessionAttempts]),
        timeoutPromise
      ]);

      assert.equal(allResults[0].status, "fulfilled", "Finalization initiation must complete");

      // While finalizing or after terminal commit, any attempt before terminal completion must be RUN_RESUME_REQUIRED
      const sessionResults = allResults.slice(1);
      let successCount = 0;
      let rejectResumeRequiredCount = 0;
      let rejectForbiddenCount = 0;

      for (const res of sessionResults) {
        if (res.status === "fulfilled") {
          successCount++;
          assert.ok(res.value.controller_token);
          assert.deepEqual(res.value.previous_run, {
            run_id: runA.runId,
            ended: true,
            status: "action_limit"
          });
        } else {
          if (res.reason.code === "RUN_RESUME_REQUIRED") {
            rejectResumeRequiredCount++;
            // During finalizing or active, status_name is active or finalizing
            assert.ok(["active", "finalizing"].includes(res.reason.status_name));
          } else if (res.reason.status === 403 || res.reason.code === "FORBIDDEN") {
            rejectForbiddenCount++;
          } else {
            assert.fail(`Unexpected rejection code: ${res.reason.code} / status: ${res.reason.status}`);
          }
        }
      }

      console.log(`    -> Concurrent session results: ${successCount} succeeded, ${rejectResumeRequiredCount} hit pre-terminal lock (active/finalizing), ${rejectForbiddenCount} hit rotated nonce`);
      assert.equal(sessionResults.length, reqCount, "All session requests must settle without deadlock");

      // Wait for _runFinalizeWorker to complete writing summary and committing terminal record
      const startWait = Date.now();
      while (!TERMINAL_STATUSES.has(runA.status) && Date.now() - startWait < 2000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(TERMINAL_STATUSES.has(runA.status), true, "Run must transition to terminal status");
      assert.equal(runA.status, "action_limit");

      // Now with the current valid nonce, a fresh attempt MUST succeed now that run is terminal
      const currentNonce = service.mcpBootstrapNonce;
      const postSettlementRes = await service.handleControllerSession(
        currentNonce,
        { name: "ctrlA-post-settle" },
        { previousRunId: runA.runId }
      );
      assert.ok(postSettlementRes.controller_token);
      assert.equal(postSettlementRes.previous_run.ended, true);
      assert.equal(postSettlementRes.previous_run.status, "action_limit");

      runA.cleanup();
      console.log("    -> PASSED: Settlement concurrency serialized safely. Pre-terminal (finalizing) rejected, terminal succeeded.");
    }

    // Test 1.3: Interleaved Concurrency Flood (Fuzzing Lock Inversion)
    console.log("  [Test 1.3] Interleaved flood: 25 concurrent mixed operations across multiple runs");
    {
      const runFlood1 = await service.createRun({ maxActions: 20 });
      const ctrlF1 = await newController("flood-ctrl-1");
      const leaseF1 = await service.claimRun(ctrlF1, { model_name: "Flood 1" });

      const runFlood2 = await service.createRun({ maxActions: 20 });
      const ctrlF2 = await newController("flood-ctrl-2");
      const leaseF2 = await service.claimRun(ctrlF2, { model_name: "Flood 2" });

      // Put runFlood1 into won
      await runFlood1._startFinalize("won", "Instant win for test");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(runFlood1.status, "won");

      const ops = [];
      const deadlockTimer = new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error("DEADLOCK DETECTED in Test 1.3 Interleaved Flood!")), 5000);
        t.unref?.();
      });

      // 5x handleControllerSession on terminal runFlood1
      for (let i = 0; i < 5; i++) {
        ops.push(
          (async () => {
            try {
              // Using whatever current nonce exists at moment of execution
              return await service.handleControllerSession(
                service.mcpBootstrapNonce,
                { name: `flood-sess-${i}` },
                { previousRunId: runFlood1.runId }
              );
            } catch (err) {
              return { error: err.code || err.message };
            }
          })()
        );
      }

      // 5x handleControllerSession on active runFlood2 (must fail with RUN_RESUME_REQUIRED)
      for (let i = 0; i < 5; i++) {
        ops.push(
          (async () => {
            try {
              return await service.handleControllerSession(
                service.mcpBootstrapNonce,
                { name: `flood-active-${i}` },
                { previousRunId: runFlood2.runId }
              );
            } catch (err) {
              return { error: err.code || err.message };
            }
          })()
        );
      }

      // 5x executeAction on active runFlood2
      for (let i = 0; i < 5; i++) {
        ops.push(
          (async () => {
            try {
              return await runFlood2.executeAction(
                ctrlF2,
                leaseF2.lease_id,
                leaseF2.lease_epoch,
                "right",
                {},
                `op-flood-${i}`
              );
            } catch (err) {
              return { error: err.code || err.message };
            }
          })()
        );
      }

      // 5x observe on runFlood2
      for (let i = 0; i < 5; i++) {
        ops.push(
          (async () => {
            try {
              return await runFlood2.observe(ctrlF2);
            } catch (err) {
              return { error: err.code || err.message };
            }
          })()
        );
      }

      // 5x createResumeRequest on terminal runFlood1 (must throw RUN_ENDED)
      for (let i = 0; i < 5; i++) {
        ops.push(
          (async () => {
            try {
              return await service.createResumeRequest(ctrlF2, runFlood1.runId);
            } catch (err) {
              return { error: err.code || err.message };
            }
          })()
        );
      }

      const settledOps = await Promise.race([
        Promise.all(ops),
        deadlockTimer
      ]);

      assert.equal(settledOps.length, 25, "All 25 interleaved operations completed without hanging");
      runFlood1.cleanup();
      runFlood2.cleanup();
      console.log("    -> PASSED: 25 interleaved mixed operations completed with ZERO deadlocks.");
    }

    // -------------------------------------------------------------------------
    // SECTION 2: Old Controller Binding Cleanup & Complete Revocation of Control
    // -------------------------------------------------------------------------
    console.log("\n[Section 2] Old Controller Binding Cleanup & Complete Revocation of Control");

    console.log("  [Test 2.1] Complete binding removal & inability to execute actions, heartbeat, observe, or resume");
    {
      const ctrlOld = await newController("ctrl-old-original");
      const runTerminal = await service.createRun({ maxActions: 10 });
      const leaseOld = await service.claimRun(ctrlOld, { model_name: "Original Model" });

      assert.equal(service.controllerRunBindings.get(ctrlOld.controllerId), runTerminal.runId);

      // Transition runTerminal to "timed_out"
      await runTerminal._startFinalize("timed_out", "Wall clock expired");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(runTerminal.status, "timed_out");

      // Verify binding cleanup via handleControllerSession Phase A
      const sessionRes = await service.handleControllerSession(
        service.mcpBootstrapNonce,
        { name: "ctrl-new-reconnect" },
        { previousRunId: runTerminal.runId }
      );
      assert.ok(sessionRes.controller_token);
      assert.deepEqual(sessionRes.previous_run, {
        run_id: runTerminal.runId,
        ended: true,
        status: "timed_out"
      });

      // Assert binding is completely purged
      assert.equal(service.controllerRunBindings.has(ctrlOld.controllerId), false, "Old binding must be deleted");
      assert.equal(service.controllerRunBindings.get(ctrlOld.controllerId), undefined);

      // Assert Old Controller CANNOT execute action
      await assert.rejects(
        runTerminal.executeAction(ctrlOld, leaseOld.lease_id, leaseOld.lease_epoch, "up", {}, "op-old-1"),
        (err) => {
          assert.equal(err.status, 409);
          assert.ok(err.message.includes("timed_out"));
          return true;
        },
        "Old controller must be rejected from executeAction on terminal run"
      );

      // Assert Old Controller CANNOT heartbeat
      await assert.rejects(
        runTerminal.heartbeat(ctrlOld, leaseOld.lease_id, leaseOld.lease_epoch),
        (err) => {
          assert.equal(err.status, 409);
          assert.ok(err.message.includes("timed_out"));
          return true;
        },
        "Old controller must be rejected from heartbeat on terminal run"
      );

      // Assert Old Controller CANNOT observe
      await assert.rejects(
        runTerminal.observe(ctrlOld),
        (err) => {
          assert.equal(err.status, 409);
          assert.ok(err.message.includes("timed_out"));
          return true;
        },
        "Old controller must be rejected from observe on terminal run"
      );

      // Assert Old Controller CANNOT resume
      await assert.rejects(
        service.createResumeRequest(ctrlOld, runTerminal.runId),
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, "RUN_ENDED");
          assert.equal(err.ended, true);
          return true;
        },
        "Old controller must be rejected from createResumeRequest with 409 RUN_ENDED"
      );

      runTerminal.cleanup();
      console.log("    -> PASSED: Old binding purged; all control APIs (action, heartbeat, observe, resume) rejected.");
    }

    console.log("  [Test 2.2] Old controller and new controller can independently claim fresh runs without ALREADY_BOUND");
    {
      const ctrlPrior = await newController("ctrl-prior-holder");
      const runPrior = await service.createRun({ maxActions: 5 });
      await service.claimRun(ctrlPrior, { model_name: "Prior Model" });

      // Run ends by cancellation
      await runPrior.cancelRun();
      assert.equal(runPrior.status, "finalizing");
      // Wait for finalize worker
      const startWaitPrior = Date.now();
      while (!TERMINAL_STATUSES.has(runPrior.status) && Date.now() - startWaitPrior < 2000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(runPrior.status, "cancelled");

      // Clear binding via handleControllerSession with previousRunId
      const newSession = await service.handleControllerSession(
        service.mcpBootstrapNonce,
        { name: "ctrl-next-holder" },
        { previousRunId: runPrior.runId }
      );
      const ctrlNext = service.validateControllerToken(`Bearer ${newSession.controller_token}`);

      // 1. Old controller (whose token is still valid) must be able to claim a new run without ALREADY_BOUND conflict
      const freshRun1 = await service.createRun({ maxActions: 5 });
      const claim1 = await service.claimRun(ctrlPrior, { model_name: "Prior Model Reused" });
      assert.equal(claim1.run_id, freshRun1.runId);
      assert.equal(service.controllerRunBindings.get(ctrlPrior.controllerId), freshRun1.runId);

      // 2. New controller must also be able to claim the next run
      const freshRun2 = await service.createRun({ maxActions: 5 });
      const claim2 = await service.claimRun(ctrlNext, { model_name: "Next Model" });
      assert.equal(claim2.run_id, freshRun2.runId);
      assert.equal(service.controllerRunBindings.get(ctrlNext.controllerId), freshRun2.runId);

      // 3. Both bindings are distinct and correctly tracked
      assert.notEqual(
        service.controllerRunBindings.get(ctrlPrior.controllerId),
        service.controllerRunBindings.get(ctrlNext.controllerId)
      );

      freshRun1.cleanup();
      freshRun2.cleanup();
      runPrior.cleanup();
      console.log("    -> PASSED: Both old and new controllers successfully claim distinct fresh seats without 409 ALREADY_BOUND.");
    }

    // -------------------------------------------------------------------------
    // SECTION 3: createResumeRequest Stability Across ALL 5 Terminal Statuses
    // -------------------------------------------------------------------------
    console.log("\n[Section 3] createResumeRequest Stability Verification Across Terminal Statuses");

    const terminalStatuses = ["won", "action_limit", "timed_out", "cancelled", "failed"];

    for (const status of terminalStatuses) {
      console.log(`  [Test 3.${terminalStatuses.indexOf(status) + 1}] Terminal status "${status}" returns 409 RUN_ENDED`);
      const ctrlT = await newController(`ctrl-test-${status}`);
      const runT = await service.createRun({ maxActions: 5 });
      await service.claimRun(ctrlT, { model_name: `Model ${status}` });

      if (status === "won") {
        await runT._startFinalize("won", "Goal reached");
      } else if (status === "action_limit") {
        await runT._startFinalize("action_limit", "Limit hit");
      } else if (status === "timed_out") {
        await runT._startFinalize("timed_out", "Time expired");
      } else if (status === "cancelled") {
        await runT.cancelRun();
      } else if (status === "failed") {
        await runT._recordFinalizeFailure(new Error("Synthetic failure"));
      }

      await new Promise((r) => setTimeout(r, 60));
      assert.equal(runT.status, status, `Run status must be ${status}`);

      // Attempt createResumeRequest on this terminal run
      const resumeCtrl = await newController(`ctrl-resume-${status}`);
      await assert.rejects(
        service.createResumeRequest(resumeCtrl, runT.runId),
        (err) => {
          assert.equal(err.status, 409, `HTTP status must be 409 for ${status}`);
          assert.equal(err.code, "RUN_ENDED", `Error code must be RUN_ENDED for ${status}`);
          assert.equal(err.run_id, runT.runId);
          assert.equal(err.status_name, status);
          assert.equal(err.ended, true);
          assert.ok(err.message.includes(`already ended with status ${status}`));
          return true;
        },
        `createResumeRequest must throw 409 RUN_ENDED for terminal status: ${status}`
      );

      // Verify no leaked pending requests or indexes
      assert.equal(service.controllerResumeIndex.has(resumeCtrl.controllerId), false, "No index entry should be created");
      for (const req of service.resumeRequests.values()) {
        assert.notEqual(req.runId, runT.runId, "No pending request should be recorded for terminal run");
      }

      runT.cleanup();
    }
    console.log("    -> PASSED: All 5 terminal statuses consistently return 409 RUN_ENDED with full structure.");

    console.log("  [Test 3.6] Non-terminal status contrast: armed, active, non-existent, invalid args");
    {
      const ctrlC = await newController("ctrl-contrast");

      // 1. armed run -> 409 CONFLICT ("still armed; use start to claim it"), NOT RUN_ENDED
      const armedRun = await service.createRun({ maxActions: 5 });
      await assert.rejects(
        service.createResumeRequest(ctrlC, armedRun.runId),
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.code, "CONFLICT");
          assert.ok(err.message.includes("still armed"));
          return true;
        },
        "Armed run must reject with 409 CONFLICT"
      );

      // 2. active run -> returns pending resume request
      const activeClaim = await service.claimRun(ctrlC, { model_name: "Model Active" });
      const applicantCtrl = await newController("ctrl-applicant");
      const pendingRes = await service.createResumeRequest(applicantCtrl, armedRun.runId);
      assert.equal(pendingRes.status, "pending_approval");
      assert.ok(pendingRes.review_url);
      assert.equal(pendingRes.run_id, armedRun.runId);

      // 3. non-existent run -> 404 NOT_FOUND
      await assert.rejects(
        service.createResumeRequest(ctrlC, "ext-non-existent-1234"),
        (err) => {
          assert.equal(err.status, 404);
          assert.equal(err.code, "NOT_FOUND");
          return true;
        },
        "Non-existent run must reject with 404 NOT_FOUND"
      );

      // 4. invalid arguments -> 400 INVALID_ARGUMENT
      await assert.rejects(
        service.createResumeRequest(ctrlC, null),
        (err) => {
          assert.equal(err.status, 400);
          assert.equal(err.code, "INVALID_ARGUMENT");
          return true;
        },
        "Missing run_id must reject with 400 INVALID_ARGUMENT"
      );

      armedRun.cleanup();
      console.log("    -> PASSED: Non-terminal contrast verified (armed=409 CONFLICT, active=pending, 404 NOT_FOUND, 400 INVALID_ARGUMENT).");
    }

    console.log("\n================================================================================");
    console.log("ALL ADVERSARIAL EMPIRICAL CHALLENGES FOR MILESTONE 1 PASSED WITH ZERO FAILURES!");
    console.log("================================================================================");
  } finally {
    if (service) {
      service.shutdown();
    }
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runAdversarialM1Challenge().catch((err) => {
    console.error("Adversarial Challenge FAILED:", err);
    process.exit(1);
  });
}

module.exports = { runAdversarialM1Challenge };
