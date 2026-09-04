const INSTRUCTIONS_VERSION = "external-mcp-v1";

function normalizeModelName(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw { status: 400, code: "INVALID_ARGUMENT", message: "model_name is required when claiming a new run" };
  }

  if (typeof value !== "string") {
    throw { status: 400, code: "INVALID_ARGUMENT", message: "model_name must be a string" };
  }

  const normalized = value.trim();
  if (!normalized) {
    throw { status: 400, code: "INVALID_ARGUMENT", message: "model_name must not be empty" };
  }
  if (normalized.length > 128) {
    throw { status: 400, code: "INVALID_ARGUMENT", message: "model_name must be at most 128 characters" };
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw { status: 400, code: "INVALID_ARGUMENT", message: "model_name must not contain control characters" };
  }
  return normalized;
}

function buildRunInstructions(run) {
  const budget = run.maxActions
    ? `You have at most ${run.maxActions} game actions.`
    : `This run ends at its server-enforced deadline after ${Math.round(Number(run.durationMs || 0) / 1000)} seconds.`;

  return `You are controlling an authoritative MazeBench 3D grid game through the configured MCP server.
Use only the MazeBench game tools to change game state. The start call has already claimed this run; do not call start again unless reconnecting.

Goal: explore as many unique rooms and collect as many unique gems as possible. ${budget}
Continue taking actions until the server reports ended=true, the maze is won, or no legal recovery remains. Do not stop merely to ask the user for an ordinary movement decision.

Available controls are up, down, left, right, rotate_camera_up, rotate_camera_down, rotate_camera_left, rotate_camera_right, undo, reset, go_to_level, observe, and action_sequence. Read every returned observation before choosing the next action. action_sequence may submit an ordered route, but every action is still validated, budgeted, persisted, and stops on terminal state, death, rejection, or exhausted budget.

If the player dies or becomes stuck, recover with undo, reset, or go_to_level for a previously visited room. Scoring and hidden world data are runner-only; do not request or attempt to access source files, scorecards, hidden maps, host files, shell commands, or network tools.`;
}

module.exports = {
  INSTRUCTIONS_VERSION,
  buildRunInstructions,
  normalizeModelName
};
