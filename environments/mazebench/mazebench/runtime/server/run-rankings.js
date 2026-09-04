const fs = require("fs");
const path = require("path");

const noveltyCache = new Map();

function getRunFinalNovelty(runDir, summary = null) {
  if (summary && summary.novelty != null && Number.isFinite(Number(summary.novelty))) {
    return Math.min(100, Math.max(0, Math.round(Number(summary.novelty))));
  }
  if (!runDir || !fs.existsSync(runDir)) return 0;

  const actionsPath = path.join(runDir, "actions.jsonl");
  const journalPath = path.join(runDir, "journal.jsonl");
  const targetPath = fs.existsSync(actionsPath) ? actionsPath : (fs.existsSync(journalPath) ? journalPath : null);
  if (!targetPath) return 0;

  try {
    const stat = fs.statSync(targetPath);
    const cached = noveltyCache.get(targetPath);
    if (cached && cached.mtime === stat.mtimeMs) return cached.novelty;

    const noveltyWindow = [];
    const seen = new Set();
    let lastNovelty = 0;
    for (const line of fs.readFileSync(targetPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        let room = null;
        let player = null;
        if (entry.type === "action_committed") {
          const viewer = entry.action_record?.post_viewer_state;
          room = viewer?.current_room || entry.action_record?.sanitized_status?.current_room || "level_HxI";
          player = viewer?.player;
        } else if (entry.post_viewer_state) {
          room = entry.post_viewer_state.current_room || "level_HxI";
          player = entry.post_viewer_state.player;
        } else if (entry.player && entry.room) {
          room = entry.room;
          player = entry.player;
        }

        if (player && typeof player.x === "number" && typeof player.y === "number") {
          const cellKey = `${room || "level_HxI"}:${player.x}:${player.y}`;
          noveltyWindow.push(seen.has(cellKey) ? 0 : 1);
          seen.add(cellKey);
          if (noveltyWindow.length > 50) noveltyWindow.shift();
          lastNovelty = Math.round((noveltyWindow.reduce((sum, value) => sum + value, 0) / noveltyWindow.length) * 100);
        }
      } catch (_error) {}
    }

    noveltyCache.set(targetPath, { mtime: stat.mtimeMs, novelty: lastNovelty });
    return lastNovelty;
  } catch (_error) {
    return 0;
  }
}

function compareByRooms(left, right) {
  return ((Number(right.room_count) || 0) - (Number(left.room_count) || 0))
    || ((Number(right.gem_count) || 0) - (Number(left.gem_count) || 0))
    || ((Number(right.novelty) || 0) - (Number(left.novelty) || 0))
    || ((Number(left.turns ?? left.moves ?? 0) || 0) - (Number(right.turns ?? right.moves ?? 0) || 0))
    || String(right.created_at || "").localeCompare(String(left.created_at || ""));
}

function compareByGems(left, right) {
  return ((Number(right.gem_count) || 0) - (Number(left.gem_count) || 0))
    || ((Number(right.room_count) || 0) - (Number(left.room_count) || 0))
    || ((Number(right.novelty) || 0) - (Number(left.novelty) || 0))
    || ((Number(left.turns ?? left.moves ?? 0) || 0) - (Number(right.turns ?? right.moves ?? 0) || 0))
    || String(right.created_at || "").localeCompare(String(left.created_at || ""));
}

function dedupePerModel(list) {
  const seen = new Set();
  return list.filter((run) => {
    const key = String(run.model_name || run.model || "").trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildLeaderboardRankings(runsList, formatItem) {
  const sortedByRooms = [...runsList].sort(compareByRooms);
  const sortedByGems = [...runsList].sort(compareByGems);
  const format = (list) => list.map((run, index) => formatItem(run, index + 1));

  return {
    by_rooms: {
      per_model: format(dedupePerModel(sortedByRooms)),
      all_runs: format(sortedByRooms)
    },
    by_gems: {
      per_model: format(dedupePerModel(sortedByGems)),
      all_runs: format(sortedByGems)
    }
  };
}

function completionTier(outcome) {
  if (outcome === "won") return 2;
  if (outcome === "action_limit" || outcome === "timed_out") return 1;
  return 0;
}

function compareCompetitionEntries(left, right) {
  return (completionTier(right.outcome) - completionTier(left.outcome))
    || ((Number(right.rooms_visited) || 0) - (Number(left.rooms_visited) || 0))
    || ((Number(right.gems_collected) || 0) - (Number(left.gems_collected) || 0))
    || ((Number(right.novelty) || 0) - (Number(left.novelty) || 0))
    || ((Number(left.actions_total) || 0) - (Number(right.actions_total) || 0))
    || String(left.entry_id || "").localeCompare(String(right.entry_id || ""));
}

function rankCompetitionEntries(entries) {
  return [...entries].sort(compareCompetitionEntries).map((entry, index) => ({
    rank: index + 1,
    entry_id: entry.entry_id,
    run_id: entry.run_id,
    model_name: entry.model_name,
    harness: entry.harness,
    outcome: entry.outcome,
    rooms_visited: Number(entry.rooms_visited) || 0,
    gems_collected: Number(entry.gems_collected) || 0,
    novelty: Number(entry.novelty) || 0,
    actions_total: Number(entry.actions_total) || 0
  }));
}

module.exports = {
  buildLeaderboardRankings,
  compareCompetitionEntries,
  getRunFinalNovelty,
  rankCompetitionEntries
};
