const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const {
  ExternalPlayService,
  RunInstance,
  validateJournalRecord,
  computeViewerStateHash
} = require("../server/external-play");

async function runAdversarialWALStressSuite() {
  console.log("================================================================================");
  console.log("Starting Milestone 1 (R1 WAL Authoritative Commit & Fault Tolerance) Stress Suite");
  console.log("================================================================================");

  const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-wal-stress-"));
  process.env.MAZEBENCH_DATA_HOME = testDataHome;

  let totalAssertions = 0;
  function pass() {
    totalAssertions++;
  }

  const originalAppendFileSync = fs.appendFileSync;

  try {
    const service = new ExternalPlayService({ dataHome: testDataHome, port: 3105 });
    await service.initialize();

    async function createAndClaimRun(tag, maxActions = 200) {
      const session = await service.handleControllerSession(service.mcpBootstrapNonce, { name: `ctrl-${tag}` });
      const ctrl = service.validateControllerToken(`Bearer ${session.controller_token}`);
      assert.ok(ctrl, `Controller token must be valid for ${tag}`);
      const run = await service.createRun({ maxActions });
      const lease = await service.claimRun(ctrl, { model_name: `StressModel-${tag}` });
      return { ctrl, run, lease };
    }

    // =========================================================================
    // Challenge Suite 1: Persistent Long-Run Projection Failure (50 Actions)
    // =========================================================================
    console.log("\n--- [Suite 1] Persistent Long-Run Projection Failure (50 consecutive actions) ---");
    {
      const { ctrl, run, lease } = await createAndClaimRun("suite1", 200);

      let appendFailureCount = 0;
      let failActionsAppend = true;

      fs.appendFileSync = function (filePath, data, options) {
        if (
          failActionsAppend &&
          typeof filePath === "string" &&
          filePath.includes(run.runId) &&
          filePath.endsWith("actions.jsonl")
        ) {
          appendFailureCount++;
          throw new Error(`Synthetic projection failure appending to actions.jsonl (attempt #${appendFailureCount})`);
        }
        return originalAppendFileSync.apply(this, arguments);
      };

      const NUM_ACTIONS = 50;
      const committedOpIds = [];
      const executionResults = [];

      try {
        for (let i = 1; i <= NUM_ACTIONS; i++) {
          const opId = `suite1-op-${i}-${crypto.randomUUID()}`;
          committedOpIds.push(opId);
          const tool = i % 2 === 0 ? "rotate_camera_left" : "rotate_camera_right";

          const result = await run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            tool,
            {},
            opId
          );

          assert.ok(result, `Action #${i} must return a valid MCP response despite projection failure`);
          assert.equal(result.isError, false, `Action #${i} must not be marked as error`);
          const parsed = JSON.parse(result.content[0].text);
          assert.equal(parsed.action_seq, i, `action_seq must be exactly ${i}`);
          assert.equal(parsed.status, "active");
          executionResults.push(result);
          pass();
        }

        assert.equal(appendFailureCount, NUM_ACTIONS, `All ${NUM_ACTIONS} actions must have triggered projection failure`);
        pass();

        // Verify WAL on disk
        const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        const actionRecords = journalLines.filter((r) => r.type === "action_committed");
        assert.equal(actionRecords.length, NUM_ACTIONS, `WAL must persist exactly ${NUM_ACTIONS} action_committed records`);
        pass();

        // Verify contiguous journal_seq in WAL
        for (let i = 0; i < journalLines.length; i++) {
          assert.equal(journalLines[i].journal_seq, i + 1, `WAL record at index ${i} must have journal_seq ${i + 1}`);
        }
        pass();

        // Verify in-memory state
        assert.equal(run.lastJournalSeq, journalLines.length, "In-memory lastJournalSeq must match disk WAL total length");
        assert.equal(run.lastActionSeq, NUM_ACTIONS, `In-memory lastActionSeq must be ${NUM_ACTIONS}`);
        for (const opId of committedOpIds) {
          assert.ok(run.operationIndex.has(opId), `operationIndex must contain ${opId}`);
        }
        pass();

        // Verify actions.jsonl on disk is empty because every append failed
        let actionsContent = "";
        if (fs.existsSync(run.actionsPath)) {
          actionsContent = fs.readFileSync(run.actionsPath, "utf8").trim();
        }
        assert.equal(actionsContent, "", "actions.jsonl must remain empty due to persistent failure");
        pass();

        // Turn off failure injection for recovery
        failActionsAppend = false;

        // Crash simulation: instantiate fresh RunInstance and replayJournal
        const recoveredRun = new RunInstance(
          service,
          run.runId,
          run.runDir,
          run.manifest
        );

        await recoveredRun.replayJournal();

        assert.equal(recoveredRun.lastJournalSeq, run.lastJournalSeq, "Recovered lastJournalSeq must match original");
        assert.equal(recoveredRun.lastActionSeq, NUM_ACTIONS, `Recovered lastActionSeq must be ${NUM_ACTIONS}`);
        assert.equal(recoveredRun.currentViewerStateHash, run.currentViewerStateHash, "Recovered viewerStateHash must match");
        pass();

        // Verify actions.jsonl was completely reconciled and reconstructed from WAL
        const recoveredActions = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
        assert.equal(recoveredActions.length, NUM_ACTIONS, `Reconstructed actions.jsonl must contain all ${NUM_ACTIONS} actions`);
        for (let i = 0; i < NUM_ACTIONS; i++) {
          assert.equal(recoveredActions[i].seq, i + 1, `Reconstructed action ${i} must have seq ${i + 1}`);
          assert.equal(recoveredActions[i].valid, true);
          assert.equal(recoveredActions[i].accepted, true);
        }
        pass();

        // Verify that on the recovered run, subsequent actions continue seamlessly
        const continueOpId = `suite1-continue-op-${crypto.randomUUID()}`;
        const continueResult = await recoveredRun.executeAction(
          ctrl,
          lease.lease_id,
          lease.lease_epoch,
          "rotate_camera_left",
          {},
          continueOpId
        );
        assert.ok(continueResult);
        const parsedContinue = JSON.parse(continueResult.content[0].text);
        assert.equal(parsedContinue.action_seq, NUM_ACTIONS + 1, `Continued action_seq must be ${NUM_ACTIONS + 1}`);

        const postContinueActions = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(postContinueActions.length, NUM_ACTIONS + 1, "actions.jsonl must now have 51 actions");
        pass();

        recoveredRun.cleanup();
      } finally {
        fs.appendFileSync = originalAppendFileSync;
        run.cleanup();
      }
    }

    // =========================================================================
    // Challenge Suite 2: Flapping Projection Failure + Idempotency Retries
    // =========================================================================
    console.log("\n--- [Suite 2] Flapping Projection Failure & Interleaved Idempotency Retries ---");
    {
      const { ctrl, run, lease } = await createAndClaimRun("suite2", 150);

      let flappingFail = false;
      let totalFlapInjections = 0;

      fs.appendFileSync = function (filePath, data, options) {
        if (
          flappingFail &&
          typeof filePath === "string" &&
          filePath.includes(run.runId) &&
          filePath.endsWith("actions.jsonl")
        ) {
          totalFlapInjections++;
          throw new Error("Synthetic intermittent projection failure");
        }
        return originalAppendFileSync.apply(this, arguments);
      };

      try {
        const opRecords = []; // { opId, result, tool }
        const NUM_STEPS = 25;

        for (let step = 1; step <= NUM_STEPS; step++) {
          flappingFail = step % 2 === 0; // Fail on even steps

          const opId = `suite2-op-${step}`;
          const tool = step % 3 === 0 ? "rotate_camera_up" : "rotate_camera_left";

          // Execute action
          const result = await run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            tool,
            {},
            opId
          );
          assert.ok(result);
          opRecords.push({ opId, result, tool, step });
          pass();

          // Immediately retry same opId multiple times (burst retries)
          const burstRetries = (step % 3) + 1; // 1 to 3 retries
          for (let r = 1; r <= burstRetries; r++) {
            // Even if flappingFail is true or false, idempotency cache should return immediately without writing
            const retryRes = await run.executeAction(
              ctrl,
              lease.lease_id,
              lease.lease_epoch,
              tool,
              {},
              opId
            );
            assert.deepEqual(retryRes, result, `Idempotent retry #${r} for ${opId} must return byte-identical result`);
            pass();
          }

          // Randomly retry an OLD opId from previous steps
          if (step > 3 && step % 4 === 0) {
            const oldTarget = opRecords[Math.floor(Math.random() * (opRecords.length - 1))];
            const oldRetryRes = await run.executeAction(
              ctrl,
              lease.lease_id,
              lease.lease_epoch,
              oldTarget.tool,
              {},
              oldTarget.opId
            );
            assert.deepEqual(oldRetryRes, oldTarget.result, `Old op retry for ${oldTarget.opId} must match cached result`);
            pass();
          }
        }

        // Verify WAL integrity
        const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        const actionRecords = journalLines.filter((r) => r.type === "action_committed");
        assert.equal(actionRecords.length, NUM_STEPS, `WAL must have exactly ${NUM_STEPS} action_committed records despite retries`);
        pass();

        // Verify contiguous journal_seq
        for (let i = 0; i < journalLines.length; i++) {
          assert.equal(journalLines[i].journal_seq, i + 1, `journal_seq at ${i} must be ${i + 1}`);
        }
        pass();

        // Verify total flap injections occurred
        assert.ok(totalFlapInjections > 0, "Flapping injection must have occurred");

        // Crash and replay test
        flappingFail = false;
        const replayRun = new RunInstance(
          service,
          run.runId,
          run.runDir,
          run.manifest
        );
        await replayRun.replayJournal();

        assert.equal(replayRun.lastJournalSeq, run.lastJournalSeq);
        assert.equal(replayRun.lastActionSeq, NUM_STEPS);
        const replayedActionLines = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(replayedActionLines.length, NUM_STEPS, "Replay must heal actions.jsonl to exactly NUM_STEPS");
        pass();

        replayRun.cleanup();
      } finally {
        fs.appendFileSync = originalAppendFileSync;
        run.cleanup();
      }
    }

    // =========================================================================
    // Challenge Suite 3: Concurrent Operations Flood under Projection Failure
    // =========================================================================
    console.log("\n--- [Suite 3] Concurrent Request Flood with Duplicates & Projection Failure ---");
    {
      const { ctrl, run, lease } = await createAndClaimRun("suite3", 100);

      let concurrentFailCount = 0;
      fs.appendFileSync = function (filePath, data, options) {
        if (
          typeof filePath === "string" &&
          filePath.includes(run.runId) &&
          filePath.endsWith("actions.jsonl")
        ) {
          concurrentFailCount++;
          throw new Error("Synthetic projection failure under concurrent flood");
        }
        return originalAppendFileSync.apply(this, arguments);
      };

      try {
        const UNIQUE_OPS = 10;
        const DUPLICATES_PER_OP = 3; // 10 unique + 30 duplicates = 40 total concurrent promises
        const uniqueOpIds = Array.from({ length: UNIQUE_OPS }, (_, i) => `concurrent-op-${i}`);

        // Assemble all 40 promises in an interleaved/shuffled array
        const callDescriptors = [];
        for (let i = 0; i < UNIQUE_OPS; i++) {
          const opId = uniqueOpIds[i];
          // 1 original + DUPLICATES_PER_OP retries
          for (let d = 0; d <= DUPLICATES_PER_OP; d++) {
            callDescriptors.push({ opId, tool: "rotate_camera_left" });
          }
        }

        // Shuffle descriptors to simulate out-of-order network arrival
        callDescriptors.sort(() => Math.random() - 0.5);

        // Execute all 40 calls concurrently
        const results = await Promise.all(
          callDescriptors.map(async (desc) => {
            return {
              opId: desc.opId,
              res: await run.executeAction(
                ctrl,
                lease.lease_id,
                lease.lease_epoch,
                desc.tool,
                {},
                desc.opId
              )
            };
          })
        );

        assert.equal(results.length, callDescriptors.length);
        pass();

        // Group results by opId and verify all duplicate calls returned identical payloads
        const grouped = new Map();
        for (const r of results) {
          if (!grouped.has(r.opId)) grouped.set(r.opId, []);
          grouped.get(r.opId).push(r.res);
        }

        for (const [opId, resList] of grouped.entries()) {
          const first = resList[0];
          assert.ok(first, `First result for ${opId} must exist`);
          for (let i = 1; i < resList.length; i++) {
            assert.deepEqual(resList[i], first, `Concurrent duplicate ${i} for ${opId} must be identical`);
          }
        }
        pass();

        // Verify WAL has EXACTLY UNIQUE_OPS new action_committed records
        const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        const actionRecords = journalLines.filter((r) => r.type === "action_committed");
        assert.equal(actionRecords.length, UNIQUE_OPS, `WAL must contain exactly ${UNIQUE_OPS} action_committed entries`);
        pass();

        // Verify sequence continuity
        for (let i = 0; i < journalLines.length; i++) {
          assert.equal(journalLines[i].journal_seq, i + 1, `journal_seq at ${i} must be ${i + 1}`);
        }
        pass();

        // Verify recovery after concurrent flood
        fs.appendFileSync = originalAppendFileSync;
        const replayRun = new RunInstance(
          service,
          run.runId,
          run.runDir,
          run.manifest
        );
        await replayRun.replayJournal();
        assert.equal(replayRun.lastActionSeq, UNIQUE_OPS);
        const replayedLines = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(replayedLines.length, UNIQUE_OPS, "Replay must heal actions.jsonl to exactly UNIQUE_OPS");
        pass();

        replayRun.cleanup();
      } finally {
        fs.appendFileSync = originalAppendFileSync;
        run.cleanup();
      }
    }

    // =========================================================================
    // Challenge Suite 4: Notification / Watermark Broadcast Failure Tolerance
    // =========================================================================
    console.log("\n--- [Suite 4] Projection Broadcast (_publishJournalRecord) Failure Tolerance ---");
    {
      const { ctrl, run, lease } = await createAndClaimRun("suite4", 50);

      // Monkey-patch _publishJournalRecord to throw an unexpected error
      const originalPublish = run._publishJournalRecord;
      let publishCrashCount = 0;
      run._publishJournalRecord = function (record) {
        publishCrashCount++;
        throw new Error("Synthetic unhandled SSE broadcast socket failure");
      };

      try {
        const opId1 = "suite4-publish-fail-1";
        const res1 = await run.executeAction(
          ctrl,
          lease.lease_id,
          lease.lease_epoch,
          "rotate_camera_left",
          {},
          opId1
        );

        assert.ok(res1, "executeAction must succeed even when _publishJournalRecord throws");
        assert.equal(publishCrashCount, 1);
        pass();

        // WAL must be safely written
        const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        const lastRec = journalLines[journalLines.length - 1];
        assert.equal(lastRec.type, "action_committed");
        assert.equal(lastRec.operation_id, opId1);
        assert.equal(run.lastJournalSeq, lastRec.journal_seq);
        assert.ok(run.operationIndex.has(opId1));
        pass();

        // Idempotency retry must still work
        const retryRes = await run.executeAction(
          ctrl,
          lease.lease_id,
          lease.lease_epoch,
          "rotate_camera_left",
          {},
          opId1
        );
        assert.deepEqual(retryRes, res1);
        pass();

        // Restore _publishJournalRecord
        run._publishJournalRecord = originalPublish;

        // Subsequent action succeeds normally
        const opId2 = "suite4-publish-ok-2";
        const res2 = await run.executeAction(
          ctrl,
          lease.lease_id,
          lease.lease_epoch,
          "rotate_camera_right",
          {},
          opId2
        );
        assert.ok(res2);
        pass();
      } finally {
        run._publishJournalRecord = originalPublish;
        run.cleanup();
      }
    }

    // =========================================================================
    // Challenge Suite 5: Recovery Against Truncated / Corrupted actions.jsonl
    // =========================================================================
    console.log("\n--- [Suite 5] Recovery Integrity Against Truncated / Garbage actions.jsonl ---");
    {
      const { ctrl, run, lease } = await createAndClaimRun("suite5", 50);

      try {
        // Execute 5 valid actions
        for (let i = 1; i <= 5; i++) {
          await run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            "rotate_camera_left",
            {},
            `suite5-op-${i}`
          );
        }
        assert.equal(run.lastActionSeq, 5);
        pass();

        // Scenario 5A: Truncated mid-line in actions.jsonl (simulating mid-flush power loss)
        const validActionsContent = fs.readFileSync(run.actionsPath, "utf8");
        const truncatedContent = validActionsContent.slice(0, 150); // Cut in the middle of a JSON string
        fs.writeFileSync(run.actionsPath, truncatedContent, "utf8");

        const replayRunA = new RunInstance(service, run.runId, run.runDir, run.manifest);
        await replayRunA.replayJournal();
        assert.equal(replayRunA.lastActionSeq, 5);
        const fixedActionsA = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(fixedActionsA.length, 5, "replayJournal must repair truncated actions.jsonl back to 5 actions");
        replayRunA.cleanup();
        pass();

        // Scenario 5B: Completely corrupted binary/garbage in actions.jsonl
        fs.writeFileSync(run.actionsPath, "GARBAGE_NON_JSON_CORRUPT_BYTES_XYZ!@#$%^&*()", "utf8");

        const replayRunB = new RunInstance(service, run.runId, run.runDir, run.manifest);
        await replayRunB.replayJournal();
        assert.equal(replayRunB.lastActionSeq, 5);
        const fixedActionsB = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(fixedActionsB.length, 5, "replayJournal must overwrite garbage with clean authoritative records");
        replayRunB.cleanup();
        pass();

        // Scenario 5C: Desynchronized lines (e.g. actions.jsonl has action 1, 2, but missing 3, 4, 5)
        const partialLines = fixedActionsB.slice(0, 2).join("\n") + "\n";
        fs.writeFileSync(run.actionsPath, partialLines, "utf8");

        const replayRunC = new RunInstance(service, run.runId, run.runDir, run.manifest);
        await replayRunC.replayJournal();
        assert.equal(replayRunC.lastActionSeq, 5);
        const fixedActionsC = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(fixedActionsC.length, 5, "replayJournal must heal desynchronized actions.jsonl to 5 actions");

        // Scenario 5D: Continue execution on replayRunC
        const res6 = await replayRunC.executeAction(
          ctrl,
          lease.lease_id,
          lease.lease_epoch,
          "rotate_camera_right",
          {},
          "suite5-op-6"
        );
        assert.ok(res6);
        const parsed6 = JSON.parse(res6.content[0].text);
        assert.equal(parsed6.action_seq, 6);

        const actionsAfter6 = fs.readFileSync(run.actionsPath, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(actionsAfter6.length, 6, "actions.jsonl must now cleanly contain 6 actions");
        replayRunC.cleanup();
        pass();
      } finally {
        run.cleanup();
      }
    }

    // =========================================================================
    // Challenge Suite 6: Idempotency Conflict & Cross-Controller Defense
    // =========================================================================
    console.log("\n--- [Suite 6] Idempotency Conflict & Cross-Controller Attack Defense ---");
    {
      const { ctrl, run, lease } = await createAndClaimRun("suite6", 50);
      const sessionEvil = await service.handleControllerSession(service.mcpBootstrapNonce, { name: "ctrl-suite6-evil" });
      const ctrlEvil = service.validateControllerToken(`Bearer ${sessionEvil.controller_token}`);

      try {
        const opId = "suite6-test-op";
        const res = await run.executeAction(
          ctrl,
          lease.lease_id,
          lease.lease_epoch,
          "rotate_camera_left",
          {},
          opId
        );
        assert.ok(res);
        const seqBefore = run.lastJournalSeq;
        pass();

        // 6A: Same opId with different arguments (different tool)
        await assert.rejects(
          run.executeAction(
            ctrl,
            lease.lease_id,
            lease.lease_epoch,
            "rotate_camera_right", // Different tool!
            {},
            opId
          ),
          (err) => {
            assert.equal(err?.status, 409);
            assert.equal(err?.code, "IDEMPOTENCY_CONFLICT");
            return true;
          },
          "Must reject modified arguments on same opId with 409 IDEMPOTENCY_CONFLICT"
        );
        pass();

        // 6B: Same opId with different controller
        await assert.rejects(
          run.executeAction(
            ctrlEvil,
            lease.lease_id,
            lease.lease_epoch,
            "rotate_camera_left",
            {},
            opId
          ),
          (err) => {
            assert.equal(err?.status, 409);
            return true;
          },
          "Must reject cross-controller reuse of opId"
        );
        pass();

        // Invariant: lastJournalSeq and WAL content MUST remain completely unchanged
        assert.equal(run.lastJournalSeq, seqBefore, "lastJournalSeq must NOT advance on idempotency conflict");
        const journalLines = fs.readFileSync(run.journalPath, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(journalLines[journalLines.length - 1].journal_seq, seqBefore);
        pass();
      } finally {
        run.cleanup();
      }
    }

    service.shutdown();

    console.log("\n================================================================================");
    console.log(`ALL Milestone 1 Adversarial Challenges PASSED! Total Assertions: ${totalAssertions}`);
    console.log("================================================================================\n");
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    fs.rmSync(testDataHome, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runAdversarialWALStressSuite().catch((err) => {
    console.error("Adversarial WAL Stress Suite FAILED:", err);
    process.exit(1);
  });
}

module.exports = { runAdversarialWALStressSuite };
