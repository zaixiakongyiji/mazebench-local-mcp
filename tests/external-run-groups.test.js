const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ExternalPlayService } = require("../server/external-play");
const { rankCompetitionEntries } = require("../server/run-rankings");

async function createController(service, name) {
  const session = await service.handleControllerSession(service.mcpBootstrapNonce, { name });
  return service.validateControllerToken(`Bearer ${session.controller_token}`);
}

async function waitForTerminal(run) {
  const deadline = Date.now() + 3000;
  while (!new Set(["won", "action_limit", "timed_out", "cancelled", "failed"]).has(run.status)) {
    if (Date.now() > deadline) throw new Error(`Run ${run.runId} did not finalize`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runTests() {
  console.log("Starting External Play run group tests...");
  const ranked = rankCompetitionEntries([
    { entry_id: "entry-8", run_id: "run-8", outcome: "action_limit", rooms_visited: 4, gems_collected: 2, novelty: 20, actions_total: 5 },
    { entry_id: "entry-7", run_id: "run-7", outcome: "action_limit", rooms_visited: 4, gems_collected: 2, novelty: 20, actions_total: 3 },
    { entry_id: "entry-6", run_id: "run-6", outcome: "cancelled", rooms_visited: 99, gems_collected: 99, novelty: 99, actions_total: 1 },
    { entry_id: "entry-5", run_id: "run-5", outcome: "action_limit", rooms_visited: 3, gems_collected: 1, novelty: 10, actions_total: 7 },
    { entry_id: "entry-4", run_id: "run-4", outcome: "won", rooms_visited: 1, gems_collected: 1, novelty: 1, actions_total: 99 },
    { entry_id: "entry-3", run_id: "run-3", outcome: "action_limit", rooms_visited: 4, gems_collected: 1, novelty: 10, actions_total: 7 },
    { entry_id: "entry-2", run_id: "run-2", outcome: "action_limit", rooms_visited: 4, gems_collected: 2, novelty: 10, actions_total: 9 },
    { entry_id: "entry-1", run_id: "run-1", outcome: "action_limit", rooms_visited: 4, gems_collected: 2, novelty: 20, actions_total: 5 }
  ]);
  assert.deepEqual(ranked.map((entry) => entry.entry_id), [
    "entry-4", "entry-7", "entry-1", "entry-8", "entry-2", "entry-3", "entry-5", "entry-6"
  ]);

  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-group-test-"));
  const service = new ExternalPlayService({ dataHome, port: 3017, defaultMaxActions: 1 });
  await service.initialize();

  try {
    await assert.rejects(
      service.createGroup({ mode: "competition", count: 1, maxActions: 1 }),
      (error) => error?.status === 400 && error?.code === "INVALID_ARGUMENT"
    );
    await assert.rejects(
      service.createGroup({ mode: "concurrent", count: 9, maxActions: 1 }),
      (error) => error?.status === 400 && error?.code === "INVALID_ARGUMENT"
    );

    console.log("  [Test 1] model identity and harness registration");
    const standalone = await service.createRun({ maxActions: 1 });
    const standaloneController = await createController(service, "codex-test-harness");
    await assert.rejects(
      service.claimOrAttachRun(standaloneController, {}, "missing-model"),
      (error) => error?.status === 400 && error?.code === "INVALID_ARGUMENT"
    );
    await assert.rejects(
      service.claimOrAttachRun(standaloneController, { model_name: "bad\nname" }, "bad-model"),
      (error) => error?.status === 400 && error?.code === "INVALID_ARGUMENT"
    );
    await assert.rejects(
      service.claimOrAttachRun(standaloneController, { model_name: "x".repeat(129) }, "long-model"),
      (error) => error?.status === 400 && error?.code === "INVALID_ARGUMENT"
    );
    await assert.rejects(
      service.claimOrAttachRun(standaloneController, {
        run_id: "ext-00000000-0000-4000-8000-000000000000",
        model_name: "missing-run"
      }, "missing-run"),
      (error) => error?.status === 404 && error?.code === "NOT_FOUND"
    );

    const standaloneStart = await service.claimOrAttachRun(
      standaloneController,
      { model_name: "  gpt-5.6  " },
      "standalone-start"
    );
    assert.equal(standaloneStart.model_name, "gpt-5.6");
    assert.equal(standaloneStart.harness, "codex-test-harness");
    assert.equal(standaloneStart.instructions_version, "external-mcp-v1");
    assert.match(standaloneStart.run_instructions, /at most 1 game actions/);
    assert.ok(standaloneStart.observation?.current_room);

    const repeatAttach = await service.claimOrAttachRun(standaloneController, {}, "standalone-attach");
    assert.equal(repeatAttach.run_id, standalone.runId);
    assert.equal(repeatAttach.model_name, "gpt-5.6");

    const identityController = await createController(service, "another-harness");
    await assert.rejects(
      service.claimOrAttachRun(identityController, {
        run_id: standalone.runId,
        model_name: "different-model"
      }, "identity-mismatch"),
      (error) => error?.status === 409 && error?.code === "IDENTITY_MISMATCH"
    );

    standalone.currentLease.expiresAt = Date.now() - 1;
    const recoveryController = await createController(service, "recovery-harness");
    const recoveredAttach = await service.claimOrAttachRun(recoveryController, {
      run_id: standalone.runId,
      model_name: "gpt-5.6"
    }, "standalone-recovery");
    assert.equal(recoveredAttach.lease_epoch, 2);
    assert.equal(recoveredAttach.harness, "codex-test-harness", "The registered harness must remain immutable");

    await standalone.executeAction(
      recoveryController,
      recoveredAttach.lease_id,
      recoveredAttach.lease_epoch,
      "rotate_camera_left",
      {},
      "standalone-action"
    );
    await waitForTerminal(standalone);

    console.log("  [Test 2] atomic claims and frozen competition configuration");
    const competition = await service.createGroup({ mode: "competition", count: 8, maxActions: 1 });
    assert.equal(competition.status, "awaiting_claim");
    assert.equal(competition.entries.length, 8);
    assert.equal(service.activeGroupId, competition.group_id);
    await assert.rejects(
      service.createGroup({ mode: "concurrent", count: 2, maxActions: 1 }),
      (error) => error?.status === 409 && error?.code === "CONFLICT"
    );

    const groupRuns = competition.entries.map((entry) => service.getRun(entry.run_id));
    assert.equal(new Set(groupRuns.map((run) => run.worldBundleDigest)).size, 1);
    assert.equal(new Set(groupRuns.map((run) => run.baseViewerStateDigest)).size, 1);
    assert.ok(groupRuns.every((run) => run.maxActions === 1));

    const controllers = [];
    for (let index = 0; index < 8; index += 1) {
      controllers.push(await createController(service, `harness-${index + 1}`));
    }
    const starts = await Promise.all(controllers.map((controller, index) => service.claimOrAttachRun(
      controller,
      { model_name: index < 2 ? "duplicate-model" : `model-${index + 1}` },
      `group-start-${index + 1}`
    )));
    assert.equal(new Set(starts.map((start) => start.run_id)).size, 8);
    assert.ok(starts.every((start) => start.group_id === competition.group_id));
    assert.equal(service.activeGroupId, null);
    assert.equal(service.claimableRunIds.length, 0);

    const overflowController = await createController(service, "overflow-harness");
    await assert.rejects(
      service.claimOrAttachRun(overflowController, { model_name: "overflow-model" }, "overflow-start"),
      (error) => error?.status === 409 && error?.code === "NO_AVAILABLE_RUN"
    );

    console.log("  [Test 3] next group may wait while the prior group is running");
    const concurrent = await service.createGroup({ mode: "concurrent", count: 2, maxActions: 4 });
    assert.equal(service.activeGroupId, concurrent.group_id);
    assert.ok(groupRuns.every((run) => run.status === "active"));

    await Promise.all(starts.map((start, index) => groupRuns[index].executeAction(
      controllers[index],
      start.lease_id,
      start.lease_epoch,
      "rotate_camera_left",
      {},
      `group-action-${index + 1}`
    )));
    await Promise.all(groupRuns.map(waitForTerminal));

    const completedCompetition = service.getGroup(competition.group_id);
    assert.equal(completedCompetition.status, "completed");
    assert.equal(completedCompetition.result.ranking.length, 8);
    assert.deepEqual(
      completedCompetition.result.ranking.map((entry) => entry.entry_id),
      competition.entries.map((entry) => entry.entry_id)
    );
    assert.ok(completedCompetition.entries.every((entry) => entry.replay_url.includes(entry.run_id)));
    assert.equal(completedCompetition.entries.filter((entry) => entry.model_name === "duplicate-model").length, 2);

    const persistedRanking = JSON.stringify(completedCompetition.result.ranking);
    const cancelledConcurrent = await service.cancelGroup(concurrent.group_id);
    await Promise.all(concurrent.entries.map((entry) => waitForTerminal(service.getRun(entry.run_id))));
    const concurrentResult = service.getGroup(concurrent.group_id);
    assert.equal(cancelledConcurrent.group_id, concurrent.group_id);
    assert.equal(concurrentResult.status, "completed");
    assert.equal(concurrentResult.result.ranking, null);

    console.log("  [Test 4] group result and run identity survive restart");
    service.shutdown();
    const restarted = new ExternalPlayService({ dataHome, port: 3018, defaultMaxActions: 1 });
    await restarted.initialize();
    try {
      const recoveredCompetition = restarted.getGroup(competition.group_id);
      assert.equal(recoveredCompetition.status, "completed");
      assert.equal(JSON.stringify(recoveredCompetition.result.ranking), persistedRanking);
      assert.equal(restarted.getRun(starts[0].run_id).modelName, "duplicate-model");
      assert.equal(restarted.getRun(starts[0].run_id).harnessName, "harness-1");
      assert.ok(fs.existsSync(path.join(
        restarted.runsDir,
        starts[0].run_id,
        "summary.json"
      )));
    } finally {
      restarted.shutdown();
    }
  } finally {
    if (service.serviceState !== "SHUTDOWN") service.shutdown();
    fs.rmSync(dataHome, { recursive: true, force: true });
  }

  console.log("All External Play run group tests PASSED!");
}

runTests().catch((error) => {
  console.error("External Play run group tests failed:", error);
  process.exit(1);
});
