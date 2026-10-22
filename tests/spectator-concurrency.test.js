const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
function sourceBetween(file, start, end) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, "必须加载实际生产函数");
  return source.slice(from, to);
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

function queueContext(kind) {
  const blob = deferred();
  const applied = [];
  const fetched = [];
  const ctx = vm.createContext({
    currentGenerationId: 1, isProcessingQueue: false,
    actionQueue: [{ seq: 1, action: "right", [kind + "_digest"]: "old-blob" }],
    isEnded: false, totalActions: 0, isLiveMode: true, gemCount: 0,
    currentRoom: "initial", currentPlaybackStep: 0, dynamicStepDelayMs: 0,
    fetchAndVerifyBlob(digest) { fetched.push(digest); return blob.promise; },
    host: { async applyAction(action, transition, state) { applied.push(state || transition); } },
    visitedRooms: new Set(), updateStatsUI() {}, updateScrubberUI() {}, console,
    setTimeout(resolve) { resolve(); }
  });
  vm.runInContext(sourceBetween("public/external-play.js", "async function processActionQueue(", "function escapeText("), ctx);
  return { ctx, blob, applied, fetched };
}

for (const kind of ["transition", "post_viewer_state"]) {
  test("R1: 丢弃过期 " + kind + " blob 并接续新队列", async () => {
    const { ctx, blob, applied } = queueContext(kind);
    const oldWorker = ctx.processActionQueue(1);
    ctx.currentGenerationId = 2;
    ctx.actionQueue = [{ seq: 101, action: "left", immediate: true, post_viewer_state: { current_room: "new-room" } }];
    await ctx.processActionQueue(2);
    assert.equal(applied.length, 0);
    blob.resolve({ current_room: "old-room" });
    await oldWorker;
    await turn();
    assert.deepEqual(applied.map((state) => state.current_room), ["new-room"]);
    assert.equal(ctx.totalActions, 101);
    assert.equal(ctx.actionQueue.length, 0);
    assert.equal(ctx.isProcessingQueue, false);
  });
}

test("R1: 重载一开始就清空旧队列，即使 token 请求尚未返回", async () => {
  const { ctx, blob, applied } = queueContext("post_viewer_state");
  const token = deferred();
  ctx.actionQueue.push({ seq: 2, action: "left", post_viewer_state: { current_room: "stale-tail" } });
  ctx.streamAbortController = { abort() {} };
  ctx.obtainViewerToken = () => token.promise;
  ctx.viewerToken = null;
  ctx.runId = "test-run";
  ctx.viewerFetch = async () => ({ ok: false });
  vm.runInContext(sourceBetween("public/external-play.js", "async function loadSnapshotAndCatchUp()", "// Stream SSE using"), ctx);
  const oldWorker = ctx.processActionQueue(1);
  const snapshot = ctx.loadSnapshotAndCatchUp();
  assert.equal(ctx.currentGenerationId, 2);
  assert.equal(ctx.actionQueue.length, 0);
  blob.resolve({ current_room: "old-room" });
  await oldWorker;
  token.resolve();
  await snapshot;
  assert.equal(applied.length, 0);
});

for (const failMiddle of [false, true]) {
  test("R2: 并发房间切换按序完成" + (failMiddle ? "，中间失败不丢弃最后请求" : ""), async () => {
    const pending = new Map();
    const applied = [];
    let concurrentLoads = 0;
    let maxConcurrentLoads = 0;
    const ctx = vm.createContext({
      worldMapSwitching: false,
      app: {
        isExternalSpectator: true, currentLevelId: "A",
        async loadLevelState(id) {
          const load = deferred(); pending.set(id, load);
          concurrentLoads += 1; maxConcurrentLoads = Math.max(maxConcurrentLoads, concurrentLoads);
          try { return await load.promise; } finally { concurrentLoads -= 1; }
        },
        applyLevelState(state, options) {
          assert.equal(options.updateUrl, false);
          ctx.app.currentLevelId = state.id; applied.push(state.id);
        }
      },
      setWorldMapOpen() {}, syncPlayOverlayInputLock() {}, worldMapCells: () => [],
      finishPlayWorldMapSwitch() {}, console: { error() {} }
    });
    vm.runInContext(sourceBetween("public/play.js", "let activeWorldMapSwitchPromise = null;", "// Replay export uses"), ctx);
    const b = ctx.switchPlayWorldLevel("B", { immediate: true });
    const c = ctx.switchPlayWorldLevel("C", { immediate: true });
    let dFinished = false;
    const d = ctx.switchPlayWorldLevel("D", { immediate: true }).then(() => { dFinished = true; });
    pending.get("B").resolve({ id: "B" });
    await b; await turn();
    assert.equal(dFinished, false);
    assert.equal(pending.has("D"), false);
    if (failMiddle) pending.get("C").reject(new Error("synthetic load failure"));
    else pending.get("C").resolve({ id: "C" });
    await c; await turn();
    assert.equal(pending.has("D"), true);
    pending.get("D").resolve({ id: "D" });
    await d;
    assert.equal(ctx.app.currentLevelId, "D");
    assert.deepEqual(applied, failMiddle ? ["B", "D"] : ["B", "C", "D"]);
    assert.equal(maxConcurrentLoads, 1);
    assert.equal(ctx.worldMapSwitching, false);
  });
}

test("R3: 淘汰签名映射后不能与已缓存房间或几何的 token 冲突", () => {
  const ctx = vm.createContext({
    app: { horizontalNeighborStatesVersion: 0 }, modelAssetsVersion: 0,
    edgeOutlinesEnabled: () => true, levelStateSignature: (state) => state.contents,
    boundaryNeighborStatesToken: () => "-"
  });
  vm.runInContext(sourceBetween("public/play-render-three.js", "const signatureTokenCache = new Map();", "const groupLabelTextureCache = new Map();") +
    sourceBetween("public/play-render-three.js", "const worldViewRoomSignatureMemo = new Map();", "function disposeWorldViewRoomEntry("), ctx);
  const before = ctx.worldViewRoomSignature({ levelId: "A", levelState: { contents: "original" } }, 1);
  const tokens = new Set([ctx.signatureToken("original")]);
  for (let i = 0; i < 4095; i += 1) tokens.add(ctx.signatureToken("filler-" + i));
  ctx.app.horizontalNeighborStatesVersion += 1;
  const changed = { levelId: "A", levelState: { contents: "changed terrain" } };
  const after = ctx.worldViewRoomSignature(changed, 1);
  assert.notEqual(after, before);
  assert.equal(ctx.worldViewRoomSignature(changed, 1), after);
  assert.equal(tokens.has(ctx.signatureToken("changed terrain")), false);
  tokens.add(ctx.signatureToken("changed terrain"));
  for (let i = 0; i < 8192; i += 1) {
    const token = ctx.signatureToken("later-" + i);
    assert.equal(tokens.has(token), false);
    tokens.add(token);
  }
  assert.ok(vm.runInContext("signatureTokenCache.size", ctx) <= 4096);
});


function hostContext() {
  const frames = new Map();
  let frameId = 0;
  const actor = () => ({ type: "player", x: 0, y: 0, elevation: 0 });
  const app = {
    currentLevelId: "A", isExternalSpectator: true,
    state: { actors: [actor()] }, playData: { actors: [actor()] },
    render() {}, syncCameraTarget() {}
  };
  const ctx = vm.createContext({
    app, window: { __MAZEBENCH_APP__: app }, performance: { now: () => 0 },
    setInterval, clearInterval, console,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "public/external-play-host.js"), "utf8"), ctx);
  const state = (x, room = "A") => ({ current_room: room, player: { viewer_actor_index: 0, x, y: 0, elevation: 0 }, actors: [] });
  return { ctx, app, frames, state, host: ctx.window.__MAZEBENCH_SPECTATOR_HOST__ };
}

test("R1: 新快照取消旧动画，旧帧不能写回状态或取消后续动画", async () => {
  const { host, app, frames, state } = hostContext();
  const transition = { duration_ms: 250, keyframes: [{ viewer_state: state(0) }, { viewer_state: state(1) }] };
  const oldAction = host.applyAction("right", transition, state(1));
  await turn();
  const oldFrame = frames.values().next().value;
  assert.equal(typeof oldFrame, "function");
  await host.applySnapshot(state(9));
  await oldAction;
  assert.equal(frames.size, 0);
  assert.equal(app.isAnimating, false);
  assert.equal(app.state.actors[0].x, 9);
  const nextAction = host.applyAction("right", transition, state(10));
  await turn();
  oldFrame(300);
  assert.equal(frames.size, 1, "过期 RAF 不能取消新动画");
  assert.equal(app.state.actors[0].x, 9);
  const nextFrame = frames.values().next().value;
  frames.clear();
  nextFrame(300);
  await nextAction;
  assert.equal(app.state.actors[0].x, 10);
});

test("R1: host 等待就绪后再次校验调用方代次", async () => {
  const { host, app, state } = hostContext();
  let current = true;
  const action = host.applyAction("right", null, state(1), { isCurrent: () => current });
  current = false;
  assert.equal(await action, false);
  assert.equal(app.state.actors[0].x, 0);
});

test("R1/R2: 已有 B 加载时返回当前 A 的快照也必须排队", async () => {
  const { ctx, host, app, state } = hostContext();
  const pending = new Map();
  app.loadLevelState = (id) => { const load = deferred(); pending.set(id, load); return load.promise; };
  app.applyLevelState = (level) => { app.currentLevelId = level.id; };
  Object.assign(ctx, { worldMapSwitching: false, setWorldMapOpen() {}, syncPlayOverlayInputLock() {}, worldMapCells: () => [], finishPlayWorldMapSwitch() {} });
  vm.runInContext(sourceBetween("public/play.js", "let activeWorldMapSwitchPromise = null;", "// Replay export uses"), ctx);
  app.switchPlayWorldLevel = ctx.switchPlayWorldLevel;
  const old = host.applySnapshot(state(1, "B"));
  await turn();
  const latest = host.applySnapshot(state(9, "A"));
  await turn();
  pending.get("B").resolve({ id: "B" });
  await old; await turn();
  assert.equal(app.state.actors[0].x, 0, "过期房间结果不能写入玩家状态");
  assert.equal(pending.has("A"), true);
  pending.get("A").resolve({ id: "A" });
  await latest;
  assert.equal(app.currentLevelId, "A");
  assert.equal(app.state.actors[0].x, 9);
});
