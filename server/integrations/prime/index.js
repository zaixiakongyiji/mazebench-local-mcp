"use strict";

const catalog = require("./catalog");
const runner = require("./runner");
const sync = require("./sync");
const resume = require("./resume");

class PrimeIntegration {
  constructor(options = {}) {
    this.options = options;
    this.syncEvaluations = Boolean(options.syncEvaluations ?? options.syncPrimeEvaluations);
  }

  get enabled() {
    return true;
  }

  get catalog() {
    return catalog;
  }

  get runner() {
    return runner;
  }

  get sync() {
    return sync;
  }

  get resume() {
    return resume;
  }

  listHarnesses() {
    return catalog.publicPrimeHarnesses();
  }

  filterCatalog(catalogData, harnessId) {
    return catalog.filterPrimeCatalogForHarness(catalogData, harnessId);
  }

  normalizeHarness(harnessId) {
    return catalog.normalizePrimeHarness(harnessId);
  }

  normalizeHarnessConfig(value, harnessId) {
    return catalog.normalizePrimeHarnessConfig(value, harnessId);
  }

  reasoningLevels(modelId) {
    return catalog.primeReasoningLevels(modelId);
  }

  cleanupSandboxes(runId, runDir, rootDir, env) {
    return runner.stopPrimeAgentSandboxes(runId, runDir, rootDir, env);
  }
}

function createPrimeIntegration(options = {}) {
  return new PrimeIntegration(options);
}

module.exports = {
  PrimeIntegration,
  createPrimeIntegration,
  catalog,
  runner,
  sync,
  resume
};
