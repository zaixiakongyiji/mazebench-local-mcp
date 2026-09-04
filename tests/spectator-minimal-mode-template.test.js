const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPageRenderer } = require("../server/pages");

test("renderExternalPlayRunPage outputs minimal mode button template with required attributes", () => {
  const { renderExternalPlayRunPage } = createPageRenderer({
    getGame: () => ({ id: "maze" }),
    getLevel: () => ({ id: "level_HxI" }),
    getLevelState: () => ({ width: 10, height: 10 }),
    worldMaps: { defaultLevelIdForGame: () => "level_HxI" }
  });

  const html = renderExternalPlayRunPage({
    runId: "ext-test-123",
    status: "running",
    startedAt: "2026-09-03T10:00:00.000Z",
    maxActions: 256
  });

  assert.ok(html.includes('id="playback-minimal-btn"'), 'must include id="playback-minimal-btn"');
  assert.ok(html.includes('data-i18n="minimal_mode_btn"'), 'must include data-i18n="minimal_mode_btn"');
  assert.ok(html.includes('playback-btn--toggle'), 'must include playback-btn--toggle class');
  assert.ok(html.includes('aria-pressed="false"'), 'must include aria-pressed="false"');
  assert.ok(
    html.includes('>✨ Minimal Mode</button>'),
    'must include English SSR fallback with emoji "✨ Minimal Mode"'
  );

  // Verify button is inside playback-controls-right
  const controlsRightMatch = html.match(/<div class="playback-controls-right">([\s\S]*?)<\/div>/);
  assert.ok(controlsRightMatch, "Should have playback-controls-right container");
  assert.ok(
    controlsRightMatch[1].includes('id="playback-minimal-btn"'),
    "playback-minimal-btn must be inside playback-controls-right"
  );
});

test("i18n dictionaries include minimal_mode_btn translation for both zh and en with emoji", () => {
  const rootI18nPath = path.resolve(__dirname, "../public/i18n.js");
  const envI18nPath = path.resolve(__dirname, "../environments/mazebench/mazebench/runtime/public/i18n.js");

  for (const filePath of [rootI18nPath, envI18nPath]) {
    assert.ok(fs.existsSync(filePath), `i18n file must exist at ${filePath}`);
    const content = fs.readFileSync(filePath, "utf8");
    assert.match(
      content,
      /minimal_mode_btn:\s*["']✨ 极简模式["']/,
      `${filePath} must define minimal_mode_btn with emoji in zh`
    );
    assert.match(
      content,
      /minimal_mode_btn:\s*["']✨ Minimal Mode["']/,
      `${filePath} must define minimal_mode_btn with emoji in en`
    );
  }
});

test("external-play.css defines .playback-btn--toggle styles for normal, active, and hover states", () => {
  const rootCssPath = path.resolve(__dirname, "../public/external-play.css");
  const envCssPath = path.resolve(__dirname, "../environments/mazebench/mazebench/runtime/public/external-play.css");

  const rootCss = fs.readFileSync(rootCssPath, "utf8");
  const envCss = fs.readFileSync(envCssPath, "utf8");

  assert.equal(rootCss, envCss, "Both external-play.css files must remain strictly synchronized");

  for (const css of [rootCss, envCss]) {
    assert.match(css, /\.playback-btn--toggle\s*\{[^}]*transition:[^}]*\}/s, "must define transitions");
    assert.match(css, /\.playback-btn--toggle\.is-active/);
    assert.match(css, /\.playback-btn--toggle\[aria-pressed="true"\]/);
    assert.match(css, /rgba\(56,\s*189,\s*248,\s*0\.55\)/, "must use highlighted border");
    assert.match(css, /#38bdf8/, "must use accent text color");
    assert.match(css, /rgba\(56,\s*189,\s*248,\s*0\.25\)/, "must use subtle glow box-shadow");
    assert.match(css, /rgba\(56,\s*189,\s*248,\s*0\.18\)/, "must use subtle tinted background");
    assert.match(css, /\.playback-btn--toggle\.is-active:hover/, "must define active hover state");
  }
});
