"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  getPrimeHarnesses,
  normalizePrimeHarness,
  normalizePrimeHarnessConfig,
  primeHarnessModelCompatible,
  primeReasoningLevels,
  PRIME_PYTHON_HARNESSES,
  UNSAFE_PRIME_AGENT_HARNESS_MESSAGE
} = require("./catalog");

const GAME_WON_GEM_COUNT = 100;

function primeSandboxIdsFromText(value) {
  const ids = new Set();
  const text = String(value || "");
  for (const pattern of [
    /\bsandbox\s+([a-z0-9]{12,64})\s+up\b/gi,
    /\bsandbox-job-([a-z0-9]{12,64})\b/gi
  ]) {
    for (const match of text.matchAll(pattern)) ids.add(match[1]);
  }
  return [...ids];
}

function normalizeObservationMode(value) {
  const mode = String(value || "text").toLowerCase();
  return ["json", "vision"].includes(mode) ? mode : "text";
}

function positiveTurnBudget(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
}

function resolvedHideNamesSeed(hideNames, seed) {
  if (!hideNames) return "1";
  const str = String(seed || "").trim();
  return str || "1";
}

function stopPrimeAgentSandboxes(runId, runDir, rootDir, env = process.env) {
  const ids = new Set();
  for (const filePath of [
    path.join(runDir, "launcher.log"),
    path.join(runDir, "eval-output", "eval.log")
  ]) {
    try {
      primeSandboxIdsFromText(fs.readFileSync(filePath, "utf8")).forEach((id) => ids.add(id));
    } catch (_error) {
      /* the sandbox may not have started or logged its id yet */
    }
  }
  if (!ids.size) return false;

  const sandboxIds = [...ids];
  const result = spawnSync(
    "prime",
    ["sandbox", "delete", ...sandboxIds, "--yes", "--plain"],
    {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
  const record = {
    sandbox_ids: sandboxIds,
    stopped_at: result.status === 0 ? new Date().toISOString() : null,
    error: result.status === 0
      ? null
      : String(result.stderr || result.stdout || "Prime sandbox cleanup failed.").trim()
  };
  try {
    fs.writeFileSync(
      path.join(runDir, "prime-sandbox-cleanup.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8"
    );
  } catch (_error) {
    /* cleanup must still proceed when its audit record cannot be written */
  }
  return result.status === 0;
}

module.exports = {
  GAME_WON_GEM_COUNT,
  primeSandboxIdsFromText,
  normalizeObservationMode,
  positiveTurnBudget,
  resolvedHideNamesSeed,
  stopPrimeAgentSandboxes
};
