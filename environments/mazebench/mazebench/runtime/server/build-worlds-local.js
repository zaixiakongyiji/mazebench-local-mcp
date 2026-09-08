const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { defaultEditorState } = require("../shared/default-world-template");

// Local Build Mode: each draft world is a full maze-family game directory
// under games/ (gitignored), so play/author/world-map/flyover and the agent
// runner all work on drafts through the same machinery as the master world.
//
// Directory layout for a draft:
//   games/draft-<guid>/
//     draft.json           local metadata + remote sync state
//     level_parsing.json   copied from games/maze at creation time
//     world_parsing.json   this world's grid + level sizes
//     world_map.json       fileName -> [column, row]
//     levels/level_AxA.txt one file per placed level
//     previews/            editor-generated thumbnails
//     images, assets_3d    relative symlinks into ../maze
//
// The interchange format is MazeJam's `mazebench-build-world-v1` editor state,
// so local drafts can be pushed to / pulled from the hosted site verbatim.

const EDITOR_STATE_VERSION = "mazebench-build-world-v1";
const LOCAL_WORLD_ID_PATTERN = /^(draft|online)-[a-z0-9-]{4,40}$/;
const WORLD_LEVEL_ID_PATTERN = /^level_([A-Z])x([A-Z])$/;
const WORLD_AXIS_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHARED_ASSET_DIRS = ["images", "assets_3d"];

function createLocalBuildWorldService({
  gamesDir,
  getGame,
  getLevelEditorState,
  listTopLevelFiles,
  loadJson,
  sanitizeEditorPayload,
  worldMaps
}) {
  function isLocalWorldGameId(gameId) {
    return LOCAL_WORLD_ID_PATTERN.test(String(gameId || ""));
  }

  function localWorldDir(gameId) {
    if (!isLocalWorldGameId(gameId)) {
      throw new Error(`"${gameId}" is not a local world id.`);
    }

    return path.join(gamesDir, gameId);
  }

  function draftMetaPath(gameId) {
    return path.join(localWorldDir(gameId), "draft.json");
  }

  function readDraftMeta(gameId) {
    return loadJson(draftMetaPath(gameId), null);
  }

  function writeDraftMeta(gameId, meta) {
    fs.writeFileSync(draftMetaPath(gameId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  function updateDraftMeta(gameId, patch) {
    const meta = readDraftMeta(gameId) || {};
    const updated = { ...meta, ...patch, updated_at: new Date().toISOString() };
    writeDraftMeta(gameId, updated);
    return updated;
  }

  function generateLocalWorldGameId(prefix = "draft") {
    let gameId = "";

    do {
      const guid = crypto
        .randomBytes(12)
        .toString("base64url")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase()
        .slice(0, 10);
      gameId = `${prefix}-${guid}`;
    } while (gameId.length < prefix.length + 7 || fs.existsSync(path.join(gamesDir, gameId)));

    return gameId;
  }

  function clampWorldDimension(value, fallback) {
    const numeric = Number(value);

    if (!Number.isInteger(numeric)) {
      return fallback;
    }

    return Math.max(1, Math.min(WORLD_AXIS_LETTERS.length, numeric));
  }

  function levelIdForPosition(columnIndex, rowIndex) {
    return `level_${WORLD_AXIS_LETTERS[columnIndex]}x${WORLD_AXIS_LETTERS[rowIndex]}`;
  }

  function parseWorldLevelId(levelId) {
    const match = String(levelId || "").match(WORLD_LEVEL_ID_PATTERN);

    if (!match) {
      return null;
    }

    return {
      column: match[1],
      row: match[2],
      columnIndex: WORLD_AXIS_LETTERS.indexOf(match[1]),
      rowIndex: WORLD_AXIS_LETTERS.indexOf(match[2])
    };
  }

  function ensureSharedAssetLinks(gameId) {
    SHARED_ASSET_DIRS.forEach((dirName) => {
      const linkPath = path.resolve(localWorldDir(gameId), dirName);

      if (!fs.existsSync(linkPath)) {
        try {
          if (process.platform === "win32") {
            const targetPath = path.resolve(gamesDir, "maze", dirName);
            fs.symlinkSync(targetPath, linkPath, "junction");
          } else {
            fs.symlinkSync(path.join("..", "maze", dirName), linkPath, "dir");
          }
        } catch (_err) {
          /* ignore symlink restrictions on locked Windows environments */
        }
      }
    });
  }

  function writeWorldParsing(gameId, worldWidth, worldHeight) {
    const mazeConfig = worldMaps.worldConfigForGame("maze");

    fs.writeFileSync(
      path.join(localWorldDir(gameId), "world_parsing.json"),
      `${JSON.stringify(
        {
          rules: {
            world_size: [worldWidth, worldHeight],
            level_size: [mazeConfig.levelSize.width, mazeConfig.levelSize.height],
            camera_view: [mazeConfig.cameraView.width, mazeConfig.cameraView.height]
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  function createLocalWorldSkeleton({ gameId, title, worldWidth, worldHeight, remote = null }) {
    const worldDir = localWorldDir(gameId);

    fs.mkdirSync(path.join(worldDir, "levels"), { recursive: true });
    fs.mkdirSync(path.join(worldDir, "previews"), { recursive: true });
    fs.copyFileSync(
      path.join(gamesDir, "maze", "level_parsing.json"),
      path.join(worldDir, "level_parsing.json")
    );
    writeWorldParsing(gameId, worldWidth, worldHeight);
    ensureSharedAssetLinks(gameId);

    const now = new Date().toISOString();
    writeDraftMeta(gameId, {
      id: gameId,
      title,
      created_at: now,
      updated_at: now,
      remote_id: remote?.id || null,
      remote_updated_at: remote?.updated_at || null,
      remote_status: remote?.status || null
    });
  }

  function removeLocalWorld(gameId) {
    const worldDir = localWorldDir(gameId);

    if (!fs.existsSync(draftMetaPath(gameId))) {
      throw new Error(`"${gameId}" is not a local world (missing draft.json).`);
    }

    fs.rmSync(worldDir, { recursive: true, force: true });
  }

  function normalizeEditorState(editorState) {
    if (!editorState || typeof editorState !== "object") {
      throw new Error("Editor state must be an object.");
    }

    if (editorState.version && editorState.version !== EDITOR_STATE_VERSION) {
      throw new Error(`Unsupported editor state version "${editorState.version}".`);
    }

    const worldWidth = clampWorldDimension(editorState.world?.width, 3);
    const worldHeight = clampWorldDimension(editorState.world?.height, 3);
    const rawLevels = Array.isArray(editorState.levels) ? editorState.levels : [];
    const seenIds = new Set();
    const levels = rawLevels.map((level, index) => {
      const coordinates = parseWorldLevelId(level?.id);

      if (!coordinates) {
        throw new Error(`Level ${index + 1} has an invalid id "${level?.id}".`);
      }

      if (coordinates.columnIndex >= worldWidth || coordinates.rowIndex >= worldHeight) {
        throw new Error(`Level "${level.id}" is outside the ${worldWidth}x${worldHeight} world.`);
      }

      if (seenIds.has(level.id)) {
        throw new Error(`Level "${level.id}" appears more than once.`);
      }

      seenIds.add(level.id);

      if (!Array.isArray(level?.cells)) {
        throw new Error(`Level "${level.id}" is missing a cells array.`);
      }

      return {
        id: level.id,
        column: coordinates.column,
        row: coordinates.row,
        cells: level.cells,
        width: level.width,
        height: level.height
      };
    });

    return {
      title: typeof editorState.title === "string" && editorState.title.trim()
        ? editorState.title.trim()
        : "Untitled World",
      worldWidth,
      worldHeight,
      levels
    };
  }

  function applyEditorStateLevels(gameId, levels) {
    const worldDir = localWorldDir(gameId);
    const levelsDir = path.join(worldDir, "levels");
    const game = getGame(gameId);

    if (!game) {
      throw new Error(`Local world "${gameId}" did not load as a game.`);
    }

    // 全量内存前置校验：先对所有房间进行合法性预校验与数据准备，若任一房间不合法立即抛错，杜绝部分写入
    const preparedLevels = levels.map((level) => {
      const sanitized = sanitizeEditorPayload(game, {
        cells: level.cells,
        width: level.width ?? (level.cells[0] || []).length,
        height: level.height ?? level.cells.length
      });
      return {
        fileName: `${level.id}.txt`,
        rawText: sanitized.rawText,
        coordinates: [level.column, level.row]
      };
    });

    const entries = {};
    preparedLevels.forEach((item) => {
      fs.writeFileSync(path.join(levelsDir, item.fileName), `${item.rawText}\n`, "utf8");
      entries[item.fileName] = item.coordinates;
    });

    // Drop level files that are no longer part of the world.
    const keepFileNames = new Set(Object.keys(entries));
    listTopLevelFiles(levelsDir).forEach((fileName) => {
      if (!keepFileNames.has(fileName)) {
        fs.unlinkSync(path.join(levelsDir, fileName));
      }
    });

    fs.writeFileSync(
      path.join(worldDir, "world_map.json"),
      `${JSON.stringify({ levels: entries }, null, 2)}\n`,
      "utf8"
    );
  }

  function createLocalWorld({ title, worldWidth, worldHeight, editorState = null, prefix = "draft", remote = null }) {
    const fallbackTitle =
      typeof title === "string" && title.trim() ? title.trim() : "Untitled World";
    const fallbackWidth = clampWorldDimension(worldWidth, 3);
    const fallbackHeight = clampWorldDimension(worldHeight, 3);
    const normalized = normalizeEditorState(
      editorState ||
        defaultEditorState({
          height: fallbackHeight,
          title: fallbackTitle,
          width: fallbackWidth
        })
    );
    const gameId = generateLocalWorldGameId(prefix);

    try {
      createLocalWorldSkeleton({
        gameId,
        title: title && String(title).trim() ? String(title).trim() : normalized.title,
        worldWidth: normalized.worldWidth,
        worldHeight: normalized.worldHeight,
        remote
      });

      applyEditorStateLevels(gameId, normalized.levels);
    } catch (error) {
      fs.rmSync(path.join(gamesDir, gameId), { recursive: true, force: true });
      throw error;
    }

    return getGame(gameId);
  }

  function replaceLocalWorldFromEditorState(gameId, editorState, { title = null, remote = null } = {}) {
    const normalized = normalizeEditorState(editorState);
    const worldDir = localWorldDir(gameId);
    const levelsDir = path.join(worldDir, "levels");
    const game = getGame(gameId);

    if (!game) {
      throw new Error(`Local world "${gameId}" did not load as a game.`);
    }

    // 1. 全量前置内存校验：在触碰任何磁盘文件前，在内存中对所有房间预先调用 sanitizeEditorPayload
    // 若发现非法 token 或尺寸不符，直接抛错，此时严禁触碰任何磁盘文件（world_parsing.json、world_map.json、levels/*.txt 100% 保持原样）
    normalized.levels.forEach((level) => {
      sanitizeEditorPayload(game, {
        cells: level.cells,
        width: level.width ?? (level.cells[0] || []).length,
        height: level.height ?? level.cells.length
      });
    });

    // 2. 事务快照备份：在系统临时目录备份现有关卡及核心元数据
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), `mazebench-world-backup-${gameId}-`));
    let isMutating = false;
    let rollbackFailed = false;
    const originalMetadataFiles = new Set();
    try {
      if (fs.existsSync(levelsDir)) {
        const backupLevelsDir = path.join(backupDir, "levels");
        fs.mkdirSync(backupLevelsDir, { recursive: true });
        listTopLevelFiles(levelsDir).forEach((file) => {
          fs.copyFileSync(path.join(levelsDir, file), path.join(backupLevelsDir, file));
        });
      }
      ["world_map.json", "world_parsing.json", "draft.json"].forEach((file) => {
        const src = path.join(worldDir, file);
        if (fs.existsSync(src)) {
          originalMetadataFiles.add(file);
          fs.copyFileSync(src, path.join(backupDir, file));
        }
      });

      // 3. 标记进入变更事务阶段：此后任何写入故障均触发回滚保护
      isMutating = true;

      writeWorldParsing(gameId, normalized.worldWidth, normalized.worldHeight);
      applyEditorStateLevels(gameId, normalized.levels);
      updateDraftMeta(gameId, {
        title: title || normalized.title,
        ...(remote
          ? {
              remote_id: remote.id ?? undefined,
              remote_updated_at: remote.updated_at ?? undefined,
              remote_status: remote.status ?? undefined
            }
          : {})
      });
    } catch (err) {
      // 4. 回滚保护：仅在已进入变更阶段时才执行回滚，杜绝备份未完成时误删原世界文件
      if (isMutating) {
        // A. 关卡房间文件还原（细粒度隔离：单个房间异常绝不阻断其他房间及元数据还原）
        try {
          const backupLevelsDir = path.join(backupDir, "levels");
          if (fs.existsSync(backupLevelsDir)) {
            if (!fs.existsSync(levelsDir)) {
              try {
                fs.mkdirSync(levelsDir, { recursive: true });
              } catch (mkdirErr) {
                rollbackFailed = true;
                console.error(`Failed to recreate levels directory during rollback for ${gameId}:`, mkdirErr);
              }
            }

            const backupFileNames = new Set(listTopLevelFiles(backupLevelsDir));

            // A1. 仅清理写入阶段新增的孤儿关卡文件（不在备份集中的文件）
            if (fs.existsSync(levelsDir)) {
              listTopLevelFiles(levelsDir).forEach((file) => {
                if (!backupFileNames.has(file)) {
                  try {
                    fs.unlinkSync(path.join(levelsDir, file));
                  } catch (unlinkErr) {
                    rollbackFailed = true;
                    console.error(`Failed to unlink stray level file ${file} during rollback for ${gameId}:`, unlinkErr);
                  }
                }
              });
            }

            // A2. 逐一覆盖还原每个原有关卡文件（每文件独立 try-catch）
            backupFileNames.forEach((file) => {
              try {
                fs.copyFileSync(path.join(backupLevelsDir, file), path.join(levelsDir, file));
              } catch (copyErr) {
                rollbackFailed = true;
                console.error(`Failed to restore level file ${file} during rollback for ${gameId}:`, copyErr);
              }
            });
          }
        } catch (levelsRollbackErr) {
          rollbackFailed = true;
          console.error(`Unexpected failure during levels rollback for ${gameId}:`, levelsRollbackErr);
        }

        // B. 核心元数据文件还原（细粒度隔离：每个元数据文件独立还原保护）
        ["world_map.json", "world_parsing.json", "draft.json"].forEach((file) => {
          try {
            const backupFile = path.join(backupDir, file);
            const targetFile = path.join(worldDir, file);
            if (fs.existsSync(backupFile)) {
              fs.copyFileSync(backupFile, targetFile);
            } else if (fs.existsSync(targetFile)) {
              // 仅当该元数据文件在备份中原本不存在时（即本次写入新增的文件），才执行删除
              try {
                fs.unlinkSync(targetFile);
              } catch (unlinkMetaErr) {
                rollbackFailed = true;
                console.error(`Failed to unlink stray metadata file ${file} during rollback for ${gameId}:`, unlinkMetaErr);
              }
            }
          } catch (metaErr) {
            rollbackFailed = true;
            console.error(`Failed to restore metadata file ${file} during rollback for ${gameId}:`, metaErr);
          }
        });

        if (rollbackFailed) {
          err.rollback_incomplete = true;
          err.backup_dir = backupDir;
          err.message = `${err.message} (Rollback incomplete for world "${gameId}"; backup preserved at "${backupDir}")`;
        }
      }
      throw err;
    } finally {
      // 5. 仅在更新成功或确认完整回滚后清理临时快照目录；回滚不完整时保留备份以供恢复
      if (!isMutating || !rollbackFailed) {
        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
        } catch (_e) {}
      } else {
        console.warn(`[build-worlds-local] Preserving world backup for "${gameId}" at: ${backupDir}`);
      }
    }

    return getGame(gameId);
  }

  function editorStateForGame(game) {
    const config = worldMaps.worldConfigForGame(game.id);
    const levels = (game.worldMap?.levels || []).map((level) => {
      const editorLevel = getLevelEditorState(game, level);

      return {
        id: level.id,
        column: level.column,
        row: level.row,
        title: `${level.column}x${level.row}`,
        width: editorLevel.width,
        height: editorLevel.height,
        cells: editorLevel.cells
      };
    });

    return {
      version: EDITOR_STATE_VERSION,
      title: game.name,
      world: {
        width: config.worldSize.width,
        height: config.worldSize.height
      },
      levels
    };
  }

  function createLocalWorldFromGame(sourceGameId, title) {
    const sourceGame = getGame(sourceGameId);

    if (!sourceGame || !sourceGame.worldMap) {
      throw new Error(`"${sourceGameId}" is not a world game.`);
    }

    const editorState = editorStateForGame(sourceGame);

    return createLocalWorld({
      title: title || `Copy of ${sourceGame.name}`,
      editorState
    });
  }

  function countWorldGems(game) {
    const gemTokens = new Set(
      Object.entries(game.parser?.objects || {})
        .filter(([name, config]) => (config?.type || name) === "gem")
        .flatMap(([, config]) =>
          typeof config?.token === "string"
            ? [config.token]
            : (config?.tokens || []).map((entry) => (typeof entry === "string" ? entry : entry?.token))
        )
        .filter(Boolean)
    );
    let total = 0;

    (game.worldMap?.levels || []).forEach((level) => {
      const editorLevel = getLevelEditorState(game, level);

      editorLevel.cells.forEach((row) => {
        row.forEach((cell) => {
          String(cell)
            .split("+")
            .forEach((token) => {
              if (gemTokens.has(token.trim())) {
                total += 1;
              }
            });
        });
      });
    });

    return total;
  }

  function describeLocalWorld(gameId) {
    const meta = readDraftMeta(gameId);
    const game = getGame(gameId);

    if (!meta || !game || !game.worldMap) {
      return null;
    }

    const config = worldMaps.worldConfigForGame(gameId);
    const defaultLevelId = worldMaps.defaultLevelIdForGame(game);
    const levelPreviews = Object.fromEntries(
      (game.worldMap?.levels || [])
        .filter((level) => level.previewUrl)
        .map((level) => [level.id, level.previewUrl])
    );

    return {
      id: gameId,
      title: game.name,
      kind: gameId.startsWith("online-") ? "online" : "draft",
      preview_urls: (game.worldMap?.levels || [])
        .map((level) => level.previewUrl)
        .filter(Boolean)
        .slice(0, 4),
      level_previews: levelPreviews,
      world_width: config.worldSize.width,
      world_height: config.worldSize.height,
      level_count: game.worldMap.levels.length,
      total_gems: countWorldGems(game),
      created_at: meta.created_at || null,
      updated_at: meta.updated_at || null,
      remote_id: meta.remote_id || null,
      remote_updated_at: meta.remote_updated_at || null,
      remote_status: meta.remote_status || null,
      default_level_id: defaultLevelId,
      first_level_id: defaultLevelId,
      play_url: `/play/${encodeURIComponent(gameId)}/${encodeURIComponent(defaultLevelId)}`,
      author_url: `/author/${encodeURIComponent(gameId)}/${encodeURIComponent(defaultLevelId)}`,
      world_map_url: `/world-map/${encodeURIComponent(gameId)}`,
      flyover_url: `/flyover/${encodeURIComponent(gameId)}/${encodeURIComponent(defaultLevelId)}`,
      export_url: `/api/build/worlds/${encodeURIComponent(gameId)}/export`
    };
  }

  function listLocalWorlds() {
    if (!fs.existsSync(gamesDir)) {
      return [];
    }

    return fs
      .readdirSync(gamesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isLocalWorldGameId(entry.name))
      .map((entry) => describeLocalWorld(entry.name))
      .filter(Boolean)
      .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")));
  }

  function touchLocalWorld(gameId) {
    if (isLocalWorldGameId(gameId) && fs.existsSync(draftMetaPath(gameId))) {
      updateDraftMeta(gameId, {});
    }
  }

  return {
    EDITOR_STATE_VERSION,
    countWorldGems,
    createLocalWorld,
    createLocalWorldFromGame,
    describeLocalWorld,
    editorStateForGame,
    isLocalWorldGameId,
    listLocalWorlds,
    normalizeEditorState,
    readDraftMeta,
    removeLocalWorld,
    replaceLocalWorldFromEditorState,
    touchLocalWorld,
    updateDraftMeta
  };
}

module.exports = {
  createLocalBuildWorldService
};
