const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const files = [
  "public/play-core.js",
  "public/play.js",
  "public/external-play-host.js"
];

test("spectator URL isolation parity between live and runtime mirror files", () => {
  for (const relPath of files) {
    const livePath = path.join(rootDir, relPath);
    const mirrorPath = path.join(
      rootDir,
      "environments",
      "mazebench",
      "mazebench",
      "runtime",
      relPath
    );
    assert.ok(fs.existsSync(livePath), livePath + " must exist");
    assert.ok(fs.existsSync(mirrorPath), mirrorPath + " must exist");

    const liveContent = fs.readFileSync(livePath, "utf8");
    const mirrorContent = fs.readFileSync(mirrorPath, "utf8");
    assert.equal(
      liveContent,
      mirrorContent,
      relPath + " and its runtime mirror must be strictly identical"
    );
  }
});

test("play-core.js guards applyLevelState URL rewriting against external spectator", () => {
  const content = fs.readFileSync(path.join(rootDir, "public", "play-core.js"), "utf8");

  assert.ok(
    content.includes("isExternalSpectator:"),
    "play-core.js must define isExternalSpectator"
  );
  assert.ok(
    content.includes("playData?.externalSpectator === true"),
    "play-core.js must check playData.externalSpectator"
  );
  assert.ok(
    content.includes("window.__EXTERNAL_PLAY_RUN__"),
    "play-core.js must check window.__EXTERNAL_PLAY_RUN__"
  );
  assert.ok(
    content.includes('pathname.startsWith("/external-play")'),
    "play-core.js must check /external-play route"
  );
  assert.match(
    content,
    /if\s*\(\s*updateUrl\s*&&\s*app\.currentLevelId\s*&&\s*!app\.isExternalSpectator\s*\)/,
    "applyLevelState must guard window.history.replaceState with !app.isExternalSpectator"
  );
});

test("play.js guards switchPlayWorldLevel URL update and catch redirect for spectator", () => {
  const content = fs.readFileSync(path.join(rootDir, "public", "play.js"), "utf8");

  assert.match(
    content,
    /const shouldUpdateUrl =\s*options\.updateUrl !== undefined \? Boolean\(options\.updateUrl\) : !app\.isExternalSpectator;/,
    "switchPlayWorldLevel must compute shouldUpdateUrl honoring !app.isExternalSpectator"
  );

  assert.match(
    content,
    /if\s*\(\s*app\.isExternalSpectator\s*\)\s*\{\s*console\.error\(/,
    "switchPlayWorldLevel catch block must guard against location.assign in spectator mode"
  );

  assert.match(
    content,
    /Boolean\(app\.isExternalSpectator\s*\|\|\s*window\.__EXTERNAL_PLAY_RUN__\)/,
    "syncPlayOverlayInputLock must preserve __MAZEBENCH_INPUT_LOCKED__ during spectator room transitions"
  );
});

test("external-play-host.js explicitly sets updateUrl: false on room transitions", () => {
  const content = fs.readFileSync(path.join(rootDir, "public", "external-play-host.js"), "utf8");

  assert.match(
    content,
    /await app\.switchPlayWorldLevel\(targetRoom,\s*\{\s*immediate:\s*true,\s*updateUrl:\s*false\s*\}\);/,
    "SpectatorHost authoritative room transition must pass updateUrl: false"
  );

  assert.match(
    content,
    /await app\.switchPlayWorldLevel\(targetRoom,\s*\{\s*updateUrl:\s*false\s*\}\);/,
    "SpectatorHost goto_level action must pass updateUrl: false"
  );
});
