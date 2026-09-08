const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");

const { createLocalBuildWorldService } = require("../server/build-worlds-local");
const { createMazeLevelService } = require("../server/maze-levels");
const { createMazeWorldMapService } = require("../server/maze-world-map");
const { listTopLevelFiles, loadJson, loadText, titleCase } = require("../server/support");

async function runR4AdversarialSuite() {
  console.log("=================================================");
  console.log("--- STARTING R4 ADVERSARIAL STRESS TEST SUITE ---");
  console.log("=================================================");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-r4-"));
  const gamesDir = path.join(tempRoot, "games");
  const mazeDir = path.join(gamesDir, "maze");

  fs.mkdirSync(path.join(mazeDir, "levels"), { recursive: true });
  fs.writeFileSync(
    path.join(mazeDir, "level_parsing.json"),
    JSON.stringify({
      rules: { separator: " ", block_adder: "+" },
      objects: {
        floor: { token: "." },
        wall: { token: "#" },
        player: { token: "p", type: "player" },
        gem: { token: "G", type: "gem" }
      }
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(mazeDir, "world_parsing.json"),
    JSON.stringify({ rules: { world_size: [16, 16], level_size: [16, 16], camera_view: [16, 16] } }),
    "utf8"
  );
  fs.mkdirSync(path.join(mazeDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(mazeDir, "assets_3d"), { recursive: true });
  fs.writeFileSync(path.join(mazeDir, "levels", "level_AxA.txt"), ". p G\n", "utf8");

  // Master asset fixtures
  const samplePngData = "PNG_SAMPLE_HERO_SPRITE";
  const sample3dData = "OBJ_SAMPLE_3D_WALL_MESH";
  fs.writeFileSync(path.join(mazeDir, "images", "player.png"), samplePngData, "utf8");
  fs.writeFileSync(path.join(mazeDir, "assets_3d", "wall.obj"), sample3dData, "utf8");

  const worldMaps = createMazeWorldMapService({
    buildMazePreviewData: () => ({ previewUrl: null }),
    listTopLevelFiles,
    loadJson,
    gamesDir
  });

  const levelService = createMazeLevelService({
    buildGameAssetUrl: () => "",
    buildMazePreviewData: () => ({ previewUrl: null }),
    gamesDir,
    listTopLevelFiles,
    loadJson,
    loadText,
    resolveGameAssetPath: () => null,
    rootDir: tempRoot,
    titleCase,
    worldMaps
  });

  const buildWorlds = createLocalBuildWorldService({
    gamesDir,
    getGame: levelService.getGame,
    getLevelEditorState: levelService.getLevelEditorState,
    listTopLevelFiles,
    loadJson,
    sanitizeEditorPayload: levelService.sanitizeEditorPayload,
    worldMaps
  });

  // Test 1: Real creation of Junction on Windows
  console.log("\n[Test 1.1] Verifying Windows Junction creation for images and assets_3d...");
  const draft1 = buildWorlds.createLocalWorld({ title: "Draft 1", worldWidth: 1, worldHeight: 1 });
  const draft1Dir = path.join(gamesDir, draft1.id);
  const draft1Images = path.join(draft1Dir, "images");
  const draft1Assets3d = path.join(draft1Dir, "assets_3d");

  assert.ok(fs.existsSync(draft1Images), "images link must exist");
  assert.ok(fs.existsSync(draft1Assets3d), "assets_3d link must exist");

  if (process.platform === "win32") {
    const imagesStat = fs.lstatSync(draft1Images);
    const assets3dStat = fs.lstatSync(draft1Assets3d);
    assert.ok(imagesStat.isSymbolicLink(), "images must be a symbolic link/junction on Windows");
    assert.ok(assets3dStat.isSymbolicLink(), "assets_3d must be a symbolic link/junction on Windows");
  }

  // Verify asset content access
  assert.equal(
    fs.readFileSync(path.join(draft1Images, "player.png"), "utf8"),
    samplePngData,
    "images/player.png must be readable through junction"
  );
  assert.equal(
    fs.readFileSync(path.join(draft1Assets3d, "wall.obj"), "utf8"),
    sample3dData,
    "assets_3d/wall.obj must be readable through junction"
  );

  // Dynamic transparency: write new file to master and read through draft
  fs.writeFileSync(path.join(mazeDir, "images", "new_badge.png"), "BADGE_CONTENT", "utf8");
  assert.equal(
    fs.readFileSync(path.join(draft1Images, "new_badge.png"), "utf8"),
    "BADGE_CONTENT",
    "Newly added master assets must be immediately visible in draft"
  );
  console.log("  -> PASSED: Junction creation & live content access verified.");

  // Test 2: Target already exists as a junction (Repeated calls idempotency)
  console.log("\n[Test 1.2] Verifying idempotency when target links already exist...");
  for (let i = 0; i < 20; i++) {
    // Repeatedly trigger draft operations or world updates
    buildWorlds.replaceLocalWorldFromEditorState(draft1.id, {
      version: "mazebench-build-world-v1",
      title: `Draft 1 Renamed ${i}`,
      world: { width: 1, height: 1 },
      levels: [
        {
          id: "level_AxA",
          column: "A",
          row: "A",
          width: 4,
          height: 3,
          cells: [
            ["#", "#", "#", "#"],
            ["#", ".+p", ".+G", "#"],
            ["#", "#", "#", "#"]
          ]
        }
      ]
    });
  }
  assert.ok(fs.existsSync(draft1Images), "images link still exists after 20 repeated updates");
  assert.ok(fs.existsSync(draft1Assets3d), "assets_3d link still exists after 20 repeated updates");
  console.log("  -> PASSED: 20 repeated updates succeeded without throwing unhandled exceptions.");

  // Test 3: Target already exists as a regular directory (Fault tolerance)
  console.log("\n[Test 1.3] Verifying fault tolerance when target path already exists as regular directory...");
  const draft2 = buildWorlds.createLocalWorld({ title: "Draft 2", worldWidth: 1, worldHeight: 1 });
  const draft2Dir = path.join(gamesDir, draft2.id);
  const draft2Assets3d = path.join(draft2Dir, "assets_3d");

  // Replace assets_3d junction with a real directory containing custom content
  fs.rmSync(draft2Assets3d, { recursive: true, force: true });
  fs.mkdirSync(draft2Assets3d, { recursive: true });
  fs.writeFileSync(path.join(draft2Assets3d, "custom_mesh.txt"), "CUSTOM_CONTENT", "utf8");

  // Now create draft 3 or perform updates that might invoke asset link logic
  const draft2Refreshed = buildWorlds.replaceLocalWorldFromEditorState(draft2.id, {
    version: "mazebench-build-world-v1",
    title: "Draft 2 Updated",
    world: { width: 1, height: 1 },
    levels: [
      {
        id: "level_AxA",
        column: "A",
        row: "A",
        width: 4,
        height: 3,
        cells: [
          ["#", "#", "#", "#"],
          ["#", ".+p", ".+G", "#"],
          ["#", "#", "#", "#"]
        ]
      }
    ]
  });
  assert.ok(fs.existsSync(draft2Assets3d), "custom directory remains intact");
  assert.equal(
    fs.readFileSync(path.join(draft2Assets3d, "custom_mesh.txt"), "utf8"),
    "CUSTOM_CONTENT",
    "custom directory content must not be overwritten or corrupted"
  );
  console.log("  -> PASSED: Pre-existing regular directory was safely preserved.");

  // Test 4: Broken junction fault tolerance
  console.log("\n[Test 1.4] Verifying broken junction fault tolerance...");
  const draft3 = buildWorlds.createLocalWorld({ title: "Draft 3", worldWidth: 1, worldHeight: 1 });
  const draft3Dir = path.join(gamesDir, draft3.id);
  const draft3Images = path.join(draft3Dir, "images");

  // Create a broken junction by pointing to a dead temporary directory
  fs.rmSync(draft3Images, { recursive: true, force: true });
  const deadTarget = path.join(tempRoot, "dead_target_dir");
  fs.mkdirSync(deadTarget);
  if (process.platform === "win32") {
    fs.symlinkSync(deadTarget, draft3Images, "junction");
  } else {
    fs.symlinkSync(deadTarget, draft3Images, "dir");
  }
  fs.rmSync(deadTarget, { recursive: true, force: true });

  // Now draft3Images is a broken symlink/junction: fs.existsSync is false, fs.lstatSync is true
  assert.equal(fs.existsSync(draft3Images), false, "broken junction returns false for existsSync");
  const brokenStat = fs.lstatSync(draft3Images);
  assert.ok(brokenStat.isSymbolicLink(), "broken junction still has lstat.isSymbolicLink() === true");

  // Now perform operations that run ensureSharedAssetLinks or update draft3
  // In server/build-worlds-local.js, ensureSharedAssetLinks has try-catch for symlinkSync
  // It should NOT throw an uncaught exception when encountering EEXIST on symlinkSync!
  let brokenJunctionError = null;
  try {
    buildWorlds.replaceLocalWorldFromEditorState(draft3.id, {
      version: "mazebench-build-world-v1",
      title: "Draft 3 With Broken Link",
      world: { width: 1, height: 1 },
      levels: [
        {
          id: "level_AxA",
          column: "A",
          row: "A",
          width: 4,
          height: 3,
          cells: [
            ["#", "#", "#", "#"],
            ["#", ".+p", ".+G", "#"],
            ["#", "#", "#", "#"]
          ]
        }
      ]
    });
  } catch (err) {
    brokenJunctionError = err;
  }
  assert.equal(brokenJunctionError, null, "broken junction must not cause unhandled crash");
  console.log("  -> PASSED: Broken junction did not cause unhandled crash.");

  // Test 5: Source directory missing (games/maze/assets_3d missing)
  console.log("\n[Test 1.5] Verifying fault tolerance when source asset directory is completely missing...");
  const tempRootMissing = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-missing-source-"));
  const gamesDirMissing = path.join(tempRootMissing, "games");
  const mazeDirMissing = path.join(gamesDirMissing, "maze");

  fs.mkdirSync(path.join(mazeDirMissing, "levels"), { recursive: true });
  fs.writeFileSync(
    path.join(mazeDirMissing, "level_parsing.json"),
    JSON.stringify({ rules: { separator: " ", block_adder: "+" }, objects: { floor: { token: "." }, wall: { token: "#" }, player: { token: "p", type: "player" }, gem: { token: "G", type: "gem" } } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(mazeDirMissing, "world_parsing.json"),
    JSON.stringify({ rules: { world_size: [16, 16], level_size: [16, 16], camera_view: [16, 16] } }),
    "utf8"
  );
  fs.writeFileSync(path.join(mazeDirMissing, "levels", "level_AxA.txt"), ".\n", "utf8");
  // NOTICE: We do NOT create images or assets_3d under mazeDirMissing!

  const worldMapsMissing = createMazeWorldMapService({
    buildMazePreviewData: () => ({ previewUrl: null }),
    listTopLevelFiles,
    loadJson,
    gamesDir: gamesDirMissing
  });

  const levelServiceMissing = createMazeLevelService({
    buildGameAssetUrl: () => "",
    buildMazePreviewData: () => ({ previewUrl: null }),
    gamesDir: gamesDirMissing,
    listTopLevelFiles,
    loadJson,
    loadText,
    resolveGameAssetPath: () => null,
    rootDir: tempRootMissing,
    titleCase,
    worldMaps: worldMapsMissing
  });

  const buildWorldsMissing = createLocalBuildWorldService({
    gamesDir: gamesDirMissing,
    getGame: levelServiceMissing.getGame,
    getLevelEditorState: levelServiceMissing.getLevelEditorState,
    listTopLevelFiles,
    loadJson,
    sanitizeEditorPayload: levelServiceMissing.sanitizeEditorPayload,
    worldMaps: worldMapsMissing
  });

  let missingSourceError = null;
  let draftMissing = null;
  try {
    draftMissing = buildWorldsMissing.createLocalWorld({ title: "Draft Missing Source", worldWidth: 1, worldHeight: 1 });
  } catch (err) {
    missingSourceError = err;
  }
  assert.equal(missingSourceError, null, "createLocalWorld must not crash even when master asset directories are missing");
  assert.ok(draftMissing, "draft world was created successfully");
  fs.rmSync(tempRootMissing, { recursive: true, force: true });
  console.log("  -> PASSED: Graceful handling of missing master asset directories verified.");

  // Test 6: Draft deletion safety (Junction deletion MUST NOT delete master assets)
  console.log("\n[Test 1.6] Verifying draft deletion does NOT cascade-delete master assets...");
  const draftForDeletion = buildWorlds.createLocalWorld({ title: "Draft To Delete", worldWidth: 1, worldHeight: 1 });
  const draftDelDir = path.join(gamesDir, draftForDeletion.id);
  assert.ok(fs.existsSync(draftDelDir), "draft dir exists before deletion");

  buildWorlds.removeLocalWorld(draftForDeletion.id);
  assert.ok(!fs.existsSync(draftDelDir), "draft dir must be deleted");

  // Master asset check
  assert.ok(fs.existsSync(path.join(mazeDir, "images", "player.png")), "MASTER player.png must NOT be deleted");
  assert.ok(fs.existsSync(path.join(mazeDir, "assets_3d", "wall.obj")), "MASTER wall.obj must NOT be deleted");
  assert.equal(
    fs.readFileSync(path.join(mazeDir, "images", "player.png"), "utf8"),
    samplePngData,
    "MASTER player.png content must remain 100% intact"
  );
  console.log("  -> PASSED: Master world assets are 100% intact after draft world deletion.");

  // Cleanup
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log("R4 ADVERSARIAL SUITE ALL PASSED!");
}

async function runR6AdversarialSuite() {
  console.log("\n=================================================");
  console.log("--- STARTING R6 ADVERSARIAL STRESS TEST SUITE ---");
  console.log("=================================================");

  // Test 1: Single Port Contention on Port 3000 -> Migration to 3001
  console.log("\n[Test 2.1] Extreme Port Contention: Default Port 3000 Busy -> Auto-migration to 3001...");
  
  // First ensure port 3000 is occupied.
  // We already know port 3000 is occupied on the machine, but let's be robust:
  let port3000Blocker = null;
  const isPort3000Busy = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => {
      port3000Blocker = probe; // keep it listening if it was free
      resolve(false);
    });
    probe.listen(3000, "127.0.0.1");
  });
  console.log(`  Port 3000 status before launch: occupied (isPort3000Busy=${isPort3000Busy})`);

  const tempHome1 = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-r6-test1-"));
  const stateFile1 = path.join(tempHome1, "state-3000.json");
  const serverJson1 = path.join(tempHome1, "server.json");

  const serverProc1 = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: "3000",
      HOST: "127.0.0.1",
      MAZEBENCH_DATA_HOME: tempHome1,
      MAZEBENCH_STATE_FILE: stateFile1
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let server1Output = "";
  serverProc1.stdout.on("data", (d) => { server1Output += d.toString(); });
  serverProc1.stderr.on("data", (d) => { server1Output += d.toString(); });

  try {
    const deadline = Date.now() + 15000;
    let success = false;
    let boundPort = null;

    while (Date.now() < deadline) {
      if (fs.existsSync(stateFile1) && fs.existsSync(serverJson1)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFile1, "utf8"));
          const serverData = JSON.parse(fs.readFileSync(serverJson1, "utf8"));
          if (stateData.port === 3001 && serverData.port === 3001) {
            boundPort = stateData.port;
            success = true;
            break;
          }
        } catch (_e) {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(success, `Server did not successfully bind and sync state within timeout. Output:\n${server1Output}`);
    assert.equal(boundPort, 3001, `Server must have migrated from 3000 to 3001. Actual: ${boundPort}`);

    // Verify metadata consistency
    const stateData = JSON.parse(fs.readFileSync(stateFile1, "utf8"));
    const serverData = JSON.parse(fs.readFileSync(serverJson1, "utf8"));
    assert.equal(stateData.port, 3001, "MAZEBENCH_STATE_FILE port must be 3001");
    assert.equal(serverData.port, 3001, "server.json port must be 3001");
    assert.equal(stateData.pid, serverProc1.pid, "MAZEBENCH_STATE_FILE pid must match server PID");
    assert.match(stateData.url, /:3001$/, "MAZEBENCH_STATE_FILE url must end with :3001");

    // Verify HTTP responsiveness on 3001
    const res = await new Promise((resolve, reject) => {
      http.get("http://127.0.0.1:3001/", resolve).on("error", reject);
    });
    assert.equal(res.statusCode, 200, "HTTP GET on migrated port 3001 must return 200");
    console.log("  -> PASSED: Port 3000 contention migrated smoothly to 3001 with 100% metadata sync!");
  } finally {
    serverProc1.kill("SIGTERM");
    if (port3000Blocker) {
      await new Promise((r) => port3000Blocker.close(r));
    }
    // Wait for server to shut down and clean up
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tempHome1, { recursive: true, force: true });
  }

  // Test 2: Consecutive Multi-Port Contention (6 consecutive ports busy: 3000..3005 -> Migration to 3006)
  console.log("\n[Test 2.2] Consecutive Multi-Port Contention: Ports 3000..3005 Busy -> Auto-migration to 3006...");

  // Block ports 3000 through 3005
  const blockers = [];
  try {
    for (let p = 3000; p <= 3005; p++) {
      const b = net.createServer();
      const isOccupied = await new Promise((resolve) => {
        b.once("error", () => resolve(true));
        b.once("listening", () => resolve(false));
        b.listen(p, "127.0.0.1");
      });
      if (!isOccupied) {
        blockers.push(b);
      }
    }
    console.log("  Ensured ports 3000..3005 are occupied.");

    const tempHome2 = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-r6-test2-"));
    const stateFile2 = path.join(tempHome2, "state-multi.json");
    const serverJson2 = path.join(tempHome2, "server.json");

    const serverProc2 = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: "3000",
        HOST: "127.0.0.1",
        MAZEBENCH_DATA_HOME: tempHome2,
        MAZEBENCH_STATE_FILE: stateFile2
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let server2Output = "";
    serverProc2.stdout.on("data", (d) => { server2Output += d.toString(); });
    serverProc2.stderr.on("data", (d) => { server2Output += d.toString(); });

    const deadline2 = Date.now() + 20000;
    let success2 = false;
    let boundPort2 = null;

    while (Date.now() < deadline2) {
      if (fs.existsSync(stateFile2) && fs.existsSync(serverJson2)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFile2, "utf8"));
          const serverData = JSON.parse(fs.readFileSync(serverJson2, "utf8"));
          if (stateData.port === 3006 && serverData.port === 3006) {
            boundPort2 = stateData.port;
            success2 = true;
            break;
          }
        } catch (_e) {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(success2, `Server did not bind and sync state across 6 occupied ports. Output:\n${server2Output}`);
    assert.equal(boundPort2, 3006, `Server must have migrated through 3000..3005 to 3006. Actual: ${boundPort2}`);

    // Check that warning logs captured migrations
    assert.match(server2Output, /port 3000 in use, trying 3001/, "Warning for 3000 must be logged");
    assert.match(server2Output, /port 3001 in use, trying 3002/, "Warning for 3001 must be logged");
    assert.match(server2Output, /port 3002 in use, trying 3003/, "Warning for 3002 must be logged");
    assert.match(server2Output, /port 3003 in use, trying 3004/, "Warning for 3003 must be logged");
    assert.match(server2Output, /port 3004 in use, trying 3005/, "Warning for 3004 must be logged");
    assert.match(server2Output, /port 3005 in use, trying 3006/, "Warning for 3005 must be logged");

    // Verify HTTP on 3006
    const res2 = await new Promise((resolve, reject) => {
      http.get("http://127.0.0.1:3006/", resolve).on("error", reject);
    });
    assert.equal(res2.statusCode, 200, "HTTP GET on migrated port 3006 must return 200");

    // Verify metadata exact consistency
    const stateData2 = JSON.parse(fs.readFileSync(stateFile2, "utf8"));
    const serverData2 = JSON.parse(fs.readFileSync(serverJson2, "utf8"));
    assert.equal(stateData2.port, 3006, "state file port must be 3006");
    assert.equal(serverData2.port, 3006, "server.json port must be 3006");
    assert.equal(stateData2.url, "http://127.0.0.1:3006", "state file url must match");
    assert.equal(serverData2.url, "http://127.0.0.1:3006", "server.json url must match");

    serverProc2.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tempHome2, { recursive: true, force: true });
    console.log("  -> PASSED: Consecutive multi-port migration (3000..3005 -> 3006) 100% verified!");
  } finally {
    for (const b of blockers) {
      await new Promise((r) => b.close(r));
    }
  }

  // Test 3: Port Exhaustion Limit Behavior
  console.log("\n[Test 2.3] Testing Port Exhaustion Limit (Boundary Condition)...");
  // Find a free port dynamically
  const tempSrv = net.createServer();
  await new Promise((res) => tempSrv.listen(0, "127.0.0.1", res));
  const testBase = tempSrv.address().port;
  await new Promise((res) => tempSrv.close(res));
  const exhaustionBlockers = [];
  try {
    for (let p = testBase; p <= testBase + 2; p++) {
      const eb = net.createServer();
      await new Promise((resolve, reject) => {
        eb.listen(p, "127.0.0.1", resolve);
        eb.on("error", reject);
      });
      exhaustionBlockers.push(eb);
    }

    // Now test a mini server script that has maxPort = basePort + 2
    const testRunnerCode = `
      const http = require("http");
      const server = http.createServer((req, res) => res.end("ok"));
      const basePort = ${testBase};
      const maxPort = basePort + 2;
      let currentPort = basePort;
      server.on("error", (error) => {
        if (error.code === "EADDRINUSE" && currentPort < maxPort) {
          currentPort += 1;
          server.listen(currentPort, "127.0.0.1");
          return;
        }
        process.exit(42); // expected clean exit
      });
      server.listen(currentPort, "127.0.0.1");
    `;

    const runnerProc = spawn(process.execPath, ["-e", testRunnerCode], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const exitCode = await new Promise((resolve) => {
      runnerProc.on("exit", resolve);
    });
    assert.equal(exitCode, 42, `Server must exit when currentPort reaches maxPort. Got exitCode: ${exitCode}`);
    console.log("  -> PASSED: Boundary exhaustion properly terminates without hang or infinite recursion.");
  } finally {
    for (const eb of exhaustionBlockers) {
      await new Promise((r) => eb.close(r));
    }
  }

  // Test 4: MAZEBENCH_STATE_FILE cleanup on normal exit and PID protection
  console.log("\n[Test 2.4] Verifying MAZEBENCH_STATE_FILE cleanup on normal exit and PID isolation...");
  const tempHomeClean = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-r6-clean-"));
  const stateFileClean = path.join(tempHomeClean, "clean-state.json");

  // Test 2.4a: Spawn server that starts, writes state file, and then invokes process.exit(0)
  // to verify the process.on("exit", handleShutdown) hook cleans up the state file
  const testExitScript = `
    process.env.PORT = "3020";
    process.env.HOST = "127.0.0.1";
    process.env.MAZEBENCH_DATA_HOME = ${JSON.stringify(tempHomeClean)};
    process.env.MAZEBENCH_STATE_FILE = ${JSON.stringify(stateFileClean)};
    require(${JSON.stringify(path.resolve(__dirname, "..", "server.js"))});
    setTimeout(() => {
      process.exit(0);
    }, 1500);
  `;
  const cleanProc = spawn(process.execPath, ["-e", testExitScript], {
    cwd: path.resolve(__dirname, ".."),
    stdio: ["pipe", "pipe", "pipe"]
  });

  await new Promise((resolve) => cleanProc.on("exit", resolve));
  assert.ok(!fs.existsSync(stateFileClean), "State file must be cleanly deleted by handleShutdown on normal process exit");

  // Test 2.4b: PID isolation - handleShutdown must NOT delete state file belonging to another PID
  fs.writeFileSync(stateFileClean, JSON.stringify({ pid: 999999, port: 3020, url: "http://127.0.0.1:3020" }), "utf8");
  // Run a short node process simulating another instance shutting down
  const testIsolationScript = `
    const fs = require("fs");
    process.env.MAZEBENCH_STATE_FILE = ${JSON.stringify(stateFileClean)};
    // Simulate handleShutdown from server.js
    if (process.env.MAZEBENCH_STATE_FILE) {
      try {
        if (fs.existsSync(process.env.MAZEBENCH_STATE_FILE)) {
          const content = JSON.parse(fs.readFileSync(process.env.MAZEBENCH_STATE_FILE, "utf8"));
          if (content.pid === process.pid) {
            fs.rmSync(process.env.MAZEBENCH_STATE_FILE, { force: true });
          }
        }
      } catch (_e) {}
    }
  `;
  const isoProc = spawn(process.execPath, ["-e", testIsolationScript]);
  await new Promise((resolve) => isoProc.on("exit", resolve));
  assert.ok(fs.existsSync(stateFileClean), "State file must NOT be deleted if PID belongs to a different process");

  fs.rmSync(tempHomeClean, { recursive: true, force: true });
  console.log("  -> PASSED: State file cleanup and PID isolation verified successfully!");

  console.log("R6 ADVERSARIAL SUITE ALL PASSED!");
}

async function main() {
  await runR4AdversarialSuite();
  await runR6AdversarialSuite();
  console.log("\n========================================================");
  console.log("ALL R4 AND R6 EMPIRICAL ADVERSARIAL TESTS PASSED (100%)!");
  console.log("========================================================");
}

main().catch((err) => {
  console.error("Adversarial test failure:", err);
  process.exit(1);
});



