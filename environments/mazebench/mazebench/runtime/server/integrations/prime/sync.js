"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function primeEvaluationReward(sample, scorecard = null) {
  const scalar = Number(sample?.reward);
  if (Number.isFinite(scalar)) return scalar;
  const components = Object.values(sample?.rewards || {})
    .map(Number)
    .filter(Number.isFinite);
  if (components.length) return components.reduce((sum, value) => sum + value, 0);
  const metricReward = Number(sample?.metrics?.reward);
  if (Number.isFinite(metricReward)) return metricReward;
  const percent = Number(scorecard?.result?.percent);
  return Number.isFinite(percent) ? percent / 100 : 0;
}

function readPrimeEvaluation(runDir) {
  return loadJson(path.join(runDir, "prime-evaluation.json"), null);
}

function writePrimeEvaluation(runDir, value) {
  const target = path.join(runDir, "prime-evaluation.json");
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return value;
}

function primePushEvaluationId(value) {
  const text = String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const payload = JSON.parse(lines[index]);
      const id = String(payload?.evaluation_id || payload?.eval_id || "");
      if (id) return id;
    } catch (_error) {
      /* Prime also prints human-readable progress before its final JSON. */
    }
  }
  const jsonMatch = text.match(/"evaluation_id"\s*:\s*"([a-z0-9]+)"/i);
  if (jsonMatch) return jsonMatch[1];
  return text.match(/Evaluation ID:\s*([a-z0-9]+)/i)?.[1] || "";
}

function primeEnvironmentForRun(meta) {
  return String(
    meta.prime_environment ||
    process.env.MAZEBENCH_PRIME_ENVIRONMENT ||
    "mazebench/mazebench"
  );
}

function primeEvalMetadata(runId, meta, environment, existing = {}) {
  return {
    ...existing,
    env_id: environment,
    model: String(meta.model_name || meta.model || "prime"),
    framework: existing.framework || "verifiers",
    task_type: existing.task_type || "agent-evaluation",
    mazebench_run_id: runId,
    mazebench_harness: String(meta.harness || "none"),
    mazebench_harness_label: String(meta.harness_label || "Prime Intellect"),
    mazebench_observation_mode: String(meta.mode || "text"),
    mazebench_execution: "local",
    mazebench_run_status: String(meta.status || ""),
    num_examples: Number(existing.num_examples) || 1,
    rollouts_per_example: Number(existing.rollouts_per_example) || 1
  };
}

module.exports = {
  primeEvaluationReward,
  readPrimeEvaluation,
  writePrimeEvaluation,
  primePushEvaluationId,
  primeEnvironmentForRun,
  primeEvalMetadata
};
