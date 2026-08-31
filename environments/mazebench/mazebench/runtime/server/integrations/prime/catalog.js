"use strict";

const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

let _catalogJson = null;
function getCatalogJson() {
  if (!_catalogJson) {
    _catalogJson = require("../../../environments/mazebench/prime-harness-catalog.json");
  }
  return _catalogJson;
}

let _harnessesMap = null;
function getPrimeHarnesses() {
  if (!_harnessesMap) {
    const catalog = getCatalogJson();
    _harnessesMap = new Map(
      catalog.harnesses.map((definition) => [definition.id, {
        ...definition,
        launchable: Boolean(definition.launchable),
        taskset: "mazebench-tools",
        protocol: definition.adapter,
        custom: true
      }])
    );
  }
  return _harnessesMap;
}

const UNSAFE_PRIME_AGENT_HARNESS_MESSAGE =
  "This Prime harness is not approved for MazeBench's isolated game-control boundary.";

const STANDARD_REASONING_LEVELS = ["low", "medium", "high"];
const PRIME_REASONING_LEVELS = ["low", "medium", "high"];
const PRIME_PYTHON_HARNESSES = new Set(["codex", "claude_code"]);

function primeReasoningLevels(_modelId) {
  return [...PRIME_REASONING_LEVELS];
}

function normalizePrimeHarness(value) {
  const requested = String(value || "mazebench_prime_agent").trim().toLowerCase();
  const aliases = {
    claude: "claude_code",
    "claude-code": "claude_code",
    default: "mazebench_prime_agent",
    "prime-agent": "mazebench_prime_agent",
    prime_agent: "mazebench_prime_agent",
    "kimi-code": "kimi_code",
    "mini-swe-agent": "mini_swe_agent",
    none: "mazebench_prime_agent",
    "terminus-2": "terminus_2"
  };
  const normalized = aliases[requested] || requested;
  const harnesses = getPrimeHarnesses();
  if (!harnesses.has(normalized)) {
    throw new Error(
      `Unknown Prime harness "${value}". Supported harnesses: ${[...harnesses.keys()].join(", ")}.`
    );
  }
  return normalized;
}

function primeHarnessModelCompatible(modelId, harnessId) {
  const harness = normalizePrimeHarness(harnessId);
  const id = String(modelId || "").trim();
  if (!id) return false;
  return true;
}

function filterPrimeCatalogForHarness(catalog, harnessId) {
  const harness = normalizePrimeHarness(harnessId);
  const harnesses = getPrimeHarnesses();
  const definition = harnesses.get(harness);
  const allModels = Array.isArray(catalog?.models) ? catalog.models : [];
  if (!definition?.launchable) {
    return {
      ...catalog,
      harness,
      models: [],
      default_model_id: "",
      note: definition?.reason || UNSAFE_PRIME_AGENT_HARNESS_MESSAGE
    };
  }
  const models = allModels
    .filter((model) => primeHarnessModelCompatible(model.id, harness))
    .map((model) => ({
      ...model,
      harness_compatible: true,
      compatibility: definition.adapter || definition.protocol
    }));
  return {
    ...catalog,
    harness,
    models,
    default_model_id: models[0]?.id || "",
    note: models.length
      ? `${models.length} live Prime model${models.length === 1 ? "" : "s"}. ${definition.label} is connected through MazeBench's ${definition.adapter || "native"} game-tools-only route.`
      : catalog?.note || `Prime's live model catalog is currently empty.`
  };
}

function publicPrimeHarnesses() {
  const harnesses = getPrimeHarnesses();
  const catalog = getCatalogJson();
  return [...harnesses.values()]
    .filter((definition) => definition.custom && definition.id === "mazebench_prime_agent")
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description || "",
      launchable: Boolean(definition.launchable),
      reason: definition.reason || "",
      protocol: definition.protocol || "",
      boundary: definition.boundary || "",
      observation_modes: [...(definition.observation_modes || [])],
      default_config: { ...(definition.default_config || {}) },
      configurable: [...(definition.configurable || [])],
      config_schema: definition.config_schema || { properties: {} },
      adapter: definition.adapter || "native_mcp",
      runtime_harness_id: definition.runtime_harness_id || definition.id,
      upstream_id: definition.upstream_id || null,
      supports_mcp: Boolean(definition.supports_mcp),
      status: definition.status || (definition.launchable ? "compatible" : "catalog_error"),
      catalog_fingerprint: catalog.catalog_fingerprint,
      verifiers_version: catalog.verifiers_version
    }));
}

function primeHarnessConfigValueValid(value, schema = {}) {
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((option) => primeHarnessConfigValueValid(value, option));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return false;
    return true;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return false;
    if (Array.isArray(schema.prefixItems)) {
      return schema.prefixItems.every((item, index) => primeHarnessConfigValueValid(value[index], item));
    }
    return !schema.items || value.every((item) => primeHarnessConfigValueValid(item, schema.items));
  }
  if (schema.type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value);
}

function normalizePrimeHarnessConfig(value, harnessId) {
  const harnesses = getPrimeHarnesses();
  const definition = harnesses.get(normalizePrimeHarness(harnessId));
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 16_384) {
    throw new Error(`${definition.label} configuration is too large.`);
  }
  const allowed = new Set(definition.configurable || []);
  const defaults = definition.default_config || {};
  const unknown = Object.keys(raw).filter((key) =>
    !allowed.has(key) &&
    !(Object.prototype.hasOwnProperty.call(defaults, key) && isDeepStrictEqual(raw[key], defaults[key]))
  );
  if (unknown.length) {
    throw new Error(`Unsupported ${definition.label} configuration: ${unknown.join(", ")}.`);
  }
  const config = { ...defaults };
  for (const [key, val] of Object.entries(raw)) {
    const schema = definition.config_schema?.properties?.[key] || {};
    if (!primeHarnessConfigValueValid(val, schema)) {
      throw new Error(`${definition.label} configuration field "${key}" does not match its pinned Verifiers schema.`);
    }
    config[key] = val;
  }
  return config;
}

module.exports = {
  getCatalogJson,
  getPrimeHarnesses,
  UNSAFE_PRIME_AGENT_HARNESS_MESSAGE,
  STANDARD_REASONING_LEVELS,
  PRIME_REASONING_LEVELS,
  PRIME_PYTHON_HARNESSES,
  primeReasoningLevels,
  normalizePrimeHarness,
  primeHarnessModelCompatible,
  filterPrimeCatalogForHarness,
  publicPrimeHarnesses,
  primeHarnessConfigValueValid,
  normalizePrimeHarnessConfig
};
