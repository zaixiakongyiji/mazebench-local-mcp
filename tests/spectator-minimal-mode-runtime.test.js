const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");
const liveExternalPlayPath = path.join(rootDir, "public", "external-play.js");
const mirrorExternalPlayPath = path.join(
  rootDir,
  "environments",
  "mazebench",
  "mazebench",
  "runtime",
  "public",
  "external-play.js"
);
const livePlayCorePath = path.join(rootDir, "public", "play-core.js");
const mirrorPlayCorePath = path.join(
  rootDir,
  "environments",
  "mazebench",
  "mazebench",
  "runtime",
  "public",
  "play-core.js"
);

test("spectator minimal mode code parity between live and runtime mirror files", () => {
  assert.ok(fs.existsSync(liveExternalPlayPath), "public/external-play.js must exist");
  assert.ok(fs.existsSync(mirrorExternalPlayPath), "runtime mirror external-play.js must exist");
  assert.ok(fs.existsSync(livePlayCorePath), "public/play-core.js must exist");
  assert.ok(fs.existsSync(mirrorPlayCorePath), "runtime mirror play-core.js must exist");

  const liveExternalPlay = fs.readFileSync(liveExternalPlayPath, "utf8");
  const mirrorExternalPlay = fs.readFileSync(mirrorExternalPlayPath, "utf8");
  assert.equal(
    liveExternalPlay,
    mirrorExternalPlay,
    "public/external-play.js and its runtime mirror must be strictly identical"
  );

  const livePlayCore = fs.readFileSync(livePlayCorePath, "utf8");
  const mirrorPlayCore = fs.readFileSync(mirrorPlayCorePath, "utf8");
  assert.equal(
    livePlayCore,
    mirrorPlayCore,
    "public/play-core.js and its runtime mirror must be strictly identical"
  );
});

test("external-play.js defines STORAGE_KEY_MINIMAL_MODE, queries #playback-minimal-btn, and safely guards localStorage", () => {
  const content = fs.readFileSync(liveExternalPlayPath, "utf8");

  // Storage key definition
  assert.match(
    content,
    /const\s+STORAGE_KEY_MINIMAL_MODE\s*=\s*["']mazebench_spectator_minimal_mode["']/,
    "Must define const STORAGE_KEY_MINIMAL_MODE = 'mazebench_spectator_minimal_mode'"
  );

  // Button query
  assert.match(
    content,
    /getElementById\(["']playback-minimal-btn["']\)/,
    "Must query #playback-minimal-btn by id"
  );

  // localStorage wrapped in try...catch
  assert.match(
    content,
    /try\s*\{[^}]*localStorage\.getItem\([^}]*STORAGE_KEY_MINIMAL_MODE[^}]*\}[^}]*catch/,
    "localStorage.getItem must be wrapped in try...catch"
  );
  assert.match(
    content,
    /try\s*\{[^}]*localStorage\.setItem\([^}]*STORAGE_KEY_MINIMAL_MODE[^}]*\}[^}]*catch/,
    "localStorage.setItem must be wrapped in try...catch"
  );

  // Effect toggling and ticker synchronization
  assert.match(content, /app\.state\.effects\.fuzzyEnabled/);
  assert.match(content, /syncNoiseTicker/);
  assert.match(content, /render\(\)/);
});

test("play-core.js initializes fuzzyEnabled: false when spectator minimal mode is saved in localStorage", () => {
  const content = fs.readFileSync(livePlayCorePath, "utf8");

  // In line 212 area, check for spectator minimal mode fallback
  assert.match(
    content,
    /mazebench_spectator_minimal_mode/,
    "play-core.js must reference mazebench_spectator_minimal_mode for zero-flash initial state"
  );
  assert.match(
    content,
    /try\s*\{[^}]*localStorage\.getItem\(["']mazebench_spectator_minimal_mode["']\)/,
    "play-core.js localStorage access must be wrapped in try...catch"
  );
});

function createMockSpectatorEnv({ initialStorage = {} } = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const localStorageMock = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, val) => {
      storage.set(key, String(val));
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    }
  };

  const elements = new Map();

  function createMockElement(id) {
    const classListSet = new Set();
    const attributes = new Map();
    const listeners = new Map();

    const elem = {
      id,
      tagName: "BUTTON",
      classList: {
        add: (cls) => classListSet.add(cls),
        remove: (cls) => classListSet.delete(cls),
        contains: (cls) => classListSet.has(cls),
        toggle: (cls, force) => {
          if (force === undefined) {
            if (classListSet.has(cls)) {
              classListSet.delete(cls);
              return false;
            } else {
              classListSet.add(cls);
              return true;
            }
          }
          if (force) {
            classListSet.add(cls);
            return true;
          } else {
            classListSet.delete(cls);
            return false;
          }
        }
      },
      setAttribute: (name, val) => attributes.set(name, String(val)),
      getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
      hasAttribute: (name) => attributes.has(name),
      removeAttribute: (name) => attributes.delete(name),
      addEventListener: (type, handler) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      dispatchEvent: (type, event = {}) => {
        const handlers = listeners.get(type) || [];
        for (const h of handlers) {
          h(event);
        }
      },
      click: () => {
        elem.dispatchEvent("click", { target: elem, preventDefault: () => {} });
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      remove: () => {},
      appendChild: () => {},
      style: {}
    };
    return elem;
  }

  // Prepopulate standard spectator elements
  const requiredIds = [
    "playback-minimal-btn",
    "playback-scrubber",
    "playback-play-btn",
    "playback-prev-btn",
    "playback-next-btn",
    "playback-step-label",
    "playback-live-btn",
    "playback-summary-btn",
    "spectator-action-feed",
    "action-feed-list",
    "summary-overlay",
    "summary-outcome-badge",
    "summary-outcome",
    "summary-elapsed",
    "summary-actions",
    "summary-gems",
    "summary-rooms",
    "summary-cli",
    "summary-replay-btn",
    "summary-dismiss-btn",
    "summary-close-btn",
    "spectator-overlay-hud",
    "toggle-hud-btn",
    "cancel-run-btn",
    "spectator-budget",
    "spectator-budget-val",
    "spectator-rooms-stat",
    "spectator-rooms-val",
    "spectator-gems",
    "spectator-gems-val",
    "spectator-actions",
    "spectator-actions-val",
    "spectator-room",
    "spectator-room-val",
    "controller-status"
  ];

  for (const id of requiredIds) {
    const elem = createMockElement(id);
    if (id === "playback-minimal-btn") {
      elem.setAttribute("aria-pressed", "false");
    }
    elements.set(id, elem);
  }

  const documentMock = {
    readyState: "complete",
    getElementById: (id) => elements.get(id) || null,
    querySelector: (sel) => {
      if (sel.startsWith("#")) {
        return elements.get(sel.slice(1)) || null;
      }
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => createMockElement(`created-${tag}-${Date.now()}`),
    addEventListener: () => {}
  };

  const activeIntervals = new Map();
  let nextIntervalId = 1;

  const windowMock = {
    localStorage: localStorageMock,
    document: documentMock,
    console,
    __EXTERNAL_PLAY_RUN__: { run_id: "test-run-123", status: "running" },
    __MAZEBENCH_SPECTATOR_HOST__: {
      applySnapshot: async () => {},
      executeAction: async () => true
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        snapshot: {
          actions_total: 0,
          current_room: "level_HxI",
          events: [],
          gems_collected: 0
        },
        events: [],
        actions_total: 0,
        gems_collected: 0,
        current_room: "level_HxI"
      })
    }),
    EventSource: function () {
      return { addEventListener: () => {}, close: () => {} };
    },
    setInterval: (fn, delay) => {
      const id = nextIntervalId++;
      activeIntervals.set(id, { fn, delay, cleared: false });
      return id;
    },
    clearInterval: (id) => {
      const entry = activeIntervals.get(id);
      if (entry) {
        entry.cleared = true;
      }
    },
    setTimeout: () => 456,
    clearTimeout: () => {},
    TextEncoder,
    crypto: {
      subtle: {
        digest: async () => new Uint8Array([1, 2, 3]).buffer
      }
    }
  };

  windowMock.window = windowMock;
  windowMock.globalThis = windowMock;
  windowMock.self = windowMock;

  return { windowMock, documentMock, localStorageMock, elements, storage, activeIntervals };
}

test("runtime behavior: button click toggles minimal mode, localStorage, and app effects", async () => {
  const { windowMock, elements, localStorageMock } = createMockSpectatorEnv();

  let syncNoiseTickerCalled = 0;
  let renderCalled = 0;

  const mockApp = {
    state: {
      effects: {
        fuzzyEnabled: true,
        edgeOutlinesEnabled: true
      }
    },
    syncNoiseTicker: () => {
      syncNoiseTickerCalled++;
    },
    render: () => {
      renderCalled++;
    }
  };

  windowMock.__MAZEBENCH_APP__ = mockApp;

  const scriptCode = fs.readFileSync(liveExternalPlayPath, "utf8");
  const context = vm.createContext(windowMock);
  vm.runInContext(scriptCode, context);

  const minimalBtn = elements.get("playback-minimal-btn");
  assert.ok(minimalBtn, "#playback-minimal-btn must exist");

  // Initial state: not minimal
  assert.equal(minimalBtn.classList.contains("is-active"), false, "Initially not active");
  assert.equal(minimalBtn.getAttribute("aria-pressed"), "false", "Initially aria-pressed is false");
  assert.equal(mockApp.state.effects.fuzzyEnabled, true, "Initially fuzzyEnabled is true");

  // Click 1: Activate Minimal Mode
  minimalBtn.click();

  assert.equal(minimalBtn.classList.contains("is-active"), true, "Should be active after click");
  assert.equal(minimalBtn.getAttribute("aria-pressed"), "true", "aria-pressed should be true");
  assert.equal(localStorageMock.getItem("mazebench_spectator_minimal_mode"), "true", "Saved as true in storage");
  assert.equal(mockApp.state.effects.fuzzyEnabled, false, "fuzzyEnabled must be toggled to false");
  assert.ok(syncNoiseTickerCalled >= 1, "syncNoiseTicker must be called");
  assert.ok(renderCalled >= 1, "render must be called");

  // Click 2: Deactivate Minimal Mode
  const prevSyncCount = syncNoiseTickerCalled;
  const prevRenderCount = renderCalled;
  minimalBtn.click();

  assert.equal(minimalBtn.classList.contains("is-active"), false, "Should be inactive after second click");
  assert.equal(minimalBtn.getAttribute("aria-pressed"), "false", "aria-pressed should be false");
  assert.equal(localStorageMock.getItem("mazebench_spectator_minimal_mode"), "false", "Saved as false in storage");
  assert.equal(mockApp.state.effects.fuzzyEnabled, true, "fuzzyEnabled must be toggled back to true");
  assert.ok(syncNoiseTickerCalled > prevSyncCount, "syncNoiseTicker must be called on toggle back");
  assert.ok(renderCalled > prevRenderCount, "render must be called on toggle back");
});

test("runtime behavior: boots with minimal mode active if saved in localStorage", async () => {
  const { windowMock, elements } = createMockSpectatorEnv({
    initialStorage: { mazebench_spectator_minimal_mode: "true" }
  });

  let syncNoiseTickerCalled = 0;
  let renderCalled = 0;

  const mockApp = {
    state: {
      effects: {
        fuzzyEnabled: true,
        edgeOutlinesEnabled: true
      }
    },
    syncNoiseTicker: () => {
      syncNoiseTickerCalled++;
    },
    render: () => {
      renderCalled++;
    }
  };

  windowMock.__MAZEBENCH_APP__ = mockApp;

  const scriptCode = fs.readFileSync(liveExternalPlayPath, "utf8");
  const context = vm.createContext(windowMock);
  vm.runInContext(scriptCode, context);

  const minimalBtn = elements.get("playback-minimal-btn");
  assert.equal(minimalBtn.classList.contains("is-active"), true, "Must be .is-active on boot");
  assert.equal(minimalBtn.getAttribute("aria-pressed"), "true", "Must have aria-pressed='true' on boot");
  assert.equal(mockApp.state.effects.fuzzyEnabled, false, "fuzzyEnabled must be set to false on boot");
  assert.ok(syncNoiseTickerCalled >= 1, "syncNoiseTicker must be called on boot when active");
  assert.ok(renderCalled >= 1, "render must be called on boot when active");
});

test("runtime behavior: handles localStorage exceptions gracefully without throwing", () => {
  const { windowMock, elements } = createMockSpectatorEnv();

  // Make localStorage throw SecurityError
  windowMock.localStorage.getItem = () => {
    throw new Error("SecurityError: Access denied");
  };
  windowMock.localStorage.setItem = () => {
    throw new Error("SecurityError: Access denied");
  };

  const scriptCode = fs.readFileSync(liveExternalPlayPath, "utf8");
  const context = vm.createContext(windowMock);

  assert.doesNotThrow(() => {
    vm.runInContext(scriptCode, context);
  }, "Script execution must not throw when localStorage throws");

  const minimalBtn = elements.get("playback-minimal-btn");
  assert.doesNotThrow(() => {
    minimalBtn.click();
  }, "Clicking button must not throw when localStorage throws");
});

test("runtime behavior: delayed app mounting picks up minimal mode and clears polling interval", () => {
  const { windowMock, activeIntervals } = createMockSpectatorEnv({
    initialStorage: { mazebench_spectator_minimal_mode: "true" }
  });

  // Ensure window.__MAZEBENCH_APP__ is initially null / undefined
  assert.equal(windowMock.__MAZEBENCH_APP__, undefined);

  const scriptCode = fs.readFileSync(liveExternalPlayPath, "utf8");
  const context = vm.createContext(windowMock);
  vm.runInContext(scriptCode, context);

  // An interval with 50ms delay should have been registered for polling the app
  const appPollInterval = Array.from(activeIntervals.values()).find((entry) => entry.delay === 50);
  assert.ok(appPollInterval, "Should register polling interval with 50ms delay");
  assert.equal(appPollInterval.cleared, false, "Interval should initially not be cleared");

  // Tick the interval once while app is still not mounted
  appPollInterval.fn();
  assert.equal(appPollInterval.cleared, false, "Interval should still not be cleared if app is still missing");

  // Now simulate delayed app mounting (using renderOncePerFrame to also verify fallback)
  let syncNoiseTickerCalled = 0;
  let renderOncePerFrameCalled = 0;

  const mockApp = {
    state: {
      effects: {
        fuzzyEnabled: true,
        edgeOutlinesEnabled: true
      }
    },
    syncNoiseTicker: () => {
      syncNoiseTickerCalled++;
    },
    renderOncePerFrame: () => {
      renderOncePerFrameCalled++;
    }
  };

  windowMock.__MAZEBENCH_APP__ = mockApp;

  // Next tick of the interval should detect app, apply minimal mode, and clear interval
  appPollInterval.fn();

  assert.equal(appPollInterval.cleared, true, "Interval must be cleared once app is detected and synced");
  assert.equal(mockApp.state.effects.fuzzyEnabled, false, "fuzzyEnabled must be updated to false");
  assert.ok(syncNoiseTickerCalled >= 1, "syncNoiseTicker must have been called");
  assert.ok(renderOncePerFrameCalled >= 1, "renderOncePerFrame fallback must have been called");
});

