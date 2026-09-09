const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBuildWorldService } = require("../server/build-worlds-local");
const { createMazeLevelService } = require("../server/maze-levels");
const { createMazeWorldMapService } = require("../server/maze-world-map");
const { listTopLevelFiles, loadJson, loadText, titleCase } = require("../server/support");

console.log("===============================================================================");
console.log("Adversarial Stress & Empirical Challenge Harness for Milestone 1 (R2)");
console.log("===============================================================================\n");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-r2-stress-"));
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
      ice: { token: "i" },
      player: { token: "p", type: "player" },
      gem: { token: "G", type: "gem" },
      exit: { token: "e", type: "exit" }
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

function snapshotWorld(gameId) {
  const worldDir = path.join(gamesDir, gameId);
  const levelsDir = path.join(worldDir, "levels");
  const levels = {};
  if (fs.existsSync(levelsDir)) {
    listTopLevelFiles(levelsDir).forEach((file) => {
      levels[file] = fs.readFileSync(path.join(levelsDir, file), "utf8");
    });
  }
  return {
    world_map: fs.existsSync(path.join(worldDir, "world_map.json"))
      ? fs.readFileSync(path.join(worldDir, "world_map.json"), "utf8")
      : null,
    world_parsing: fs.existsSync(path.join(worldDir, "world_parsing.json"))
      ? fs.readFileSync(path.join(worldDir, "world_parsing.json"), "utf8")
      : null,
    draft: fs.existsSync(path.join(worldDir, "draft.json"))
      ? fs.readFileSync(path.join(worldDir, "draft.json"), "utf8")
      : null,
    levels
  };
}

function assertWorldMatchesSnapshot(gameId, snapshot, message) {
  const current = snapshotWorld(gameId);
  assert.equal(current.world_map, snapshot.world_map, `${message}: world_map.json mismatch`);
  assert.equal(current.world_parsing, snapshot.world_parsing, `${message}: world_parsing.json mismatch`);
  assert.equal(current.draft, snapshot.draft, `${message}: draft.json mismatch`);
  assert.deepEqual(Object.keys(current.levels).sort(), Object.keys(snapshot.levels).sort(), `${message}: level files set mismatch`);
  for (const file of Object.keys(snapshot.levels)) {
    assert.equal(current.levels[file], snapshot.levels[file], `${message}: file ${file} content mismatch`);
  }
}

function makeRoom(id, column, row, innerToken = ".") {
  return {
    id,
    column,
    row,
    width: 4,
    height: 3,
    cells: [
      ["#", "#", "#", "#"],
      ["#", innerToken, ".+G", "#"],
      ["#", "#", "#", "#"]
    ]
  };
}

const nineRoomLevels = [
  makeRoom("level_AxA", "A", "A", ".+p"),
  makeRoom("level_BxA", "B", "A", "."),
  makeRoom("level_CxA", "C", "A", "."),
  makeRoom("level_AxB", "A", "B", "."),
  makeRoom("level_BxB", "B", "B", "."),
  makeRoom("level_CxB", "C", "B", "."),
  makeRoom("level_AxC", "A", "C", "."),
  makeRoom("level_BxC", "B", "C", "."),
  makeRoom("level_CxC", "C", "C", ".")
];

const nineRoomState = {
  version: "mazebench-build-world-v1",
  title: "9-Room Benchmark World",
  world: { width: 3, height: 3 },
  levels: nineRoomLevels
};

const results = [];

function recordResult(suite, name, passed, details) {
  results.push({ suite, name, passed, details });
  const status = passed ? "[PASS]" : "[FAIL]";
  console.log(`  ${status} ${name}${details ? ` -> ${details}` : ""}`);
}

// =========================================================================
// Suite 1: Multi-Room Token Injection & Edge Cases
// =========================================================================
console.log("Suite 1: Multi-Room Token Injection & Edge Cases (3x3 9-Room World)");

const w9 = buildWorlds.createLocalWorld({ editorState: nineRoomState, title: "9-Room World" });
const snap9 = snapshotWorld(w9.id);

try {
  const bad0 = JSON.parse(JSON.stringify(nineRoomState));
  bad0.levels[0].cells[1][1] = "INVALID_TOKEN_AXA";
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, bad0), /Unknown token/);
  assertWorldMatchesSnapshot(w9.id, snap9, "Room 0 injection");
  recordResult("Suite 1", "Case 1.1: Invalid token at Room 0 (first room)", true);
} catch (e) {
  recordResult("Suite 1", "Case 1.1: Invalid token at Room 0 (first room)", false, e.message);
}

try {
  const badMid = JSON.parse(JSON.stringify(nineRoomState));
  for (let i = 0; i < 4; i++) badMid.levels[i].cells[1][1] = "i";
  badMid.levels[4].cells[1][1] = "MALFORMED_TOKEN_BXB";
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, badMid), /Unknown token/);
  assertWorldMatchesSnapshot(w9.id, snap9, "Room 4 injection");
  recordResult("Suite 1", "Case 1.2: Invalid token at Room 4 (middle room) with rooms 0..3 modified", true);
} catch (e) {
  recordResult("Suite 1", "Case 1.2: Invalid token at Room 4 (middle room) with rooms 0..3 modified", false, e.message);
}

try {
  const badLast = JSON.parse(JSON.stringify(nineRoomState));
  for (let i = 0; i < 8; i++) badLast.levels[i].cells[1][1] = "i";
  badLast.levels[8].cells[1][1] = "MALFORMED_TOKEN_CXC";
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, badLast), /Unknown token/);
  assertWorldMatchesSnapshot(w9.id, snap9, "Room 8 injection");
  recordResult("Suite 1", "Case 1.3: Invalid token at Room 8 (last room) with all rooms 0..7 modified", true);
} catch (e) {
  recordResult("Suite 1", "Case 1.3: Invalid token at Room 8 (last room) with all rooms 0..7 modified", false, e.message);
}

try {
  const badCompound = JSON.parse(JSON.stringify(nineRoomState));
  badCompound.levels[2].cells[1][1] = ".+#+UNKNOWN_BLOCK";
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, badCompound), /Unknown token/);
  assertWorldMatchesSnapshot(w9.id, snap9, "Compound token");
  recordResult("Suite 1", "Case 1.4: Invalid compound token in stack", true);
} catch (e) {
  recordResult("Suite 1", "Case 1.4: Invalid compound token in stack", false, e.message);
}

try {
  const noCells = JSON.parse(JSON.stringify(nineRoomState));
  noCells.levels[2].cells = "not-an-array";
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, noCells), /missing a cells array/);
  assertWorldMatchesSnapshot(w9.id, snap9, "Missing cells");
  recordResult("Suite 1", "Case 1.5: Missing cells array", true);
} catch (e) {
  recordResult("Suite 1", "Case 1.5: Missing cells array", false, e.message);
}

try {
  const dupRoom = JSON.parse(JSON.stringify(nineRoomState));
  dupRoom.levels[1].id = "level_AxA";
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, dupRoom), /more than once/);
  assertWorldMatchesSnapshot(w9.id, snap9, "Duplicate room");
  recordResult("Suite 1", "Case 1.6: Duplicate room ID in payload", true);
} catch (e) {
  recordResult("Suite 1", "Case 1.6: Duplicate room ID in payload", false, e.message);
}

try {
  const oobRoom = JSON.parse(JSON.stringify(nineRoomState));
  oobRoom.levels[0].id = "level_DxD";
  oobRoom.levels[0].column = "D";
  oobRoom.levels[0].row = "D";
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, oobRoom), /outside/);
  assertWorldMatchesSnapshot(w9.id, snap9, "OOB room");
  recordResult("Suite 1", "Case 1.7: Out-of-bounds room coordinates", true);
} catch (e) {
  recordResult("Suite 1", "Case 1.7: Out-of-bounds room coordinates", false, e.message);
}

// =========================================================================
// Suite 2: Mid-Write Fault Injection (Write Phase I/O Failures)
// =========================================================================
console.log("\nSuite 2: Mid-Write Fault Injection (Write Phase I/O Failures)");

const validUpdate = JSON.parse(JSON.stringify(nineRoomState));
validUpdate.title = "Updated 9-Room World";
validUpdate.levels[0].cells[1][1] = "i";
validUpdate.levels[4].cells[1][1] = "i";

const origWriteFileSync = fs.writeFileSync;

try {
  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("world_parsing.json")) {
      throw new Error("Synthetic I/O failure on world_parsing.json");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, validUpdate), /Synthetic I\/O failure on world_parsing.json/);
  fs.writeFileSync = origWriteFileSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "world_parsing fault");
  recordResult("Suite 2", "Case 2.1: Fault writing world_parsing.json", true);
} catch (e) {
  fs.writeFileSync = origWriteFileSync;
  recordResult("Suite 2", "Case 2.1: Fault writing world_parsing.json", false, e.message);
}

try {
  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("level_AxA.txt")) {
      throw new Error("Synthetic I/O failure on level_AxA.txt");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, validUpdate), /Synthetic I\/O failure on level_AxA.txt/);
  fs.writeFileSync = origWriteFileSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "level_AxA fault");
  recordResult("Suite 2", "Case 2.2: Fault writing first room (level_AxA.txt)", true);
} catch (e) {
  fs.writeFileSync = origWriteFileSync;
  recordResult("Suite 2", "Case 2.2: Fault writing first room (level_AxA.txt)", false, e.message);
}

try {
  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("level_BxB.txt")) {
      throw new Error("Synthetic I/O failure on level_BxB.txt");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, validUpdate), /Synthetic I\/O failure on level_BxB.txt/);
  fs.writeFileSync = origWriteFileSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "level_BxB fault");
  recordResult("Suite 2", "Case 2.3: Fault writing middle room (level_BxB.txt) with rooms 0..3 already written", true);
} catch (e) {
  fs.writeFileSync = origWriteFileSync;
  recordResult("Suite 2", "Case 2.3: Fault writing middle room (level_BxB.txt) with rooms 0..3 already written", false, e.message);
}

try {
  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("level_CxC.txt")) {
      throw new Error("Synthetic I/O failure on level_CxC.txt");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, validUpdate), /Synthetic I\/O failure on level_CxC.txt/);
  fs.writeFileSync = origWriteFileSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "level_CxC fault");
  recordResult("Suite 2", "Case 2.4: Fault writing last room (level_CxC.txt) with rooms 0..7 already written", true);
} catch (e) {
  fs.writeFileSync = origWriteFileSync;
  recordResult("Suite 2", "Case 2.4: Fault writing last room (level_CxC.txt) with rooms 0..7 already written", false, e.message);
}

try {
  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("world_map.json")) {
      throw new Error("Synthetic I/O failure on world_map.json");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, validUpdate), /Synthetic I\/O failure on world_map.json/);
  fs.writeFileSync = origWriteFileSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "world_map fault");
  recordResult("Suite 2", "Case 2.5: Fault writing world_map.json", true);
} catch (e) {
  fs.writeFileSync = origWriteFileSync;
  recordResult("Suite 2", "Case 2.5: Fault writing world_map.json", false, e.message);
}

try {
  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("draft.json")) {
      throw new Error("Synthetic I/O failure on draft.json");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, validUpdate), /Synthetic I\/O failure on draft.json/);
  fs.writeFileSync = origWriteFileSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "draft.json fault");
  recordResult("Suite 2", "Case 2.6: Fault writing draft.json in updateDraftMeta", true);
} catch (e) {
  fs.writeFileSync = origWriteFileSync;
  recordResult("Suite 2", "Case 2.6: Fault writing draft.json in updateDraftMeta", false, e.message);
}

// =========================================================================
// Suite 3: Room Count Mutations (Additions / Pruning) with Mid-Write Faults
// =========================================================================
console.log("\nSuite 3: Room Count Mutations with Mid-Write Faults");

try {
  const expandState = JSON.parse(JSON.stringify(nineRoomState));
  expandState.world = { width: 3, height: 4 };
  expandState.levels.push(makeRoom("level_AxD", "A", "D", "."));

  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("level_AxD.txt")) {
      throw new Error("Synthetic I/O failure on newly added level_AxD.txt");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, expandState), /Synthetic I\/O failure on newly added level_AxD.txt/);
  fs.writeFileSync = origWriteFileSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "Expanding world fault");
  recordResult("Suite 3", "Case 3.1: Expanding world (9->10 rooms), fault on writing new room (zero ghost files)", true);
} catch (e) {
  fs.writeFileSync = origWriteFileSync;
  recordResult("Suite 3", "Case 3.1: Expanding world (9->10 rooms), fault on writing new room (zero ghost files)", false, e.message);
}

try {
  const shrinkState = JSON.parse(JSON.stringify(nineRoomState));
  shrinkState.world = { width: 2, height: 1 };
  shrinkState.levels = [nineRoomLevels[0], nineRoomLevels[1]];

  const origUnlinkSync = fs.unlinkSync;
  let unlinkFails = 1;
  fs.unlinkSync = function (filePath) {
    if (unlinkFails > 0 && typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("level_CxC.txt")) {
      unlinkFails--;
      throw new Error("Synthetic unlink failure on pruned level_CxC.txt");
    }
    return origUnlinkSync.apply(this, arguments);
  };
  assert.throws(() => buildWorlds.replaceLocalWorldFromEditorState(w9.id, shrinkState), /Synthetic unlink failure on pruned level_CxC.txt/);
  fs.unlinkSync = origUnlinkSync;
  assertWorldMatchesSnapshot(w9.id, snap9, "Shrinking world fault");
  recordResult("Suite 3", "Case 3.2: Shrinking world (9->2 rooms), one-shot fault on deleting pruned room", true);
} catch (e) {
  recordResult("Suite 3", "Case 3.2: Shrinking world (9->2 rooms), one-shot fault on deleting pruned room", false, e.message);
}

// =========================================================================
// Suite 4: Temp Directory Cleanup Verification
// =========================================================================
console.log("\nSuite 4: Temp Directory Cleanup Verification");

const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("mazebench-world-backup-"));

const badState = JSON.parse(JSON.stringify(nineRoomState));
badState.levels[0].cells[1][1] = "UNKNOWN";
try { buildWorlds.replaceLocalWorldFromEditorState(w9.id, badState); } catch (_e) {}
const tmpAfterVal = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("mazebench-world-backup-"));
const valClean = tmpAfterVal.length === tmpBefore.length;
recordResult("Suite 4", "Case 4.1: No backup dir leaked after pre-validation failure", valClean, `Before: ${tmpBefore.length}, After: ${tmpAfterVal.length}`);

try {
  fs.writeFileSync = function (filePath, data, options) {
    if (typeof filePath === "string" && filePath.includes(w9.id) && filePath.endsWith("draft.json")) {
      throw new Error("tmp cleanup fault");
    }
    return origWriteFileSync.apply(this, arguments);
  };
  buildWorlds.replaceLocalWorldFromEditorState(w9.id, validUpdate);
} catch (_e) {} finally {
  fs.writeFileSync = origWriteFileSync;
}
const tmpAfterWrite = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("mazebench-world-backup-"));
const writeClean = tmpAfterWrite.length === tmpBefore.length;
recordResult("Suite 4", "Case 4.2: No backup dir leaked after mid-write failure", writeClean, `Before: ${tmpBefore.length}, After: ${tmpAfterWrite.length}`);

// =========================================================================
// Suite 5: EMPIRICAL CHALLENGE - Fault During Snapshot Backup Creation
// =========================================================================
console.log("\nSuite 5: EMPIRICAL CHALLENGE - Fault During Snapshot Backup Creation");

// Create a dedicated world for testing backup failure
const wBackup = buildWorlds.createLocalWorld({ editorState: nineRoomState, title: "Backup Challenge World" });
const snapBackup = snapshotWorld(wBackup.id);

const origCopyFileSync = fs.copyFileSync;
let backupFaultTriggered = false;

try {
  fs.copyFileSync = function (src, dest) {
    if (typeof dest === "string" && dest.includes("mazebench-world-backup-") && dest.endsWith("world_map.json")) {
      backupFaultTriggered = true;
      throw new Error("Synthetic I/O failure during snapshot backup creation (e.g. temp disk full / EACCES)");
    }
    return origCopyFileSync.apply(this, arguments);
  };

  buildWorlds.replaceLocalWorldFromEditorState(wBackup.id, validUpdate);
} catch (err) {
  // Expected to throw
} finally {
  fs.copyFileSync = origCopyFileSync;
}

const worldAfterBackupFault = snapshotWorld(wBackup.id);
const filesPreserved =
  worldAfterBackupFault.world_map !== null &&
  worldAfterBackupFault.world_parsing !== null &&
  worldAfterBackupFault.draft !== null;

if (filesPreserved) {
  recordResult("Suite 5", "Case 5.1: World preserved when snapshot backup creation throws", true);
} else {
  const deletedFiles = [];
  if (worldAfterBackupFault.world_map === null) deletedFiles.push("world_map.json");
  if (worldAfterBackupFault.world_parsing === null) deletedFiles.push("world_parsing.json");
  if (worldAfterBackupFault.draft === null) deletedFiles.push("draft.json");
  recordResult(
    "Suite 5",
    "Case 5.1: World preserved when snapshot backup creation throws",
    false,
    `CATASTROPHIC DATA LOSS: Rollback unlinked files from target world: [${deletedFiles.join(", ")}]`
  );
}

// =========================================================================
// Suite 6: EMPIRICAL CHALLENGE - Persistent Lock/Unlink Failure During Rollback
// =========================================================================
console.log("\nSuite 6: EMPIRICAL CHALLENGE - Persistent Unlink Failure During Rollback");

const wLock = buildWorlds.createLocalWorld({ editorState: nineRoomState, title: "Lock Challenge World" });
const snapLock = snapshotWorld(wLock.id);

const origUnlinkSync = fs.unlinkSync;
try {
  // Simulate a file that cannot be unlinked (e.g. locked by antivirus or another process on Windows)
  fs.unlinkSync = function (filePath) {
    if (typeof filePath === "string" && filePath.includes(wLock.id) && filePath.endsWith("level_BxA.txt")) {
      const err = new Error("EBUSY: resource busy or locked, unlink");
      err.code = "EBUSY";
      throw err;
    }
    return origUnlinkSync.apply(this, arguments);
  };

  const shrinkPayload = JSON.parse(JSON.stringify(nineRoomState));
  shrinkPayload.world = { width: 1, height: 1 };
  shrinkPayload.levels = [nineRoomLevels[0]]; // shrink to 1 room, causing level_BxA to be unlinked

  buildWorlds.replaceLocalWorldFromEditorState(wLock.id, shrinkPayload);
} catch (err) {
  // Expected to throw
} finally {
  fs.unlinkSync = origUnlinkSync;
}

const worldAfterLock = snapshotWorld(wLock.id);
let lockConsistencyPassed = true;
let lockDetail = "";

try {
  assert.equal(worldAfterLock.world_parsing, snapLock.world_parsing, "world_parsing.json was left corrupted");
  assert.equal(worldAfterLock.world_map, snapLock.world_map, "world_map.json was left corrupted");
} catch (e) {
  lockConsistencyPassed = false;
  lockDetail = `Rollback aborted early; world_parsing.json left in dirty mutated state: ${e.message}`;
}

recordResult(
  "Suite 6",
  "Case 6.1: Rollback resilience when a level file encounters persistent lock/EACCES",
  lockConsistencyPassed,
  lockConsistencyPassed ? "All metadata restored" : lockDetail
);

// Case 6.2: Verify unique backup preserved and recovery path returned when rollback fails
const wIncomplete = buildWorlds.createLocalWorld({ editorState: nineRoomState, title: "Backup Preserve World" });
const origCopyFileSyncCase62 = fs.copyFileSync;
let caughtIncompleteErr = null;
try {
  let mutateStarted = false;
  fs.copyFileSync = function (src, dst) {
    if (mutateStarted && typeof dst === "string" && dst.includes(wIncomplete.id) && dst.endsWith("level_AxA.txt")) {
      const err = new Error("EPERM: operation not permitted during rollback");
      err.code = "EPERM";
      throw err;
    }
    return origCopyFileSyncCase62.apply(this, arguments);
  };

  const payload = JSON.parse(JSON.stringify(nineRoomState));
  const origWriteSyncCase62 = fs.writeFileSync;
  fs.writeFileSync = function (filePath, data, enc) {
    if (typeof filePath === "string" && filePath.includes(wIncomplete.id) && filePath.endsWith("world_map.json")) {
      mutateStarted = true;
      throw new Error("Disk full while writing world_map.json");
    }
    return origWriteSyncCase62.apply(this, arguments);
  };

  try {
    buildWorlds.replaceLocalWorldFromEditorState(wIncomplete.id, payload);
  } catch (err) {
    caughtIncompleteErr = err;
  } finally {
    fs.writeFileSync = origWriteSyncCase62;
    fs.copyFileSync = origCopyFileSyncCase62;
  }
} finally {
  fs.copyFileSync = origCopyFileSyncCase62;
}

const backupPreserved = Boolean(
  caughtIncompleteErr &&
  caughtIncompleteErr.rollback_incomplete === true &&
  caughtIncompleteErr.backup_dir &&
  fs.existsSync(caughtIncompleteErr.backup_dir)
);

if (backupPreserved) {
  try {
    fs.rmSync(caughtIncompleteErr.backup_dir, { recursive: true, force: true });
  } catch (_e) {}
}

recordResult(
  "Suite 6",
  "Case 6.2: Unique backup preserved and recovery path returned when rollback fails",
  backupPreserved,
  backupPreserved ? "Backup safely preserved at returned recovery path" : "Backup was prematurely deleted or recovery path not returned"
);

// Cleanup
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("\n===============================================================================");
console.log("CHALLENGER STRESS HARNESS SUMMARY REPORT");
console.log("===============================================================================");
const totalTests = results.length;
const passedTests = results.filter((r) => r.passed).length;
const failedTests = results.filter((r) => !r.passed).length;

console.log(`Total Scenarios Tested: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed (Vulnerabilities Found): ${failedTests}\n`);

if (failedTests > 0) {
  console.log("CRITICAL DEFECTS CONFIRMED EMPIRICALLY:");
  results.filter((r) => !r.passed).forEach((r, idx) => {
    console.log(`  ${idx + 1}. [${r.suite}] ${r.name}`);
    console.log(`     Evidence: ${r.details}`);
  });
}
console.log("===============================================================================\n");

process.exit(failedTests > 0 ? 1 : 0);
