const { escapeHtml, serializeForScript } = require("./support");
const { accountActionsHtml, pageHead, siteFooter, topbar } = require("./page-chrome");
const { asciiGlyphPalette } = require("../shared/maze-ascii-palette");

// Gamepad 2, Blocks, and Bot from Lucide Icons (ISC License).
// https://lucide.dev/
const HOME_MODE_ICONS = Object.freeze({
  play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><line x1="6" x2="10" y1="11" y2="11"></line><line x1="8" x2="8" y1="9" y2="13"></line><line x1="15" x2="15.01" y1="12" y2="12"></line><line x1="18" x2="18.01" y1="10" y2="10"></line><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"></path></svg>`,
  build: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><line x1="6" x2="10" y1="11" y2="11"></line><line x1="8" x2="8" y1="9" y2="13"></line><line x1="15" x2="15.01" y1="12" y2="12"></line><line x1="18" x2="18.01" y1="10" y2="10"></line><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"></path></svg>`,
  agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>`
});

// Trash 2 from Lucide Icons (ISC License).
// https://lucide.dev/icons/trash-2
const TRASH_ICON = `<svg class="trash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

// Folder Closed from Lucide Icons (ISC License).
const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path><path d="M2 10h20"></path></svg>`;
// Download from Lucide Icons (ISC License).
// https://lucide.dev/
const VIDEO_ICONS = Object.freeze({
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"></path><path d="m7 10 5 5 5-5"></path><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path></svg>`
});
const PLAY_ASSET_VERSION = "20260714-play-hud-stats-2";

const RUN_METRIC_ICONS = Object.freeze({
  gems: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12l4 6-10 12L2 9Z"></path><path d="m11 3-3 6 4 12 4-12-3-6"></path><path d="M2 9h20"></path></svg>`,
  rooms: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"></path><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"></path><path d="M10 9h4"></path><path d="M10 13h4"></path><path d="M10 17h4"></path></svg>`
});

// Map from Lucide Icons (ISC License). Shared with the play-page world map.
const MAP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.5 6.5 9 4l6 3 4.5-2.5v13L15 20l-6-3-4.5 2.5v-13Z"></path><path d="M9 4v13"></path><path d="M15 7v13"></path></svg>`;

// Gem and Door Open from Lucide Icons (ISC License). Shared by the compact
// play HUD in MazeBench and its hosted MazeJam shell.
const PLAY_HUD_ICONS = Object.freeze({
  gems: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"></path><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"></path><path d="M2 9h20"></path></svg>`,
  rooms: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11 20H2"></path><path d="M11 4.562v16.157a1 1 0 0 0 1.242.97L19 20V5.562a2 2 0 0 0-1.515-1.94l-4-1A2 2 0 0 0 11 4.561z"></path><path d="M11 4H8a2 2 0 0 0-2 2v14"></path><path d="M14 12h.01"></path><path d="M22 20h-3"></path></svg>`
});

// Page renderers. Shared chrome and the complete world-editor frontend are
// canonical in this repo; Maze Jam consumes them during its build:
//   - site pages load /site.css + /build-theme.css + /local-site.css
//   - the play/flyover pages load the game runtime /styles.css first, then
//     /site.css and /play-theme.css (MazeJam's play page layer)
//   - the author/world-map editors load /styles.css as a structural base and
//     the canonical /author-theme.css on top
function createPageRenderer({
  agentEnvironment,
  buildAuthorPageData,
  buildMazeWorldMapEditorData,
  buildWorlds,
  capabilities = { external_play: true, local_mcp: true, prime_integration: false },
  getGame,
  getLevel,
  getLevelState,
  listGames,
  remote,
  worldMaps
}) {
  const defaultLevelIdForGame = (game) => worldMaps.defaultLevelIdForGame(game);

  function remoteStatusSafe() {
    try {
      return remote.getStatus();
    } catch (error) {
      return { connected: false };
    }
  }

  const RUNTIME_SCRIPTS = `<script src="/play-rules.js" defer></script>
          <script src="/play-core.js" defer></script>
          <script src="/play-render-effects.js" defer></script>
          <script src="/play-render-terrain.js" defer></script>
          <script src="/play-render-actors.js" defer></script>
          <script src="/play-render-three.js" defer></script>
          <script src="/play-render-compositor.js" defer></script>
          <script src="/play-render.js" defer></script>
          <script src="/maze-engine.js" defer></script>`;

  function renderSitePage({ title, description = "", main, bodyClass = "", extraHeadHtml = "", extraScripts = "" }) {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    ${pageHead({
      title,
      description,
      extraHeadHtml: `<link rel="stylesheet" href="/build-theme.css?v=20260719-build-card-gems-1">
    <link rel="stylesheet" href="/local-site.css?v=20260722-json-grid-1">
    ${extraHeadHtml}`
    })}
  </head>
  <body class="${escapeHtml(bodyClass)}">
    ${topbar({ rightHtml: accountActionsHtml(remoteStatusSafe()) })}
    <main class="page-shell">
      ${main}
    </main>
    ${siteFooter()}
    ${extraScripts}
  </body>
</html>`;
  }

  function worldCardMosaic(game) {
    const levels = game?.worldMap?.levels || [];
    const previews = new Map(
      levels.filter((level) => level.previewUrl).map((level) => [level.id, level.previewUrl])
    );

    if (!previews.size) {
      return `<div class="screen-nosignal"><span class="glyph">◇</span><span>No signal</span></div>`;
    }

    const columns = Math.max(1, ...levels.map((level) => Number(level.column) + 1 || 1));
    const rows = Math.max(1, ...levels.map((level) => Number(level.row) + 1 || 1));

    if (columns > 5 || rows > 5) {
      const firstUrl = previews.get(defaultLevelIdForGame(game)) || previews.values().next().value;
      return `<div class="screen-mosaic" style="grid-template-columns:1fr;aspect-ratio:1/1;height:84%"><img class="mosaic-cell" src="${escapeHtml(firstUrl)}" alt="" loading="lazy" decoding="async"></div>`;
    }

    const cells = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const levelId = `level_${String.fromCharCode(65 + column)}x${String.fromCharCode(65 + row)}`;
        const previewUrl = previews.get(levelId);
        cells.push(
          previewUrl
            ? `<img class="mosaic-cell" src="${escapeHtml(previewUrl)}" alt="" loading="lazy" decoding="async">`
            : '<div class="mosaic-cell"></div>'
        );
      }
    }

    const fitStyle = columns / rows >= 1.6 ? "width:86%" : "height:84%";
    return `<div class="screen-mosaic" style="grid-template-columns:repeat(${columns},1fr);grid-template-rows:repeat(${rows},1fr);aspect-ratio:${columns}/${rows};${fitStyle}">${cells.join("")}</div>`;
  }

  function worldCard({ game, title, subtitle, badges = [], tags = [], stats = [], actions = [], playUrl, gemCount = null }) {
    const badgeHtml = badges
      .map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`)
      .join("");
    const tagHtml = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    const statsHtml = stats
      .map(([value, label]) => `<span><b>${escapeHtml(value)}</b> ${escapeHtml(label)}</span>`)
      .join("");
    const actionsHtml = actions
      .filter(([, href]) => Boolean(href))
      .map(([label, href, extraClass]) =>
        `<a class="button${extraClass ? ` ${extraClass}` : ""}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
      )
      .join("");
    const gemNumber = Number(gemCount);
    const gemTotal = gemCount !== null && gemCount !== undefined && Number.isFinite(gemNumber)
      ? Math.max(0, Math.trunc(gemNumber))
      : null;
    const gemLabel = gemTotal === null ? "" : `${gemTotal} ${gemTotal === 1 ? "gem" : "gems"}`;
    const gemHtml = gemTotal === null
      ? ""
      : `<span class="screen-gems" title="${gemLabel}" aria-label="${gemLabel}">${PLAY_HUD_ICONS.gems}<span>${gemTotal}</span></span>`;

    return `<div class="world-card">
        <a class="card-screen" href="${escapeHtml(playUrl)}" aria-label="Play ${escapeHtml(title)}">
          ${worldCardMosaic(game)}
          <div class="screen-fx"></div>
          ${gemHtml}
          <div class="screen-badges">${badgeHtml}</div>
          <div class="screen-play">PLAY</div>
        </a>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(title)}</h3>
          ${subtitle ? `<p class="card-by">${escapeHtml(subtitle)}</p>` : ""}
          ${statsHtml ? `<div class="card-stats">${statsHtml}</div>` : ""}
          ${tagHtml ? `<div class="tags">${tagHtml}</div>` : ""}
          ${actionsHtml ? `<div class="card-actions">${actionsHtml}</div>` : ""}
        </div>
      </div>`;
  }

  function renderHomePage() {
    const otherGames = listGames().filter((game) => !game.worldMap);
    const otherGamesSection = otherGames.length
      ? `<section class="panel">
          <h2>Other Games</h2>
          <div class="card-actions">${otherGames
            .map(
              (game) =>
                `<a class="button" href="/games/${encodeURIComponent(game.id)}">${escapeHtml(game.name)}</a>`
            )
            .join("")}</div>
        </section>`
      : "";

    const modeCard = (href, mode, titleKey, title, copyKey, copy) => `<a class="world-card mode-card-link mode-card-link--${mode}" href="${href}">
        <div class="card-body">
          <span class="mode-card-icon" aria-hidden="true">${HOME_MODE_ICONS[mode]}</span>
          <div class="mode-card-copy">
            <h3 class="card-title" data-i18n="${titleKey}">${title}</h3>
            <p class="card-by" data-i18n="${copyKey}">${copy}</p>
          </div>
        </div>
      </a>`;

    return renderSitePage({
      title: "Maze Bench",
      main: `<div class="world-grid home-mode-grid">
          ${modeCard("/build", "build", "home_build_title", "Build and Play", "home_build_copy", "Create, edit, and play the official Maze Bench environment or your local drafts.")}
          ${modeCard("/external-play", "play", "home_external_title", "External Play (Local MCP)", "home_external_copy", "Connect Codex, Claude Desktop, or local MCP to play and watch live in 3D (Unverified).")}
          ${modeCard("/agent", "agent", "home_agent_title", "Agent", "home_agent_copy", "Run a model through isolated, named game controls and watch live.")}
        </div>
        ${otherGamesSection}`
    });
  }

  function renderGamePage(game) {
    const startLevelId = defaultLevelIdForGame(game);
    const links = [
      startLevelId ? ["Play", `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}`] : null,
      game.worldMap && startLevelId
        ? ["Edit Levels", `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}`]
        : null,
      game.worldMap ? ["World Map", `/world-map/${encodeURIComponent(game.id)}`] : null
    ].filter(Boolean);
    const levelsSection = game.worldMap
      ? ""
      : `<section class="panel">
          <h2>Levels</h2>
          <ul>${game.levels
            .map(
              (level) => `<li><a class="text-link" href="${escapeHtml(level.playUrl)}">${escapeHtml(level.label)}</a></li>`
            )
            .join("")}</ul>
        </section>`;

    return renderSitePage({
      title: `${game.name} — Maze Bench`,
      main: `<div class="page-head">
          <h1>${escapeHtml(game.name)}</h1>
        </div>
        <section class="panel">
          <div class="card-actions">${links
            .map(([label, href]) => `<a class="button" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
            .join("")}</div>
        </section>
        ${levelsSection}`
    });
  }

  function playChromeHead(title) {
    return `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="theme-color" content="#070811">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/site.css">
    <link rel="stylesheet" href="/play-theme.css?v=${PLAY_ASSET_VERSION}">
    <link rel="stylesheet" href="/local-site.css?v=20260722-json-grid-1">`;
  }

  function renderPlayPage(game, level) {
    const levelState = getLevelState(game, level);
    const authorData = game.worldMap ? buildAuthorPageData(game, level) : null;
    const playWorldData = authorData
      ? {
          blockAdder: authorData.blockAdder,
          defaultFloorToken: authorData.defaultFloorToken,
          existingLevels: authorData.existingLevels,
          game: authorData.game,
          palette: authorData.palette,
          toolboxCatalog: authorData.toolboxCatalog,
          playApiBaseUrl: `/api/play/${encodeURIComponent(game.id)}`,
          worldColumns: authorData.worldColumns,
          worldRows: authorData.worldRows
        }
      : null;
    const hasBoard = levelState.width > 0 && levelState.height > 0;
    const boardMarkup = hasBoard
      ? `<main id="game-root" class="is-fullbleed is-loading">
        <div class="play-shell">
          <div class="play-header" aria-hidden="true"></div>
          <div class="mazebench-runtime-toggles" aria-hidden="true">
            <button id="fuzzy-toggle" type="button" aria-pressed="true"></button>
            <button id="edge-toggle" type="button" aria-pressed="true"></button>
          </div>
          <section class="play-stage" aria-label="${escapeHtml(game.name)} board">
            <div class="maze-frame is-loading">
              <canvas
                id="maze-canvas"
                class="maze-canvas"
                width="${levelState.width * 64}"
                height="${levelState.height * 64}"
                aria-label="${escapeHtml(game.name)} board"
              ></canvas>
              <div class="maze-load-art" aria-hidden="true"><span class="maze-load-label">Loading</span><span class="maze-load-progress"><span></span></span></div>
            </div>
          </section>
          <nav class="mazebench-controls" aria-label="Game controls">
            <div class="top-play-controls">
              <div class="top-play-actions">
                ${authorData ? '<button class="control-button play-icon-button world-map-button" type="button" data-action="world-map" aria-controls="world-map-overlay" aria-expanded="false" aria-label="World map" title="World map"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 6.5 9 4l6 3 4.5-2.5v13L15 20l-6-3-4.5 2.5v-13Z"></path><path d="M9 4v13"></path><path d="M15 7v13"></path></svg></button>' : ""}
                <a class="control-button" data-play-author-link href="/author/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}">Edit</a>
              </div>
              <div id="play-hud" class="play-hud" aria-live="polite">
                <span id="play-hud-rooms" class="play-hud-stat play-hud-stat--rooms" aria-label="1 room visited">${PLAY_HUD_ICONS.rooms}<strong data-play-hud-value>1</strong></span>
                <span id="play-hud-gems" class="play-hud-stat play-hud-stat--gems" aria-label="0 gems collected">${PLAY_HUD_ICONS.gems}<strong data-play-hud-value>0</strong></span>
              </div>
              <div class="top-play-right">
                <div class="top-play-actions">
                  <button class="control-button" type="button" data-action="undo" aria-label="Undo last action">Undo</button>
                  <button class="control-button" type="button" data-action="reset" aria-label="Reset level">Reset</button>
                  <button class="control-button play-icon-button" type="button" data-action="controls" aria-label="Controls settings" title="Controls"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h9"></path><circle cx="16" cy="7" r="2.5"></circle><path d="M18.5 7H20"></path><path d="M4 17h2.5"></path><circle cx="9.5" cy="17" r="2.5"></circle><path d="M12 17h8"></path></svg></button>
                </div>
              </div>
            </div>
            <div class="control-pad" data-quadrant-pad="move" aria-label="Move controls">
              <button class="control-button dpad-button" type="button" data-move="up" aria-label="Move up" tabindex="-1"></button>
              <button class="control-button dpad-button" type="button" data-move="left" aria-label="Move left" tabindex="-1"></button>
              <span class="dpad-center" aria-hidden="true">MOVE</span>
              <button class="control-button dpad-button" type="button" data-move="right" aria-label="Move right" tabindex="-1"></button>
              <button class="control-button dpad-button" type="button" data-move="down" aria-label="Move down" tabindex="-1"></button>
            </div>
            <div class="camera-pad control-pad" data-quadrant-pad="camera" aria-label="Camera controls">
              <button class="control-button dpad-button" type="button" data-camera="up" aria-label="Camera up" tabindex="-1"></button>
              <button class="control-button dpad-button" type="button" data-camera="left" aria-label="Rotate camera left" tabindex="-1"></button>
              <span class="dpad-center" aria-hidden="true">CAM</span>
              <button class="control-button dpad-button" type="button" data-camera="right" aria-label="Rotate camera right" tabindex="-1"></button>
              <button class="control-button dpad-button" type="button" data-camera="down" aria-label="Camera down" tabindex="-1"></button>
            </div>
          </nav>
          ${authorData ? `<section id="world-map-overlay" class="world-map-overlay" aria-label="World map" hidden>
            <div class="world-map-panel">
              <div class="world-map-bar">
                <div class="world-map-title-box"><h2 class="world-map-title">World Map</h2></div>
                <button class="control-button world-map-close-button" type="button" data-world-map-close aria-label="Close world map" title="Close"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 7 10 10"></path><path d="m17 7-10 10"></path></svg></button>
              </div>
              <div class="world-map-stage">
                <svg id="world-map-backdrop" class="world-map-backdrop" aria-hidden="true"></svg>
                <div id="world-map-grid" class="world-map-grid"></div>
              </div>
            </div>
          </section>` : ""}
          <section id="controls-settings-overlay" class="world-map-overlay controls-overlay" aria-label="Controls settings" hidden>
            <div class="controls-panel">
              <div class="controls-panel-bar">
                <h2 class="world-map-title">Controls</h2>
                <button class="control-button" type="button" data-controls-close>Close</button>
              </div>
              <section class="controls-section" aria-label="Keyboard controls">
                <h3>Keyboard</h3>
                <p class="controls-note">Arrow keys move · A / D rotate · W / S tilt · Z or U undo · R reset</p>
              </section>
              <section class="controls-section" aria-label="Controller options">
                <h3>Controller</h3>
                <p class="controls-note">Bluetooth and USB game controllers use the same movement and camera actions.</p>
              </section>
            </div>
          </section>
        </div>
      </main>
      <script>window.__PLAY_DATA__ = ${serializeForScript(levelState)};</script>
      ${playWorldData ? `<script>window.__PLAY_WORLD_DATA__ = ${serializeForScript(playWorldData)};</script><script src="/maze-token-patterns.js" defer></script><script src="/author-play-data.js" defer></script>` : ""}
      ${RUNTIME_SCRIPTS}
      <script src="/play-movement.js" defer></script>
      <script src="/play-world-transitions.js" defer></script>
      <script src="/play-gameplay.js" defer></script>
      <script src="/world-solver.js" defer></script>
      <script src="/play.js?v=${PLAY_ASSET_VERSION}" defer></script>`
      : `<main class="page-shell"><section class="panel"><p>This level is empty.</p></section></main>`;

    return `<!DOCTYPE html>
<html lang="en" class="play-mode">
  <head>
    ${playChromeHead(`${game.name} ${level.label} — Maze Bench`)}
  </head>
  <body class="play-body play-mode">
    ${topbar({ rightHtml: accountActionsHtml(remoteStatusSafe()) })}
    ${boardMarkup}
  </body>
</html>`;
  }

  function renderFlyoverPage(game, level) {
    const levelState = {
      ...getLevelState(game, level),
      flyover: true,
      flyoverRadius: 3
    };
    const hasBoard = levelState.width > 0 && levelState.height > 0;
    const boardMarkup = hasBoard
      ? `<main id="game-root" class="is-fullbleed is-loading">
        <div class="play-shell flyover-shell">
          <section class="play-stage flyover-stage" aria-label="${escapeHtml(game.name)} flyover">
            <div class="maze-frame flyover-frame is-loading">
              <canvas
                id="maze-canvas"
                class="maze-canvas"
                width="${levelState.width * 64}"
                height="${levelState.height * 64}"
                aria-label="${escapeHtml(game.name)} flyover"
              ></canvas>
              <div class="flyover-loading" role="status" aria-live="polite">
                <span class="flyover-loading__spinner" aria-hidden="true"></span>
                <span class="flyover-loading__label">Loading world</span>
              </div>
            </div>
            <div class="flyover-hud"></div>
            <nav class="mazebench-controls flyover-controls" aria-label="Flyover controls">
              <div class="camera-pad control-pad flyover-pad flyover-pad--camera" aria-label="Camera controls">
                <button id="flyover-tilt-up" class="control-button dpad-button flyover-pad-button" type="button" data-camera="up" aria-label="Tilt camera up"></button>
                <button id="flyover-rotate-left" class="control-button dpad-button flyover-pad-button" type="button" data-camera="left" aria-label="Rotate camera left"></button>
                <span class="dpad-center flyover-pad-center" aria-hidden="true">CAM</span>
                <button id="flyover-rotate-right" class="control-button dpad-button flyover-pad-button" type="button" data-camera="right" aria-label="Rotate camera right"></button>
                <button id="flyover-tilt-down" class="control-button dpad-button flyover-pad-button" type="button" data-camera="down" aria-label="Tilt camera down"></button>
              </div>
              <div class="flyover-zoom-controls" aria-label="Zoom controls">
                <button id="flyover-zoom-out" class="control-button play-icon-button flyover-zoom-button" type="button" aria-label="Zoom out" title="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="8"></circle><line x1="21" x2="16.65" y1="21" y2="16.65"></line><line x1="8" x2="14" y1="11" y2="11"></line></svg></button>
                <button id="flyover-edge-toggle" class="control-button play-icon-button flyover-edge-toggle" type="button" aria-label="Blue glow and fuzzy overlay" aria-pressed="false" title="Blue glow and fuzzy overlay"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><path d="M7 12h10"></path></svg></button>
                <button id="flyover-title-toggle" class="control-button play-icon-button flyover-title-toggle" type="button" aria-label="Show Maze Bench title" aria-pressed="false" title="Show Maze Bench title"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 6h14"></path><path d="M12 6v12"></path><path d="M8 18h8"></path></svg></button>
                <button id="flyover-zoom-in" class="control-button play-icon-button flyover-zoom-button" type="button" aria-label="Zoom in" title="Zoom in"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="8"></circle><line x1="21" x2="16.65" y1="21" y2="16.65"></line><line x1="11" x2="11" y1="8" y2="14"></line><line x1="8" x2="14" y1="11" y2="11"></line></svg></button>
              </div>
              <div class="control-pad flyover-pad flyover-pad--move" aria-label="Movement controls">
                <button id="flyover-move-forward" class="control-button dpad-button flyover-pad-button" type="button" data-move="up" aria-label="Fly forward"></button>
                <button id="flyover-move-left" class="control-button dpad-button flyover-pad-button" type="button" data-move="left" aria-label="Fly left"></button>
                <span class="dpad-center flyover-pad-center" aria-hidden="true">MOVE</span>
                <button id="flyover-move-right" class="control-button dpad-button flyover-pad-button" type="button" data-move="right" aria-label="Fly right"></button>
                <button id="flyover-move-backward" class="control-button dpad-button flyover-pad-button" type="button" data-move="down" aria-label="Fly backward"></button>
              </div>
            </nav>
            <div id="flyover-social-title" class="flyover-social-title" aria-hidden="true" hidden>
              <h1>MAZE BENCH</h1>
            </div>
          </section>
        </div>
      </main>
      <script>window.__PLAY_DATA__ = ${serializeForScript(levelState)};</script>
      ${RUNTIME_SCRIPTS}
      <script src="/flyover.js" defer></script>`
      : `<main class="page-shell"><section class="panel"><p>This level is empty.</p></section></main>`;

    return `<!DOCTYPE html>
<html lang="en" class="play-mode">
  <head>
    ${playChromeHead(`${game.name} Flyover — Maze Bench`)}
  </head>
  <body class="play-body play-mode flyover-body">
    ${topbar({ rightHtml: accountActionsHtml(remoteStatusSafe()) })}
    ${boardMarkup}
  </body>
</html>`;
  }

  function editorChromeHead(
    title,
    { includeLocalSite = true, includeRuntimeStyles = true } = {}
  ) {
    return `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="theme-color" content="#070811">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
    ${includeRuntimeStyles ? '<link rel="stylesheet" href="/styles.css">' : ""}
    <link rel="stylesheet" href="/site.css">
    <link rel="stylesheet" href="/author-theme.css">
    ${includeLocalSite ? '<link rel="stylesheet" href="/local-site.css?v=20260722-json-grid-1">' : ""}`;
  }

  function renderAuthorPage(game, level) {
    const authorData = buildAuthorPageData(game, level);
    const localWorld = buildWorlds.isLocalWorldGameId(game.id)
      ? buildWorlds.describeLocalWorld(game.id)
      : null;
    const playUrl = `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}`;

    if (localWorld) {
      const gemsByLevel = {};
      (authorData.existingLevels || []).forEach((entry) => {
        let count = 0;
        (entry.cells || []).forEach((row) => {
          (row || []).forEach((cell) => {
            String(cell || "")
              .split("+")
              .forEach((token) => {
                if (token.trim() === "G") count += 1;
              });
          });
        });
        gemsByLevel[entry.id] = count;
      });
      authorData.worldMeta = {
        apiUrl: `/api/build/worlds/${encodeURIComponent(game.id)}`,
        gemsByLevel,
        height: localWorld.world_height,
        reviewStatus: "local",
        startLevelId: localWorld.default_level_id,
        status: "draft",
        title: localWorld.title,
        updatedAt: localWorld.updated_at,
        width: localWorld.world_width
      };
    }

    const shellConfig = {
      capabilities: {
        publish: false,
        worldDetails: Boolean(authorData.worldMeta)
      },
      mobileNavigation: [
        { href: playUrl, label: "Play", roomPlayLink: true },
        { href: "/build", label: "Back to Build" }
      ],
      navigation: [
        { href: "/build", label: "Build" },
        { href: playUrl, label: "Play", roomPlayLink: true, testLink: true }
      ],
      title: game.name
    };

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    ${editorChromeHead(`${game.name} — Maze Bench Editor`, {
      includeLocalSite: false,
      includeRuntimeStyles: false
    })}
  </head>
  <body class="author-body">
    <div id="author-shell-root"></div>
    <script>
      window.__AUTHOR_DATA__ = ${serializeForScript(authorData)};
      window.__AUTHOR_SHELL__ = ${serializeForScript(shellConfig)};
    </script>
    <script src="/author-shell.js" defer></script>
    ${RUNTIME_SCRIPTS}
    <script src="/play-movement.js" defer></script>
    <script src="/play-world-transitions.js" defer></script>
    <script src="/play-gameplay.js" defer></script>
    <script src="/level-preview.js" defer></script>
    <script src="/maze-token-patterns.js" defer></script><script src="/author-play-data.js" defer></script>
    <script src="/maze-solver.js" defer></script>
    <script src="/author.js" defer></script>
  </body>
</html>`;
  }

  function renderWorldMapEditorPage(game) {
    const worldMapData = buildMazeWorldMapEditorData(game);

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    ${editorChromeHead(`${game.name} World Map — Maze Bench`)}
  </head>
  <body class="author-body world-map-body">
    <main class="world-map-shell">
      <header class="author-header">
        <div class="author-topbar world-map-topbar">
          <h1>World Map</h1>
          <nav class="page-nav author-nav" aria-label="World map navigation">
            <a class="back-link" href="/build">Build</a>
            <a class="back-link" href="/play/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}">Play</a>
          </nav>
          <a id="world-map-play-link" class="back-link world-map-slot-link is-disabled" href="#" aria-disabled="true">Play Slot</a>
          <a id="world-map-author-link" class="back-link world-map-slot-link is-disabled" href="#" aria-disabled="true">Edit Slot</a>
          <button id="world-map-save" class="tool-button tool-button--primary" type="button">Save</button>
          <button id="world-map-deselect" class="tool-button" type="button">Deselect</button>
          <p id="world-map-status" class="sr-only" role="status" aria-live="polite"></p>
        </div>
      </header>
      <div class="world-map-layout">
        <aside class="author-sidebar world-map-sidebar">
          <details class="author-panel author-disclosure world-map-unmapped-panel">
            <summary class="author-disclosure__summary">
              <span>Unmapped Tiles</span>
            </summary>
            <div class="author-disclosure__body">
              <div id="world-map-unplaced" class="world-map-list"></div>
            </div>
          </details>
        </aside>
        <section class="world-map-workspace">
          <section class="author-grid-shell world-map-grid-shell">
            <div class="world-map-canvas">
              <div id="world-map-grid" class="world-map-grid" aria-label="World map grid"></div>
            </div>
          </section>
        </section>
      </div>
      <script>window.__WORLD_MAP_EDITOR_DATA__ = ${serializeForScript(worldMapData)};</script>
      <script src="/world-map.js" defer></script>
    </main>
  </body>
</html>`;
  }

  function renderBuildPage() {
    const buildData = {
      apiUrl: "/api/build/worlds",
      worlds: buildWorlds.listLocalWorlds(),
      remote: remoteStatusSafe()
    };

    const masterGame = getGame("maze");
    const masterSection = masterGame
      ? `<section class="panel" aria-label="Maze Bench Environment v0.7">
          <h2>Maze Bench Environment v0.7</h2>
          <p class="muted" style="margin-top: -4px">The master benchmark world. Edits here change the world agents are scored on.</p>
          <div class="world-grid">${worldCard({
            game: masterGame,
            title: "Maze Bench Environment v0.7",
            subtitle: "The world agents are benchmarked on",
            badges: ["ENVIRONMENT"],
            gemCount: buildWorlds.countWorldGems(masterGame),
            stats: [[String(masterGame.worldMap?.levels?.length || 0), "levels"]],
            playUrl: `/play/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`,
            actions: [
              ["Edit", `/author/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`],
              ["Play", `/play/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`],
              ["Flyover", `/flyover/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`]
            ]
          })}</div>
        </section>`
      : "";

    return renderSitePage({
      title: "Build and Play — Maze Bench",
      main: `<div class="page-head">
          <h1 data-i18n="nav_build">Build and Play</h1>
          <p class="page-sub" data-i18n="home_build_copy">Worlds live in this repo under <span class="mono">games/</span> and never publish anywhere unless you push them.</p>
          <p id="build-status" class="author-status" role="status" aria-live="polite"></p>
        </div>
        ${masterSection}
        <section class="panel" aria-label="My worlds">
          <h2 data-i18n="my_worlds_title">My Worlds</h2>
          <div id="build-worlds" class="world-grid"></div>
        </section>
        <section class="panel build-import-panel" aria-label="Bring in a world">
          <h2 data-i18n="bring_world_title">Bring In A World</h2>
          <div class="card-actions" style="margin-top: 12px">
            <button id="copy-master" type="button" data-i18n="btn_duplicate_master">Duplicate Maze Bench Environment</button>
            <button id="import-world" type="button" data-i18n="btn_import_json">Import World JSON</button>
            <input id="import-world-file" type="file" accept="application/json,.json" hidden>
          </div>
          <div class="online-pull" style="margin-top: 14px">
            <label class="field"><span>Or download a published world from ${escapeHtml(
              (remoteStatusSafe().origin || "https://mazebench.com").replace(/^https?:\/\//, "")
            )} by id to edit</span><input id="download-world-id" type="text" placeholder="mbw_…" autocomplete="off" spellcheck="false"></label>
            <button id="download-world" type="button">Download &amp; Edit</button>
          </div>
        </section>
        <div id="create-world-modal" class="build-modal create-world-modal" role="dialog" aria-modal="true" aria-labelledby="create-world-title" hidden>
          <div class="build-modal__dialog">
            <h2 id="create-world-title">New World</h2>
            <form id="create-world-form" class="form">
              <label class="field"><span>World name</span><input id="new-world-title" maxlength="80" required value="Untitled World"></label>
              <div class="form-row">
                <label class="field"><span>Width (levels)</span><input id="new-world-width" type="number" min="1" max="26" value="3" inputmode="numeric"></label>
                <label class="field"><span>Height (levels)</span><input id="new-world-height" type="number" min="1" max="26" value="3" inputmode="numeric"></label>
              </div>
              <p id="create-world-status" class="author-status" role="status" aria-live="polite"></p>
              <div class="build-modal__actions">
                <button id="cancel-create-world" type="button" class="button--quiet">Cancel</button>
                <button id="create-world" class="button--primary" type="submit">Create</button>
              </div>
            </form>
          </div>
        </div>
        <div id="delete-world-modal" class="build-modal delete-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-world-title" hidden>
          <div class="build-modal__dialog">
            <h2 id="delete-world-title">You sure you want to delete?</h2>
            <p id="delete-world-message" class="delete-confirm__message">This cannot be undone.</p>
            <div class="build-modal__actions">
              <button id="cancel-world-delete" type="button" class="button--quiet">Cancel</button>
              <button id="confirm-world-delete" type="button" class="delete-confirm__danger">Delete</button>
            </div>
          </div>
        </div>
        <script>window.__BUILD_DATA__ = ${serializeForScript(buildData)};</script>
        <script src="/build.js" defer></script>`
    });
  }

  function agentWorldOption(game) {
    const config = worldMaps.worldConfigForGame(game.id);
    const levels = (game.worldMap?.levels || []).map((level) => ({
      id: level.id,
      column: level.column,
      row: level.row,
      preview_url: level.previewUrl || null
    }));

    return {
      id: game.id,
      title: game.name,
      is_master: game.id === "maze",
      world_width: config.worldSize.width,
      world_height: config.worldSize.height,
      level_count: levels.length,
      preview_urls: levels.map((level) => level.preview_url).filter(Boolean).slice(0, 4),
      levels,
      default_level_id: defaultLevelIdForGame(game)
    };
  }

  function renderAgentPage() {
    const masterGame = getGame("maze");
    const worlds = [
      ...(masterGame ? [agentWorldOption(masterGame)] : []),
      ...buildWorlds
        .listLocalWorlds()
        .map((world) => getGame(world.id))
        .filter((game) => game && game.worldMap)
        .map(agentWorldOption)
    ];
    const agentData = {
      apiUrl: "/api/agent/runs",
      harnessesApiUrl: "/api/agent/harnesses",
      modelsApiBase: "/api/agent/models",
      worlds,
      capabilities,
      environment: agentEnvironment({ cachedOnly: true }),
      remote: remoteStatusSafe()
    };

    return renderSitePage({
      title: "Agent — Maze Bench",
      extraHeadHtml: capabilities.prime_integration ? `<link rel="preload" as="image" href="/logos/prime.png" type="image/png" fetchpriority="high">` : "",
      main: `<div class="page-head agent-page-head" style="display: none;">
          <h1 data-i18n="agent_title">Agent</h1>
          <p id="agent-status" class="author-status" role="status" aria-live="polite"></p>
          <div id="agent-launch-status" class="agent-launch-status" role="status" aria-live="polite" aria-atomic="true" hidden>
            <span class="agent-launch-status__spinner" aria-hidden="true"></span>
            <span>Launching run</span>
          </div>
        </div>
        <section class="panel agent-composer" aria-label="Launch a run" hidden style="display: none;">
          <div class="composer-head">
            <h2 data-i18n="agent_new_run">New run</h2>
          </div>

          <section class="composer-section composer-section--agent">
            <div class="composer-section-title">
              <span class="composer-step">01</span>
              <div><h3 data-i18n="agent_step_harness">Harness</h3><p id="execution-note" class="muted" data-i18n="agent_harness_note">Choose a harness. Prime supplies inference by default.</p></div>
            </div>
            <div id="provider-picker" class="provider-grid" role="radiogroup" aria-label="Agent harness"></div>
            <div id="custom-harness-panel" class="custom-harness-panel" hidden>
              <div class="custom-harness-panel__fields">
                <label class="field">
                  <span>Prime harness</span>
                  <select id="custom-harness-id" aria-describedby="custom-harness-note"></select>
                </label>
                <div id="custom-harness-config-fields" class="custom-harness-config-fields"></div>
              </div>
              <div class="custom-harness-panel__status">
                <strong id="custom-harness-status">Loading harnesses…</strong>
                <p id="custom-harness-note" class="muted"></p>
                <p class="custom-harness-panel__security">The official Prime Agent CLI runs inside a disposable agent sandbox. The framework harness receives only named game controls through standard MCP wiring; the evaluator-owned Toolset keeps game source, state, checkpoints, and scoring outside that sandbox.</p>
              </div>
            </div>
            <div id="harness-execution" class="harness-execution" hidden>
              <span class="harness-execution__label" data-i18n="agent_run_through">Run through</span>
              <div id="execution-picker" class="execution-picker" role="radiogroup" aria-label="Execution provider">
                <button type="button" class="execution-option is-selected" data-execution="prime" aria-pressed="true">
                  <span class="execution-option__logo"><img src="/logos/prime.png" alt="" width="128" height="128"></span>
                  <span class="execution-option__copy"><strong>Prime inference</strong><small>Prime models · isolated agent</small></span>
                </button>
                <button type="button" class="execution-option" data-execution="local" aria-pressed="false">
                  <span class="execution-option__logo execution-option__logo--local" aria-hidden="true">LOCAL</span>
                  <span class="execution-option__copy"><strong>Local isolated</strong><small>Docker · game + optional Python</small></span>
                  <span id="local-run-status" class="execution-option__status is-idle" hidden></span>
                </button>
              </div>
              <p class="custom-harness-panel__security">Each available route keeps MazeBench source, hidden state, scoring, shell, files, web, apps, and workers away from the evaluated model. Local runs fail closed unless the disposable boundary passes its launch-time isolation check.</p>
            </div>
          </section>

          <section class="composer-section composer-section--model" hidden>
            <div class="composer-section-head">
              <div class="composer-section-title">
                <span class="composer-step">02</span>
                <div><h3 data-i18n="agent_step_model">Model</h3></div>
              </div>
              <div class="model-catalog-actions">
                <span id="model-meta" class="model-meta" aria-live="polite"></span>
                <button id="refresh-models" class="catalog-refresh" type="button" aria-label="Refresh model catalog">↻ Refresh</button>
              </div>
            </div>
            <div class="model-browser">
              <p id="model-note" class="muted picker-note" hidden></p>
              <label id="model-search" class="model-search" hidden>
                <span class="model-search__label">Find a model</span>
                <input id="model-search-input" type="search" data-i18n-placeholder="agent_search_model_placeholder" placeholder="Search by provider or model name…" autocomplete="off" spellcheck="false">
              </label>
              <div id="model-picker" class="chip-row" role="radiogroup" aria-label="Model"></div>
              <div id="model-custom" class="model-custom" hidden>
                <label class="field"><span>Model id</span><input id="model-custom-input" type="text" placeholder="e.g. gpt-5.5 or openai/gpt-5-nano" autocomplete="off" spellcheck="false"></label>
              </div>
            </div>
          </section>

          <section class="composer-section composer-section--reasoning" hidden>
            <div class="composer-section-title">
              <span class="composer-step">03</span>
              <div><h3 data-i18n="agent_step_reasoning">Reasoning effort</h3></div>
            </div>
            <div id="reasoning-row" class="model-tuning" hidden>
              <div id="reasoning-picker" class="chip-row chip-row--small" role="radiogroup" aria-label="Reasoning effort"></div>
              <label id="fast-switch" class="switch" hidden>
                <input id="run-codex-fast" type="checkbox">
                <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
                <span class="switch__label">Fast mode</span>
              </label>
            </div>
          </section>

          <section id="world-section" class="composer-section composer-section--target" hidden>
            <div class="composer-section-title">
              <span class="composer-step">04</span>
              <div><h3 data-i18n="agent_step_target">Target environment</h3></div>
            </div>
            <div class="target-grid">
              <div class="target-block">
                <span class="target-block__label">World</span>
                <div id="world-picker" class="world-tile-row" role="radiogroup" aria-label="World"></div>
              </div>
              <div class="target-block target-block--level">
                <span class="target-block__label">Start room</span>
                <div id="level-summary" class="level-summary"></div>
              </div>
            </div>
            <div id="level-picker" class="level-grid-wrap" hidden></div>
          </section>

          <section class="composer-section composer-section--settings" hidden>
            <div class="composer-section-title">
              <span class="composer-step">05</span>
              <div><h3 data-i18n="agent_step_settings">Run settings</h3></div>
            </div>
            <div class="settings-stage">
              <div id="local-settings" class="settings-deck">
              <article class="setting-card setting-card--observation">
                <div class="setting-card__head"><span>Observation mode</span></div>
                <div class="animated-segmented observation-mode-picker" id="mode-picker" role="radiogroup" aria-label="Observation mode">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-mode="vision" aria-pressed="false"><span class="segmented__icon">IMG</span><span>Vision</span></button>
                  <button type="button" class="segmented__option" data-mode="text" aria-pressed="false"><span class="segmented__icon">TXT</span><span>ASCII</span></button>
                  <button type="button" class="segmented__option" data-mode="json" aria-pressed="false"><span class="segmented__icon">{ }</span><span>JSON</span></button>
                </div>
                <div id="json-mode-options" class="json-mode-options" hidden>
                  <div class="json-mode-option"><label class="switch"><input type="checkbox" data-json-option="omniscient"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Omniscient</span></label><span class="json-mode-info-wrap"><button class="json-mode-info" type="button" aria-label="About Omniscient mode" aria-describedby="omniscient-mode-tip">i</button><span id="omniscient-mode-tip" class="json-mode-info__tooltip" role="tooltip">Omniscient mode reveals all blocks, even ones obstructed from view</span></span></div>
                  <label class="switch"><input type="checkbox" data-json-option="hideNames"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Hide identities</span></label>
                  <label class="identity-seed-field" data-hide-names-seed-wrap hidden><span>Identity seed</span><input type="text" data-hide-names-seed maxlength="128" value="1" placeholder="1" autocomplete="off" spellcheck="false"></label>
                </div>
              </article>
              <article class="setting-card setting-card--tool-use is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Tool use</span></div>
                <div class="animated-segmented" id="tool-use-picker" role="radiogroup" aria-label="Tool use">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-tool-use="read-only" aria-pressed="false"><span class="segmented__icon">NO</span><span>No Tools</span></button>
                  <button type="button" class="segmented__option" data-tool-use="offline" aria-pressed="false" title="Isolated Python scratchpad; no host files or network"><span class="segmented__icon">PY</span><span>Tools</span></button>
                </div>
                <div id="auto-run-tools-option" class="tool-use-options" data-auto-run-tools-option hidden>
                  <label class="switch auto-run-tools-toggle"><input id="run-auto-run-tools" data-auto-run-tools type="checkbox"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Auto-run tools</span></label>
                  <p>Lets solvers submit full action sequences, observe the final frame, and inspect intermediate frames.</p>
                  <div id="auto-run-all-frames-option" class="tool-use-suboption" data-auto-run-all-frames-option hidden>
                    <label class="switch"><input id="run-auto-run-all-frames" data-auto-run-all-frames type="checkbox"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Include every frame</span></label>
                    <p>Sends every intermediate frame from each action sequence to the agent, not only the final frame.</p>
                  </div>
                </div>
              </article>
              <article class="setting-card setting-card--orchestration is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Orchestration</span></div>
                <div class="animated-segmented" id="orchestration-picker" role="radiogroup" aria-label="Orchestration">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-orchestration="single" aria-pressed="false"><span class="segmented__icon">ONE</span><span>Single</span></button>
                  <button type="button" class="segmented__option" data-orchestration="swarm" aria-pressed="false"><span class="segmented__icon">NET</span><span>Swarm</span></button>
                </div>
              </article>
              <article class="setting-card setting-card--budget is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Budget</span></div>
                <div class="budget-limit-control">
                  <label class="field setting-card__field setting-card__field--budget"><span>Move limit</span><input id="run-moves" type="number" min="0" max="500" value="0" inputmode="numeric"></label>
                  <button id="run-unlimited" class="budget-unlimited" type="button" data-budget-unlimited aria-pressed="false"><span aria-hidden="true">∞</span> Unlimited</button>
                </div>
              </article>
              <article class="setting-card setting-card--give-up is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Allow model to give up</span></div>
                <div class="animated-segmented quit-policy-picker" role="radiogroup" aria-label="Allow model to give up">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-allow-quit="true" aria-pressed="false"><span>Yes</span></button>
                  <button type="button" class="segmented__option" data-allow-quit="false" aria-pressed="false"><span>No</span></button>
                </div>
              </article>
              <article class="setting-card setting-card--auto-quit is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Auto-Quit</span></div>
                <div class="animated-segmented auto-quit-picker" role="radiogroup" aria-label="Automatically quit repetitive runs">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-auto-quit="true" aria-pressed="false"><span>Yes</span></button>
                  <button type="button" class="segmented__option" data-auto-quit="false" aria-pressed="false"><span>No</span></button>
                </div>
                <div class="auto-quit-options" data-auto-quit-options hidden>
                  <label class="auto-quit-field"><span>New-state threshold</span><span class="auto-quit-number"><input type="number" min="0" max="100" step="0.1" value="10" inputmode="decimal" data-auto-quit-threshold><small>%</small></span></label>
                  <label class="auto-quit-field"><span>Average</span><select data-auto-quit-mode><option value="cumulative">Cumulative</option><option value="rolling" selected>Rolling window</option></select></label>
                  <label class="auto-quit-field" data-auto-quit-window-wrap><span>Window</span><span class="auto-quit-number"><input type="number" min="1" max="10000" step="1" value="100" inputmode="numeric" data-auto-quit-window><small>moves</small></span></label>
                  <p>Quit when globally new board states are at or below this rate. Rolling mode waits for a full window.</p>
                </div>
              </article>
              </div>
              <div id="prime-settings" class="settings-deck settings-deck--prime" hidden>
              <article class="setting-card setting-card--observation">
                <div class="setting-card__head"><span>Observation mode</span></div>
                <div class="animated-segmented observation-mode-picker" id="prime-mode-picker" role="radiogroup" aria-label="Observation mode">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-mode="vision" aria-pressed="false"><span class="segmented__icon">IMG</span><span>Vision</span></button>
                  <button type="button" class="segmented__option" data-mode="text" aria-pressed="false"><span class="segmented__icon">TXT</span><span>ASCII</span></button>
                  <button type="button" class="segmented__option" data-mode="json" aria-pressed="false"><span class="segmented__icon">{ }</span><span>JSON</span></button>
                </div>
                <div id="prime-json-mode-options" class="json-mode-options" hidden>
                  <div class="json-mode-option"><label class="switch"><input type="checkbox" data-json-option="omniscient"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Omniscient</span></label><span class="json-mode-info-wrap"><button class="json-mode-info" type="button" aria-label="About Omniscient mode" aria-describedby="prime-omniscient-mode-tip">i</button><span id="prime-omniscient-mode-tip" class="json-mode-info__tooltip" role="tooltip">Omniscient mode reveals all blocks, even ones obstructed from view</span></span></div>
                  <label class="switch"><input type="checkbox" data-json-option="hideNames"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Hide identities</span></label>
                  <label class="identity-seed-field" data-hide-names-seed-wrap hidden><span>Identity seed</span><input type="text" data-hide-names-seed maxlength="128" value="1" placeholder="1" autocomplete="off" spellcheck="false"></label>
                </div>
                <p id="prime-vision-note" class="muted" hidden></p>
              </article>
              <article class="setting-card setting-card--tool-use is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Tool use</span></div>
                <div class="animated-segmented" id="prime-tool-use-picker" role="radiogroup" aria-label="Tool use">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-tool-use="read-only" aria-pressed="false"><span class="segmented__icon">NO</span><span>No Tools</span></button>
                  <button type="button" class="segmented__option" data-tool-use="offline" aria-pressed="false" title="Isolated Python scratchpad; no host files, subprocesses, or network"><span class="segmented__icon">PY</span><span>Tools</span></button>
                </div>
                <div id="prime-auto-run-tools-option" class="tool-use-options" data-auto-run-tools-option hidden>
                  <label class="switch auto-run-tools-toggle"><input id="run-prime-auto-run-tools" data-auto-run-tools type="checkbox"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Auto-run tools</span></label>
                  <p>Lets solvers submit full action sequences, observe the final frame, and inspect intermediate frames.</p>
                  <div id="prime-auto-run-all-frames-option" class="tool-use-suboption" data-auto-run-all-frames-option hidden>
                    <label class="switch"><input id="run-prime-auto-run-all-frames" data-auto-run-all-frames type="checkbox"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Include every frame</span></label>
                    <p>Sends every intermediate frame from each action sequence to the agent, not only the final frame.</p>
                  </div>
                </div>
                <p class="muted">Available for Prime-hosted Codex and Claude Code. Python files persist only in this run's empty scratch workspace.</p>
              </article>
              <article class="setting-card setting-card--budget is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Budget</span></div>
                <div class="budget-limit-control">
                  <label class="field setting-card__field setting-card__field--budget"><span>Action limit</span><input id="run-prime-turns" type="number" min="0" value="0" inputmode="numeric"></label>
                  <button id="run-prime-unlimited" class="budget-unlimited" type="button" data-budget-unlimited aria-pressed="false"><span aria-hidden="true">∞</span> Unlimited</button>
                </div>
              </article>
              <article class="setting-card setting-card--give-up is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Allow model to give up</span></div>
                <div class="animated-segmented quit-policy-picker" role="radiogroup" aria-label="Allow model to give up">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-allow-quit="true" aria-pressed="false"><span>Yes</span></button>
                  <button type="button" class="segmented__option" data-allow-quit="false" aria-pressed="false"><span>No</span></button>
                </div>
              </article>
              <article class="setting-card setting-card--auto-quit is-gated" inert aria-hidden="true">
                <div class="setting-card__head"><span>Auto-Quit</span></div>
                <div class="animated-segmented auto-quit-picker" role="radiogroup" aria-label="Automatically quit repetitive runs">
                  <span class="segmented__glider" aria-hidden="true"></span>
                  <button type="button" class="segmented__option" data-auto-quit="true" aria-pressed="false"><span>Yes</span></button>
                  <button type="button" class="segmented__option" data-auto-quit="false" aria-pressed="false"><span>No</span></button>
                </div>
                <div class="auto-quit-options" data-auto-quit-options hidden>
                  <label class="auto-quit-field"><span>New-state threshold</span><span class="auto-quit-number"><input type="number" min="0" max="100" step="0.1" value="10" inputmode="decimal" data-auto-quit-threshold><small>%</small></span></label>
                  <label class="auto-quit-field"><span>Average</span><select data-auto-quit-mode><option value="cumulative">Cumulative</option><option value="rolling" selected>Rolling window</option></select></label>
                  <label class="auto-quit-field" data-auto-quit-window-wrap><span>Window</span><span class="auto-quit-number"><input type="number" min="1" max="10000" step="1" value="100" inputmode="numeric" data-auto-quit-window><small>moves</small></span></label>
                  <p>Quit when globally new board states are at or below this rate. Rolling mode waits for a full window.</p>
                </div>
              </article>
              </div>
            </div>
          </section>

          <section class="composer-section composer-section--run" hidden>
            <div class="composer-section-title">
              <span class="composer-step">06</span>
              <div><h3 data-i18n="agent_step_run">Run</h3></div>
            </div>
            <div class="launch-dock">
              <div class="launch-controls">
                <button id="launch-run" class="button--primary launch-button" type="button"><span class="launch-button__label" data-i18n="agent_launch_btn">Launch</span><span class="launch-button__arrow" aria-hidden="true">↗</span></button>
              </div>
            </div>
          </section>
        </section>
        <section class="panel agent-runs-panel" aria-label="Runs">
          <div class="runs-head">
            <div><h2 data-i18n="agent_recent_runs">Recent runs</h2></div>
            <span id="runs-total" class="runs-total"></span>
          </div>
          <div class="runs-toolbar">
            <label class="runs-search"><span aria-hidden="true">⌕</span><input id="runs-search" type="search" data-i18n-placeholder="agent_search_placeholder" placeholder="Search runs…" autocomplete="off" spellcheck="false"></label>
            <div class="runs-filters">
              <label class="runs-filter"><span data-i18n="filter_company">Company</span><select id="runs-provider" aria-label="Filter by company"><option value="">All</option></select></label>
              <label class="runs-filter"><span data-i18n="filter_model">Model</span><select id="runs-model" aria-label="Filter by model"><option value="">All</option></select></label>
              <label class="runs-filter"><span data-i18n="filter_status">Status</span><select id="runs-status" aria-label="Filter by status"><option value="">All</option></select></label>
              <label class="runs-filter"><span data-i18n="filter_starred">Starred</span><select id="runs-starred" aria-label="Filter by starred runs"><option value="">All</option><option value="1">Starred</option></select></label>
              <label class="runs-filter"><span data-i18n="filter_sort">Sort</span><select id="runs-sort" aria-label="Sort">
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="actions">Most Actions</option>
                <option value="rooms">Most Rooms</option>
                <option value="gems">Most Gems</option>
              </select></label>
              <label class="runs-filter runs-filter--count"><span data-i18n="filter_show">Show</span><select id="runs-page-size" aria-label="Per page">
                <option value="5" selected>5</option>
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select></label>
            </div>
          </div>
          <div id="agent-runs"></div>
          <div id="runs-pager" class="runs-pager" hidden>
            <button id="runs-prev" class="button" type="button" data-i18n="pager_prev">← Prev</button>
            <span id="runs-page-label" class="muted"></span>
            <button id="runs-next" class="button" type="button" data-i18n="pager_next">Next →</button>
          </div>
        </section>
        <div id="provider-setup-modal" class="build-modal provider-setup-modal" role="dialog" aria-modal="true" aria-labelledby="provider-setup-title" hidden>
          <div class="build-modal__dialog provider-setup-modal__dialog">
            <div class="provider-setup-modal__head">
              <span id="provider-setup-logo" class="provider-setup-modal__logo" aria-hidden="true"></span>
              <div><span class="provider-setup-modal__eyebrow">Setup needed</span><h2 id="provider-setup-title">Prime inactive</h2></div>
            </div>
            <p id="provider-setup-message" class="provider-setup-modal__message"></p>
            <pre class="provider-setup-modal__command"><code id="provider-setup-command"></code></pre>
            <p id="provider-setup-note" class="provider-setup-modal__note" hidden></p>
            <div class="build-modal__actions">
              <a id="provider-setup-docs" class="button" href="#" target="_blank" rel="noreferrer">Setup guide</a>
              <button id="provider-setup-close" class="button--primary" type="button">Got it</button>
            </div>
          </div>
        </div>
        <script>window.__AGENT_DATA__ = ${serializeForScript(agentData)};</script>
        <script src="/agent.js?v=20260806-prime-auto-run-1" defer></script>`
    });
  }

  function renderAgentRunPage(run) {
    const isPrime = Boolean(capabilities.prime_integration && (run.kind === "prime" || run.model === "prime"));
    const clientRun = run.mode !== "vision"
      ? {
          ...run,
          ascii_palette: asciiGlyphPalette({
            hideNames: Boolean(run.hide_names),
            hideNamesSeed: String(run.hide_names_seed || "1")
          })
        }
      : run;
    const runGame = getGame(run.game_id);
    const runWorld = runGame?.worldMap ? agentWorldOption(runGame) : null;
    const tokenSection = `<section class="panel run-tokens" id="run-token-section">
          <div class="run-tokens__head">
            <h2>Tokens</h2>
            <span id="run-token-badge" class="run-tokens__badge" hidden></span>
          </div>
          <div class="run-token-stats">
            <div class="run-token-stat"><span>Total</span><strong id="run-token-total">—</strong></div>
            <div class="run-token-stat"><span>Input</span><strong id="run-token-input">—</strong><small id="run-token-input-detail"></small></div>
            <div class="run-token-stat"><span>Output</span><strong id="run-token-output">—</strong></div>
            <div class="run-token-stat"><span>API estimate</span><strong id="run-token-cost">—</strong><small id="run-token-cost-detail"></small></div>
            <div class="run-token-stat"><span>Context</span><strong id="run-token-context">—</strong><small id="run-token-context-detail"></small></div>
          </div>
          <div id="run-token-chart" class="run-token-chart" hidden></div>
          <p id="run-token-empty" class="muted">Waiting for usage…</p>
          <p id="run-token-note" class="run-token-note" hidden></p>
        </section>`;
    // Shared building blocks for both layouts (Prime vs local runner).
    const boardWrap = `<div id="run-board-wrap" class="run-live__board" hidden>
            <div class="run-live__board-label">${run.mode === "json" ? "ASCII view — the model does not see this" : "ASCII board — this is what the model sees"}</div>
            <pre id="run-board" class="agent-board"></pre>
          </div>`;
    const jsonWrap = run.mode === "json"
      ? `<div id="run-json-wrap" class="run-live__board run-live__json" hidden>
            <div class="run-live__board-label">JSON observation — this is what the model sees</div>
            <pre id="run-json" class="agent-board"></pre>
          </div>`
      : "";
    const replayExportSection = `<section class="panel run-replay-export" id="run-replay-export">
          <div class="run-heatmap__head run-replay-export__head">
            <div>
              <h2>Replay video</h2>
            </div>
            <div class="run-heatmap__actions run-replay-export__actions">
              <select id="run-video-export-limit-kind" class="run-heatmap__format" aria-label="Replay video range" hidden>
                <option value="all">Full run</option>
                <option value="move">Up to move</option>
                <option value="cost">Up to API cost</option>
              </select>
              <label id="run-video-export-limit-field" class="run-heatmap__limit" hidden>
                <span id="run-video-export-limit-unit">Move</span>
                <input id="run-video-export-limit-value" type="number" min="1" step="1" inputmode="decimal" aria-label="Maximum move to render">
              </label>
              <select id="run-video-export-quality" class="run-heatmap__format" aria-label="Replay video quality" hidden>
                <option value="website">Website quality (&lt;25 MB)</option>
                <option value="raw">Raw quality (~100 MB)</option>
              </select>
              <button id="generate-video" class="run-heatmap__export run-replay-export__button" type="button" hidden><span>Generate replay</span></button>
              <a id="download-video" class="run-heatmap__export run-replay-export__button" href="#" download="maze-replay.mp4" hidden><span>Download MP4</span></a>
              <button id="regenerate-video" class="run-heatmap__export run-replay-export__button" type="button" hidden><span>Regenerate replay</span></button>
              <button id="cancel-video" class="run-heatmap__export run-replay-export__cancel" type="button" hidden><span>Cancel</span></button>
            </div>
          </div>
          <div class="run-replay-progress-panel" id="run-replay-progress" aria-live="polite" hidden>
            <div class="run-replay-progress-panel__copy">
              <strong>Rendering replay video</strong>
              <span id="run-replay-label" class="muted"></span>
            </div>
            <div id="run-replay-track" class="replay-progress__track" role="progressbar" aria-label="Replay rendering progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="run-replay-bar" class="replay-progress__fill"></div></div>
          </div>
          <div class="run-replay-media" id="run-replay-section" hidden>
            <video id="run-video" class="run-video" controls playsinline preload="metadata" hidden></video>
          </div>
        </section>`;
    const explorationSection = `<section class="panel run-exploration" id="run-exploration-section">
          <h2>Exploration progress</h2>
          <div class="run-exploration__grid" id="run-exploration-grid" hidden>
            <article class="run-metric-chart">
              <div class="run-metric-chart__head">
                <span class="run-metric-chart__label run-metric-chart__label--rooms">${RUN_METRIC_ICONS.rooms}<span>Rooms visited</span></span>
                <div class="run-metric-chart__actions">
                  <button id="run-rooms-latest" class="run-metric-chart__latest" type="button" title="Show the latest room-visit frame" disabled>—</button>
                  <button id="run-rooms-map-button" class="run-rooms-map-button" type="button" aria-controls="run-rooms-map-dialog" aria-expanded="false" aria-haspopup="dialog" title="View visited rooms map">${MAP_ICON}<span>Map</span></button>
                </div>
              </div>
              <canvas id="run-rooms-chart" class="run-metric-chart__canvas" role="img" aria-label="Rooms visited by action" aria-describedby="run-rooms-chart-tooltip"></canvas>
              <div id="run-rooms-chart-tooltip" class="run-metric-chart__tooltip" role="tooltip" hidden></div>
            </article>
            <article class="run-metric-chart">
              <div class="run-metric-chart__head"><span class="run-metric-chart__label run-metric-chart__label--gems">${RUN_METRIC_ICONS.gems}<span>Gems collected</span></span><button id="run-gems-latest" class="run-metric-chart__latest" type="button" title="Show the latest gem-collection frame" disabled>—</button></div>
              <canvas id="run-gems-chart" class="run-metric-chart__canvas" role="img" aria-label="Gems collected by action" aria-describedby="run-gems-chart-tooltip"></canvas>
              <div id="run-gems-chart-tooltip" class="run-metric-chart__tooltip" role="tooltip" hidden></div>
            </article>
          </div>
          <p id="run-exploration-empty" class="muted">Waiting for the agent's first action…</p>
          <div id="run-rooms-map-dialog" class="run-world-map" role="dialog" aria-modal="true" aria-labelledby="run-rooms-map-title" hidden>
            <div class="run-world-map__dialog">
              <header class="run-world-map__head">
                <div>
                  <span class="run-world-map__eyebrow">Exploration</span>
                  <h2 id="run-rooms-map-title">Rooms visited</h2>
                  <p id="run-rooms-map-summary" class="muted"></p>
                </div>
                <button id="run-rooms-map-close" class="run-world-map__close" type="button" aria-label="Close visited rooms map" title="Close">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 7 10 10"></path><path d="m17 7-10 10"></path></svg>
                </button>
              </header>
              <div class="run-world-map__viewport">
                <div id="run-rooms-map-grid" class="run-world-map__grid" role="group" aria-label="Visited rooms world map"></div>
              </div>
              <div class="run-world-map__legend" aria-hidden="true">
                <span><i class="is-visited"></i>Visited</span>
                <span><i class="is-current"></i>Current room</span>
                <span><i></i>Not visited</span>
              </div>
            </div>
            <div id="run-rooms-map-tooltip" class="run-world-map__tooltip" role="tooltip" hidden></div>
          </div>
        </section>`;
    const heatmapSection = `<section class="panel run-heatmap" id="run-heatmap-section">
          <div id="run-board-state-panel" class="run-board-state-panel" hidden>
            <div class="run-board-state-chart__controls">
              <select id="run-board-state-basis" class="run-board-state-chart__scope" aria-label="Novelty chart observation">
                <option value="state" selected>Board state</option>
                <option value="position">Player world position</option>
              </select>
              <select id="run-board-state-scope" class="run-board-state-chart__scope" aria-label="State novelty chart range">
                <option value="cumulative">Cumulative</option>
                <option value="last-100" selected>Last 100 moves</option>
                <option value="last-n">Last N moves</option>
              </select>
              <label id="run-board-state-custom-window" class="run-board-state-chart__custom-window" hidden>
                <span>N =</span>
                <input id="run-board-state-window" type="number" min="1" max="10000" step="1" value="100" aria-label="Custom novelty window in moves">
              </label>
            </div>
            <div id="run-board-state-chart" class="run-metric-chart run-board-state-chart">
            <div class="run-metric-chart__head">
              <h3 class="run-board-state-chart__title">Novelty rate</h3>
              <strong id="run-board-state-latest">—</strong>
            </div>
            <canvas id="run-board-state-canvas" class="run-metric-chart__canvas run-board-state-chart__canvas" role="img" aria-label="Rolling state novelty rate by action"></canvas>
            <div id="run-board-state-tooltip" class="run-metric-chart__tooltip" role="tooltip" hidden></div>
            </div>
          </div>
          <div class="run-heatmap__head">
            <h2>Heatmap</h2>
            <div class="run-heatmap__actions">
              <span id="run-heatmap-summary" class="run-heatmap__summary" hidden></span>
              <select id="run-heatmap-export-limit-kind" class="run-heatmap__format" aria-label="Heatmap export range" hidden>
                <option value="all">Full run</option>
                <option value="move">Up to move</option>
                <option value="cost">Up to API cost</option>
              </select>
              <label id="run-heatmap-export-limit-field" class="run-heatmap__limit" hidden>
                <span id="run-heatmap-export-limit-unit">Move</span>
                <input id="run-heatmap-export-limit-value" type="number" min="0" step="1" inputmode="decimal" aria-label="Maximum move to export">
              </label>
              <select id="run-heatmap-export-format" class="run-heatmap__format" aria-label="Heatmap export format" hidden>
                <option value="gif">GIF</option>
                <option value="mp4">MP4</option>
              </select>
              <button id="run-heatmap-export" class="run-heatmap__export" type="button" title="Export a compact animated GIF of the heatmap forming" hidden>Export GIF</button>
            </div>
          </div>
          <div id="run-heatmap-viewport" class="run-heatmap__viewport" hidden>
            <canvas id="run-heatmap-canvas" class="run-heatmap__canvas" role="img" aria-label="Player visit heatmap across the explored world"></canvas>
            <div id="run-heatmap-tooltip" class="run-heatmap__tooltip" role="tooltip" hidden></div>
          </div>
          <div id="run-heatmap-legend" class="run-heatmap__legend" hidden aria-label="Heatmap scale from less visited to most visited">
            <span>Less visited</span><i aria-hidden="true"></i><span>Most visited</span>
          </div>
          <p id="run-heatmap-empty" class="muted">Waiting for the player's first position…</p>
        </section>`;
    const movesSection = `<section class="panel run-moves" id="run-moves-section">
          <div class="run-moves__head">
            <div>
              <h2>Moves &amp; reasoning</h2>
              <p class="muted">Search actions, rooms, status, and reasoning. Exports always include the complete log.</p>
            </div>
            <span id="run-feed-result" class="run-moves__count" aria-live="polite">Waiting for moves</span>
          </div>
          <div class="run-feed-toolbar" role="search">
            <div class="run-feed-search">
              <label class="sr-only" for="run-feed-search">Search moves and reasoning</label>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
              <input id="run-feed-search" type="search" placeholder="Search moves, rooms, reasoning…" autocomplete="off" spellcheck="false" maxlength="200" aria-controls="run-feed">
              <button id="run-feed-search-clear" class="run-feed-search__clear" type="button" aria-label="Clear search" title="Clear search" hidden>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10"></path><path d="m17 7-10 10"></path></svg>
              </button>
            </div>
            <button id="run-feed-export" class="button run-feed-export" type="button" title="Export every move and its reasoning as JSON" disabled>${VIDEO_ICONS.download}<span>Export JSON</span></button>
            <button id="run-feed-export-txt" class="button run-feed-export" type="button" title="Export every move and its reasoning as plain text" disabled>${VIDEO_ICONS.download}<span>Export TXT</span></button>
          </div>
          <div id="run-feed" class="agent-feed" aria-label="Moves and reasoning log"></div>
        </section>`;
    const notesSection = `<section id="run-notes-section" class="panel run-notes" aria-labelledby="run-notes-heading">
          <div class="run-notes__shell">
            <div class="run-notes__head">
              <div class="run-notes__intro">
                <span class="run-notes__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M13.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.5"></path><path d="m12 12 7.2-7.2a1.4 1.4 0 0 1 2 2L14 14l-3 1 1-3Z"></path></svg>
                </span>
                <div>
                  <span class="run-notes__eyebrow">Leaderboard annotation</span>
                  <h2 id="run-notes-heading">Run notes</h2>
                  <p>Add the context that matters. When this run is starred, these notes become its MazeJam summary.</p>
                </div>
              </div>
              <span id="run-notes-status" class="run-notes__status" role="status" aria-live="polite"><i aria-hidden="true"></i><span id="run-notes-status-text"></span></span>
            </div>
            <textarea id="run-notes-input" class="run-notes__input" rows="6" maxlength="50000" aria-label="Notes about this agent run" placeholder="What should people know about this run?"></textarea>
            <div class="run-notes__bottom">
              <div class="run-notes__meta">
                <span>Markdown supported</span>
                <span id="run-notes-count">0 / 50,000</span>
                <span class="run-notes__shortcut">⌘ Enter to save</span>
              </div>
              <button id="run-notes-save" class="button--primary run-notes__save" type="button" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h12l2 2v14H5Z"></path><path d="M8 4v6h8V4"></path><path d="M8 20v-6h8v6"></path></svg>
                <span id="run-notes-save-label">Save notes</span>
              </button>
            </div>
          </div>
        </section>`;
    const toolsSection = run.tool_use === "offline"
      ? `<section class="panel run-tools" id="run-tools-section" aria-labelledby="run-tools-heading">
          <div class="run-tools__head">
            <div>
              <span class="run-tools__eyebrow">Isolated scratch space</span>
              <h2 id="run-tools-heading">Tools workspace</h2>
              <p>Agent-created files and every Python execution. Each call is saved to a visible <code>.py</code> file before that file runs, so the agent can revise and reuse it.</p>
            </div>
            <span id="run-tools-live" class="run-tools__live" data-state="idle"><i aria-hidden="true"></i><span>Waiting for Python</span></span>
          </div>
          <div class="run-tools__stats" aria-label="Tools workspace summary">
            <span><strong id="run-tools-execution-count">0</strong><small>Executions</small></span>
            <span><strong id="run-tools-duration">0 ms</strong><small>Total wall time</small></span>
            <span><strong id="run-tools-command-count">0</strong><small>Unique commands</small></span>
            <span><strong id="run-tools-file-count">0</strong><small>Files</small></span>
            <span><strong id="run-tools-file-size">0 B</strong><small>Total file size</small></span>
          </div>
          <div class="run-tools__grid">
            <section class="run-tools__pane run-tools__files" aria-labelledby="run-tools-files-heading">
              <div class="run-tools__pane-head">
                <div><h3 id="run-tools-files-heading">Workspace files</h3><code id="run-tools-path">/workspace</code></div>
                <select id="run-tools-workspace" aria-label="Agent workspace" hidden></select>
              </div>
              <div id="run-tools-file-tree" class="run-tools__file-tree"></div>
              <p id="run-tools-file-empty" class="run-tools__empty">The agent has not created any files.</p>
            </section>
            <section class="run-tools__pane run-tools__executions" aria-labelledby="run-tools-executions-heading">
              <div class="run-tools__pane-head">
                <div><h3 id="run-tools-executions-heading">Python executions</h3><span id="run-tools-execution-summary">Exact source, output, timing, and repeat counts</span></div>
              </div>
              <div id="run-tools-execution-list" class="run-tools__execution-list"></div>
              <p id="run-tools-execution-empty" class="run-tools__empty">Waiting for the first <code>python_exec</code> call.</p>
            </section>
          </div>
          <section id="run-tools-inspector" class="run-tools__inspector" aria-labelledby="run-tools-inspector-title" hidden>
            <div class="run-tools__inspector-head">
              <div><span id="run-tools-inspector-kind" class="run-tools__eyebrow">Python execution</span><h3 id="run-tools-inspector-title"></h3><p id="run-tools-inspector-meta"></p></div>
              <button id="run-tools-inspector-close" type="button" aria-label="Close tools inspector" title="Close">×</button>
            </div>
            <div id="run-tools-inspector-body" class="run-tools__inspector-body"></div>
          </section>
        </section>`
      : "";
    // Agent Runner's default Prime path evaluates locally against Prime
    // inference, so its board and move artifacts arrive after every turn.
    // Explicit hosted runs still sync whatever samples Prime publishes.
    const mazeSections = isPrime
      ? `<section class="panel run-live" id="run-see-section">
          <h2>What the agent sees</h2>
          <div id="run-live-grid" class="run-live__grid${run.mode === "json" ? " is-json-mode" : ""}">
            <div class="run-live__viewer">
              <figure class="run-live__frame">
                <img id="run-live-image" alt="Live maze view" hidden>
                <canvas id="run-live-bitmap" class="run-live__bitmap" width="64" height="64" aria-label="Live colored grid view" hidden></canvas>
                <div id="run-live-placeholder" class="run-live__placeholder">
                  <span id="run-history-progress-title">Loading run history…</span>
                  <div id="run-history-progress" class="run-history-progress" role="progressbar" aria-label="Run history loading progress" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
                    <span id="run-history-progress-fill" class="run-history-progress__fill"></span>
                  </div>
                  <small id="run-history-progress-label" class="run-history-progress__label">0 moves loaded</small>
                </div>
                <figcaption id="run-live-caption" class="run-live__caption" hidden></figcaption>
              </figure>
            </div>
            ${boardWrap}
            ${jsonWrap}
          </div>
          <div class="replay-controls replay-controls--main" id="run-main-replay-controls"></div>
          <p id="run-see-empty" class="muted">Waiting for the model's first observation…</p>
        </section>

        ${toolsSection}

        ${tokenSection}

        ${explorationSection}

        ${heatmapSection}

        ${movesSection}`
      : `<section class="panel run-live">
          <h2>Live view</h2>
          <div id="run-live-grid" class="run-live__grid${run.mode === "json" ? " is-json-mode" : ""}">
            <div class="run-live__viewer">
              <figure class="run-live__frame">
                <img id="run-live-image" alt="Live maze view" hidden>
                <canvas id="run-live-bitmap" class="run-live__bitmap" width="64" height="64" aria-label="Live colored grid view" hidden></canvas>
                <div id="run-live-placeholder" class="run-live__placeholder">
                  <span id="run-history-progress-title">Loading run history…</span>
                  <div id="run-history-progress" class="run-history-progress" role="progressbar" aria-label="Run history loading progress" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
                    <span id="run-history-progress-fill" class="run-history-progress__fill"></span>
                  </div>
                  <small id="run-history-progress-label" class="run-history-progress__label">0 moves loaded</small>
                </div>
                <figcaption id="run-live-caption" class="run-live__caption" hidden></figcaption>
              </figure>
            </div>
            ${boardWrap}
            ${jsonWrap}
          </div>
          <div class="replay-controls replay-controls--main" id="run-main-replay-controls"></div>
        </section>

        <section class="panel run-swarm" id="run-swarm-section" hidden>
          <div class="run-swarm__head">
            <h2>Explorer instances</h2>
            <span class="run-swarm__count" id="run-swarm-count"></span>
          </div>
          <div class="run-swarm__grid" id="run-swarm-grid"></div>
          <details class="run-swarm__finished" id="run-finished-agents" hidden>
            <summary><span class="run-swarm__finished-label">${FOLDER_ICON}<span>Finished agents</span></span><strong id="run-finished-count"></strong></summary>
            <div class="run-swarm__grid" id="run-finished-grid"></div>
          </details>
        </section>

        ${toolsSection}

        ${tokenSection}

        ${explorationSection}

        ${heatmapSection}

        ${movesSection}`;

    return renderSitePage({
      title: `Run ${run.id} — Maze Bench`,
      main: `<div class="page-head run-head">
          <div class="page-actions">
            <h1 style="margin: 0">Agent Run</h1>
            <button id="pause-run" class="button" type="button" hidden>Pause</button>
            <button id="resume-run" class="button--primary" type="button" hidden>Resume</button>
            <button id="continue-run" class="button" type="button" hidden>Continue</button>
            ${isPrime ? '<a id="open-prime-evaluation" class="button" href="#" target="_blank" rel="noreferrer" hidden>Open in Prime ↗</a>' : ""}
            ${isPrime ? '<button id="sync-prime-evaluation" class="button" type="button" hidden>Sync to Prime</button>' : ""}
            ${isPrime ? '<button id="stop-run" class="button--coral" type="button" hidden>Cancel Run</button>' : ""}
            <button id="delete-run" class="button--ghost delete-button" type="button" title="Delete run">${TRASH_ICON}<span>Delete</span></button>
          </div>
          <h2 id="run-title" class="run-title"></h2>
          <p id="run-meta" class="run-config" aria-label="Launch configuration"></p>
          <div id="run-progress" class="run-progress">
            <div class="run-progress__copy">
              <span id="run-progress-count">0 / 0 moves</span>
              <strong id="run-progress-eta">Estimating…</strong>
            </div>
            <div id="run-progress-track" class="run-progress__track" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div id="run-progress-bar" class="run-progress__fill"></div>
            </div>
          </div>
          <div id="run-stats" class="agent-stats"></div>
          <p id="run-status" class="author-status" role="status" aria-live="polite"></p>
        </div>

        ${mazeSections}

        ${notesSection}

        <section class="panel">
          <h2>Runner log</h2>
          <p id="run-log-limit-note" class="muted" hidden>
            Showing the most recent log output to keep this page responsive.
            <a class="text-link" href="/agent-runs/${encodeURIComponent(run.id)}/files/launcher.log" download="launcher.log">Download the full log</a>.
          </p>
          <pre id="run-log" class="agent-log"></pre>
        </section>
        ${replayExportSection}
        <script>window.__AGENT_RUN__ = ${serializeForScript(clientRun)}; window.__AGENT_RUN_WORLD__ = ${serializeForScript(runWorld)};</script>
        <script src="/agent-run.js?v=20260804-replay-export-limits-1" defer></script>`
    });
  }

  function renderExternalPlayLandingPage(serviceData = {}) {
    const activeRun = serviceData.activeRun || null;
    const runsList = serviceData.runs || [];

    const activeRunHtml = activeRun
      ? `<section class="panel active-run-panel" style="border: 1px solid var(--accent, #7c3aed); padding: 18px; border-radius: 12px; margin-bottom: 24px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <span class="badge" style="background: rgba(124, 58, 237, 0.2); color: #a78bfa; padding: 4px 8px; border-radius: 6px; font-weight: 600; font-size: 12px;">${escapeHtml(activeRun.status.toUpperCase())}</span>
              <h2 style="margin: 8px 0 4px 0; font-size: 1.25rem;"><span data-i18n="ext_active_session">Active Session:</span> <code>${escapeHtml(activeRun.runId)}</code></h2>
              <p style="margin: 0; color: #94a3b8; font-size: 0.875rem;"><span data-i18n="ext_created_at">Created:</span> ${escapeHtml(activeRun.manifest?.created_at || "just now")}</p>
            </div>
            <a class="button button--primary" href="/external-play/${encodeURIComponent(activeRun.runId)}" style="padding: 10px 20px;" data-i18n="ext_spectate_btn">Watch / Spectate 3D &rarr;</a>
          </div>
        </section>`
      : `<p class="muted" style="margin-bottom: 24px;" data-i18n="ext_no_active_session">No active session right now. Create one below before starting MCP play.</p>`;

    return renderSitePage({
      title: "External Play (Local MCP) — Maze Bench",
      bodyClass: "external-play-landing-page",
      main: `<div class="page-head">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
            <span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: bold;" data-i18n="ext_badge_unverified">EXTERNAL / UNVERIFIED</span>
          </div>
          <h1 data-i18n="ext_landing_title">External Play — Local MCP</h1>
          <p class="card-by" style="font-size: 1rem; color: #94a3b8; max-width: 720px;" data-i18n="ext_landing_subtitle">
            Control the authoritative MazeBench game session locally via stdio MCP (Codex, Claude Desktop, etc.) and spectate the full 3D game in real time.
          </p>
        </div>

        ${activeRunHtml}

        <section class="panel" style="margin-bottom: 24px;">
          <h2 data-i18n="ext_mcp_config_title">MCP Configuration</h2>
          <p style="color: #94a3b8; font-size: 0.9rem;" data-i18n="ext_mcp_config_desc">Add the following to your Codex or Claude Desktop configuration:</p>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-top: 12px;">
            <div>
              <h3 style="font-size: 0.9rem; margin-bottom: 6px; color: #cbd5e1;">Codex (config.toml)</h3>
              <pre style="background: #0f172a; padding: 12px; border-radius: 8px; font-size: 0.85rem; overflow-x: auto;"><code>[mcp_servers.mazebench]
command = "mazebench"
args = ["mcp"]</code></pre>
            </div>
            <div>
              <h3 style="font-size: 0.9rem; margin-bottom: 6px; color: #cbd5e1;">Claude Desktop (claude_desktop_config.json)</h3>
              <pre style="background: #0f172a; padding: 12px; border-radius: 8px; font-size: 0.85rem; overflow-x: auto;"><code>{
  "mcpServers": {
    "mazebench": {
      "command": "mazebench",
      "args": ["mcp"]
    }
  }
}</code></pre>
            </div>
          </div>
        </section>

        <section class="panel">
          <h2 data-i18n="create_session_title">Create New Session</h2>
          <form id="create-external-run-form" style="display: flex; flex-direction: column; gap: 14px; max-width: 480px; margin-top: 12px;">
            <div class="field">
              <span data-i18n="limit_mode_label">Limit Mode</span>
              <div class="limit-mode-toggle" style="display: flex; gap: 8px; margin-top: 6px;">
                <label id="mode-opt-actions" class="limit-mode-option is-selected" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px; background: rgba(124, 58, 237, 0.2); border: 1px solid #7c3aed; border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 500; transition: all 0.2s;">
                  <input type="radio" name="ext-limit-mode" value="actions" checked style="display: none;">
                  <span>🎯</span> <span data-i18n="limit_mode_actions">Action Limit</span>
                </label>
                <label id="mode-opt-time" class="limit-mode-option" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 500; transition: all 0.2s;">
                  <input type="radio" name="ext-limit-mode" value="time" style="display: none;">
                  <span>⏱️</span> <span data-i18n="limit_mode_time">Time Limit</span>
                </label>
              </div>
            </div>
            <label class="field" id="field-max-actions">
              <span data-i18n="max_actions_label">Action Limit</span>
              <input type="number" id="ext-max-actions" min="1" max="100000" value="256" required>
            </label>
            <div class="field" id="field-time-limit" style="display: none;">
              <label for="ext-time-limit" style="display: flex; flex-direction: column; gap: 4px;">
                <span data-i18n="time_limit_label">Time Limit (seconds)</span>
                <input type="number" id="ext-time-limit" min="5" max="86400" value="120" placeholder="120">
              </label>
              <div class="preset-pills" style="display: flex; gap: 6px; margin-top: 6px;">
                <button type="button" class="preset-btn" data-seconds="60" style="background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.3); color: #cbd5e1; border-radius: 6px; padding: 3px 8px; font-size: 0.75rem; cursor: pointer;">60s</button>
                <button type="button" class="preset-btn" data-seconds="120" style="background: rgba(124, 58, 237, 0.25); border: 1px solid #7c3aed; color: #c4b5fd; border-radius: 6px; padding: 3px 8px; font-size: 0.75rem; cursor: pointer;">120s</button>
                <button type="button" class="preset-btn" data-seconds="300" style="background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.3); color: #cbd5e1; border-radius: 6px; padding: 3px 8px; font-size: 0.75rem; cursor: pointer;">300s (5m)</button>
                <button type="button" class="preset-btn" data-seconds="600" style="background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(148, 163, 184, 0.3); color: #cbd5e1; border-radius: 6px; padding: 3px 8px; font-size: 0.75rem; cursor: pointer;">600s (10m)</button>
              </div>
              <p class="muted" style="font-size: 0.75rem; margin: 4px 0 0 0; color: #94a3b8;" data-i18n="time_limit_hint">In seconds. The session will finalize as timed_out once the deadline is reached.</p>
            </div>
            <label class="field">
              <span data-i18n="model_name_label">Model Name</span>
              <input type="text" id="ext-model-name" data-i18n-placeholder="model_name_placeholder" placeholder="e.g. Gemini 2.5 Flash / Claude 3.7 Sonnet">
            </label>
            <label class="field">
              <span data-i18n="harness_name_label">Harness Name</span>
              <input type="text" id="ext-harness-name" data-i18n-placeholder="harness_name_placeholder" placeholder="e.g. antigravity-mcp / stdio-mcp">
            </label>
            <button class="button button--primary" type="submit" id="create-ext-run-btn" data-i18n="create_btn">Create Armed Session</button>
            <p id="create-ext-status" class="author-status" role="status" aria-live="polite"></p>
          </form>
        </section>
        <script src="/external-play.js" defer></script>`
    });
  }

  function renderExternalPlayRunPage(run) {
    const game = getGame("maze");
    const defaultLevelId = defaultLevelIdForGame(game) || "level_HxI";
    const level = getLevel ? getLevel(game, defaultLevelId) : { id: defaultLevelId, fileName: `${defaultLevelId}.json` };
    const levelState = getLevelState(game, level);
    const authorData = game.worldMap ? buildAuthorPageData(game, level) : null;
    const playWorldData = authorData
      ? {
          blockAdder: authorData.blockAdder,
          defaultFloorToken: authorData.defaultFloorToken,
          existingLevels: authorData.existingLevels,
          game: authorData.game,
          palette: authorData.palette,
          toolboxCatalog: authorData.toolboxCatalog,
          playApiBaseUrl: `/api/play/${encodeURIComponent(game.id)}`,
          worldColumns: authorData.worldColumns,
          worldRows: authorData.worldRows
        }
      : {};

    const clientRunData = {
      run_id: run.runId,
      status: run.status,
      started_at: run.startedAt,
      max_actions: run.maxActions,
      duration_ms: run.durationMs,
      deadline_at: run.deadlineAt,
      model_name: run.modelName || "",
      harness_name: run.harnessName || ""
    };

    const initialBudgetIcon = run.maxActions ? "🎯" : "⏱️";
    const initialBudgetText = run.maxActions
      ? `${run.maxActions} actions left`
      : `${Math.round((run.durationMs || 120000) / 1000)}s limit`;

    const modelDisplay = run.modelName ? ` · Model: ${escapeHtml(run.modelName)}` : "";
    const harnessDisplay = run.harnessName ? ` · Harness: ${escapeHtml(run.harnessName)}` : "";
    const bannerTitle = `EXTERNAL PLAY — LOCAL MCP${modelDisplay}${harnessDisplay} (UNVERIFIED) · NOT A BENCHMARK RESULT`;

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>External Play Spectator — ${escapeHtml(run.runId)}</title>
    <meta name="theme-color" content="#070811">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/site.css">
    <link rel="stylesheet" href="/play-theme.css?v=${PLAY_ASSET_VERSION}">
    <link rel="stylesheet" href="/external-play.css">
    <script src="/i18n.js"></script>
  </head>
  <body class="play-page external-spectator-body">
    <div id="external-banner" class="external-unverified-banner">
      <span id="external-banner-text">${bannerTitle}</span>
      <span id="external-status-pill" class="status-pill status-pill--${escapeHtml(run.status)}">${escapeHtml(run.status.toUpperCase())}</span>
    </div>
    <main id="game-root" class="is-fullbleed is-loading spectator-root">
      <div class="play-shell">
        <div class="play-header" aria-hidden="true"></div>
        <section class="play-stage" aria-label="External play board">
          <div class="maze-frame is-loading">
            <canvas
              id="maze-canvas"
              class="maze-canvas"
              width="${levelState.width * 64}"
              height="${levelState.height * 64}"
              aria-label="Maze board"
            ></canvas>
            <div class="maze-load-art" aria-hidden="true"><span class="maze-load-label">Connecting</span><span class="maze-load-progress"><span></span></span></div>
          </div>
        </section>

        <!-- Top HUD Data Pods (Centered At Top) -->
        <nav id="spectator-top-hud" class="spectator-top-hud" aria-label="Spectator top stats">
          <span id="spectator-budget" class="spectator-badge timer-badge">${initialBudgetIcon} <strong id="spectator-budget-val">${escapeHtml(initialBudgetText)}</strong></span>
          <span id="spectator-rooms-stat" class="spectator-badge">🏛️ <strong id="spectator-rooms-val">1</strong></span>
          <span id="spectator-gems" class="spectator-badge">💎 <strong id="spectator-gems-val">0</strong></span>
          <span id="spectator-actions" class="spectator-badge">👟 <strong id="spectator-actions-val">0</strong></span>
          <span id="spectator-room" class="spectator-badge">🚪 <strong id="spectator-room-val">level_HxI</strong></span>
          <span id="controller-status" class="spectator-badge controller-badge">Controller: Disconnected</span>
          <button id="cancel-run-btn" class="button--danger button--small" type="button" data-i18n="cancel_run">Cancel Run</button>
        </nav>

        <!-- Right Floating AI Action Feed Sidebar -->
        <aside id="spectator-action-feed" class="spectator-action-feed" aria-label="AI Action Feed">
          <div class="action-feed-header">
            <div class="feed-header-title">🕹️ <span data-i18n="feed_title">AI Action Feed</span></div>
            <button id="toggle-feed-btn" class="feed-collapse-btn" type="button" title="Collapse Feed">▶</button>
          </div>
          <div id="action-feed-list" class="action-feed-list">
            <div class="feed-empty-tip" data-i18n="empty_feed">Waiting for MCP controller to call tools...</div>
          </div>
        </aside>

        <!-- Bottom Playback Control Bar -->
        <nav id="spectator-playback-bar" class="spectator-playback-bar" aria-label="Playback controls">
          <div class="playback-controls-left">
            <button id="playback-play-btn" class="playback-btn" type="button" title="Play / Pause" data-i18n-title="play_btn_title">⏸️ Pause</button>
            <button id="playback-prev-btn" class="playback-btn" type="button" title="Previous Step" data-i18n-title="step_prev_title">⏮️</button>
            <button id="playback-next-btn" class="playback-btn" type="button" title="Next Step" data-i18n-title="step_next_title">⏭️</button>
            <span id="playback-step-label" class="playback-step-label">Step: <strong>0 / 0</strong></span>
          </div>
          <div class="playback-scrubber-container">
            <input id="playback-scrubber" class="playback-scrubber" type="range" min="0" max="0" value="0" step="1" aria-label="Playback step scrubber">
          </div>
          <div class="playback-controls-right">
            <button id="playback-summary-btn" class="playback-btn" type="button" title="View Summary" data-i18n="summary_btn" data-i18n-title="summary_btn_title" hidden>📊 Summary</button>
            <button id="playback-minimal-btn" class="playback-btn playback-btn--toggle" type="button" title="Toggle Minimal Mode" aria-pressed="false" data-i18n="minimal_mode_btn">✨ Minimal Mode</button>
            <button id="playback-live-btn" class="playback-btn playback-btn--live is-active" type="button" title="Jump to Live" data-i18n="live_btn" data-i18n-title="live_btn_title">🔴 Live</button>
          </div>
        </nav>
      </div>
      <section id="summary-overlay" class="summary-overlay" hidden>
        <div class="summary-card-dialog">
          <div class="summary-header">
            <h2 data-i18n="summary_title">Game Summary</h2>
            <span id="summary-outcome-badge" class="badge">WON</span>
            <button id="summary-close-btn" class="modal-close-btn" type="button" aria-label="Close" title="Close">✕</button>
          </div>
          <div class="summary-body">
            <div class="summary-grid">
              <div class="summary-stat"><label data-i18n="summary_outcome">Outcome</label><span id="summary-outcome">-</span></div>
              <div class="summary-stat"><label data-i18n="summary_duration">Duration</label><span id="summary-elapsed">-</span></div>
              <div class="summary-stat"><label data-i18n="summary_total_actions">Total Actions</label><span id="summary-actions">-</span></div>
              <div class="summary-stat"><label data-i18n="summary_gems_collected">Gems Collected</label><span id="summary-gems">-</span></div>
              <div class="summary-stat"><label data-i18n="summary_rooms_visited">Rooms Visited</label><span id="summary-rooms">-</span></div>
              <div class="summary-stat"><label data-i18n="summary_declared_cli">Declared CLI</label><span id="summary-cli">-</span></div>
            </div>
            <div class="summary-actions">
              <button id="summary-replay-btn" class="button button--primary" type="button" data-i18n="summary_replay">Replay from Beginning</button>
              <button id="summary-dismiss-btn" class="button" type="button" data-i18n="summary_dismiss">View Board</button>
              <a id="summary-home-btn" class="button" href="/" data-i18n="summary_home">Back to Home</a>
              <a id="summary-json-link" class="button" href="/api/external-play/runs/${encodeURIComponent(run.runId)}/summary" download="summary.json" data-i18n="summary_download">Download summary.json</a>
            </div>
          </div>
        </div>
      </section>
    </main>
    <script>
      window.__MAZEBENCH_INPUT_LOCKED__ = true;
      window.__PLAY_DATA__ = ${serializeForScript({
        ...levelState,
        ...playWorldData,
        externalSpectator: true,
        ignoreSavedGemProgress: true,
        hostOwnsWorldMapNavigation: true
      })};
      ${playWorldData ? `window.__PLAY_WORLD_DATA__ = ${serializeForScript(playWorldData)};` : ""}
      window.__EXTERNAL_PLAY_RUN__ = ${serializeForScript(clientRunData)};
    </script>
    ${playWorldData ? `<script src="/maze-token-patterns.js" defer></script><script src="/author-play-data.js" defer></script>` : ""}
    ${RUNTIME_SCRIPTS}
    <script src="/play-movement.js" defer></script>
    <script src="/play-world-transitions.js" defer></script>
    <script src="/play-gameplay.js" defer></script>
    <script src="/world-solver.js" defer></script>
    <script src="/validators.standalone.js" defer></script>
    <script src="/play.js?v=${PLAY_ASSET_VERSION}" defer></script>
    <script src="/external-play-host.js" defer></script>
    <script src="/external-play.js" defer></script>
  </body>
</html>`;
  }

  function renderLeaderboardPage({ capabilities = null, remoteStatus = null } = {}) {
    return renderSitePage({
      title: "AI Leaderboard — Maze Bench",
      description: "Compare MazeBench model runs by exploration and gem collection.",
      capabilities,
      remoteStatus,
      bodyClass: "ai-page",
      main: `
      <div class="ai-shell">
        <header class="leaderboard-title">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 14.66v1.63a2 2 0 0 1-.98 1.69A5 5 0 0 0 7 21h10a5 5 0 0 0-2.02-3.02 2 2 0 0 1-.98-1.69v-1.63"></path>
            <path d="M18 9h1.5a1 1 0 0 0 0-5H18"></path>
            <path d="M4 22h16"></path>
            <path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1Z"></path>
            <path d="M6 9H4.5a1 1 0 0 1 0-5H6"></path>
          </svg>
          <h1 data-i18n="nav_leaderboard">AI Leaderboard</h1>
        </header>

        <section class="leaderboard-figure" id="leaderboard-figure" aria-labelledby="bar-title">
          <header class="plot-heading">
            <div>
              <h2 id="bar-title" data-i18n="lb_gems_title">GEMS COLLECTED</h2>
            </div>
            <div class="leaderboard-filters" aria-label="Leaderboard filters">
              <div class="filter-control">
                <div class="filter-options" role="group" aria-label="Leaderboard metric">
                  <button class="filter-option" type="button" data-metric="gems" data-i18n="lb_metric_gems" aria-pressed="true">Gems</button>
                  <button class="filter-option" type="button" data-metric="rooms" data-i18n="lb_metric_rooms" aria-pressed="false">Rooms</button>
                </div>
              </div>
              <div class="filter-control">
                <div class="filter-options" role="group" aria-label="Benchmark scope">
                  <button class="filter-option" type="button" data-scope="standard" data-i18n="lb_scope_standard" aria-pressed="true">≤256 Steps</button>
                  <button class="filter-option" type="button" data-scope="time_under_60m" data-i18n="lb_scope_time_under_60m" aria-pressed="false">≤60 Min</button>
                  <button class="filter-option" type="button" data-scope="time_over_60m" data-i18n="lb_scope_time_over_60m" aria-pressed="false">&gt;60 Min</button>
                  <button class="filter-option" type="button" data-scope="all" data-i18n="lb_scope_all" aria-pressed="false">All Records</button>
                </div>
              </div>
              <div class="filter-control">
                <div class="filter-options" role="group" aria-label="Aggregation mode">
                  <button class="filter-option" type="button" data-agg="per_model" data-i18n="lb_agg_best" aria-pressed="true">Best per Model</button>
                  <button class="filter-option" type="button" data-agg="all_runs" data-i18n="lb_agg_all" aria-pressed="false">All Records</button>
                </div>
              </div>
            </div>
          </header>
          <p id="bar-description" class="sr-only" data-i18n="lb_bar_description">A horizontal bar leaderboard ranked by the share of MazeBench completed.</p>
          <div id="leaderboard-bars" class="leaderboard-bars" data-metric="gems" role="list" aria-describedby="bar-description">
            <div class="leaderboard-loading"><span class="inline-spinner" aria-hidden="true"></span></div>
          </div>
          <div id="leaderboard-empty" class="leaderboard-empty" hidden>
            <strong data-i18n="lb_empty_title">暂无带模型名称的评测记录</strong>
            <span data-i18n="lb_empty_desc">创建场次或通过 MCP 运行评测时输入模型名称，即可登上荣誉榜！</span>
          </div>

          <section id="run-detail" class="run-detail" aria-labelledby="diag-model-title">
            <p id="run-detail-empty" class="run-detail__empty" data-i18n="lb_select_inspect">Select a run above to inspect its diagnostics.</p>
            <div id="run-detail-content" class="diag-dashboard" hidden>
              <header class="diag-hero">
                <h2 id="diag-model-title" class="diag-hero__title">MODEL-NAME</h2>
                <div id="diag-badges" class="diag-hero__badges">
                  <span class="diag-badge diag-badge--cyan">ASCII</span>
                  <span class="diag-badge diag-badge--emerald">NO TOOLS</span>
                  <span id="diag-harness-badge" class="diag-badge diag-badge--purple">LOCAL MCP</span>
                </div>
              </header>

              <div class="diag-stats-bar">
                <div class="diag-stat-card">
                  <span class="diag-stat-label" data-i18n="lb_rooms_visited">ROOMS VISITED</span>
                  <div class="diag-stat-value"><strong id="diag-rooms">0</strong><span class="diag-stat-total"> / 256</span></div>
                </div>
                <div class="diag-stat-card">
                  <span class="diag-stat-label" data-i18n="lb_gems_collected">GEMS COLLECTED</span>
                  <div class="diag-stat-value"><strong id="diag-gems">0</strong><span class="diag-stat-total"> / 90</span></div>
                </div>
                <div class="diag-stat-card">
                  <span class="diag-stat-label" data-i18n="lb_moves">MOVES</span>
                  <div class="diag-stat-value"><strong id="diag-moves">0</strong></div>
                </div>
                <div class="diag-stat-card">
                  <span class="diag-stat-label" data-i18n="lb_max_actions">MAX ACTIONS</span>
                  <div class="diag-stat-value"><strong id="diag-actions">256</strong></div>
                </div>
                <div class="diag-stat-card">
                  <span class="diag-stat-label" data-i18n="lb_status">STATUS</span>
                  <div class="diag-stat-value"><strong id="diag-status" class="diag-status-pill">STOPPED</strong></div>
                </div>
              </div>

              <div class="diag-charts-row">
                <div class="diag-chart-card">
                  <div class="diag-card-head">
                    <div class="diag-card-title-group">
                      <span class="diag-card-icon">🗺️</span>
                      <div>
                        <span class="diag-card-category" data-i18n="lb_category_exploration">EXPLORATION</span>
                        <h4 class="diag-card-title" data-i18n="lb_rooms_visited">Rooms visited</h4>
                      </div>
                    </div>
                    <span id="diag-rooms-badge" class="diag-card-badge">0</span>
                  </div>
                  <div class="diag-canvas-wrap">
                    <canvas id="diag-rooms-canvas" width="320" height="150"></canvas>
                  </div>
                </div>

                <div class="diag-chart-card">
                  <div class="diag-card-head">
                    <div class="diag-card-title-group">
                      <span class="diag-card-icon">💎</span>
                      <div>
                        <span class="diag-card-category" data-i18n="lb_category_collection">COLLECTION</span>
                        <h4 class="diag-card-title" data-i18n="lb_gems_collected">Gems collected</h4>
                      </div>
                    </div>
                    <span id="diag-gems-badge" class="diag-card-badge diag-badge--gold">0</span>
                  </div>
                  <div class="diag-canvas-wrap">
                    <canvas id="diag-gems-canvas" width="320" height="150"></canvas>
                  </div>
                </div>

                <div class="diag-chart-card">
                  <div class="diag-card-head">
                    <div class="diag-card-title-group">
                      <span class="diag-card-icon">✨</span>
                      <div>
                        <span class="diag-card-category" id="diag-novelty-category" data-i18n="lb_category_novelty">ROLLING AVERAGE OVER THE LAST 100 MOVES</span>
                        <h4 class="diag-card-title" data-i18n="lb_novelty_title">Board-state novelty</h4>
                      </div>
                    </div>
                    <span id="diag-novelty-badge" class="diag-card-badge diag-badge--pink">0%</span>
                  </div>
                  <div class="diag-canvas-wrap">
                    <canvas id="diag-novelty-canvas" width="320" height="150"></canvas>
                  </div>
                </div>
              </div>

              <div class="diag-heatmap-card">
                <div class="diag-card-head">
                  <div class="diag-card-title-group">
                    <span class="diag-card-icon">📍</span>
                    <div>
                      <span class="diag-card-category" data-i18n="lb_category_trajectory">TRAJECTORY</span>
                      <h4 class="diag-card-title" data-i18n="lb_heatmap_title">Player visit heatmap</h4>
                    </div>
                  </div>
                  <div class="diag-heatmap-meta">
                    <span id="diag-unique-cells" class="diag-card-badge">0 unique cells</span>
                    <a id="diag-source-link" class="button button--small" href="#" target="_blank" data-i18n="lb_open_run">Open agent run &rarr;</a>
                  </div>
                </div>
                <div class="diag-heatmap-body" id="diag-heatmap-container">
                  <div class="diag-heatmap-placeholder"><span class="inline-spinner"></span></div>
                </div>
                <div class="diag-playback-bar">
                  <button id="diag-play-btn" type="button" class="diag-play-btn" aria-label="Play/Pause">▶</button>
                  <input id="diag-scrubber" type="range" class="diag-scrubber" min="0" max="0" value="0" step="1">
                  <span id="diag-step-counter" class="diag-step-counter">Step 0 / 0</span>
                </div>
              </div>
            </div>
          </section>
        </section>
      </div>`,
      extraHeadHtml: `<script src="/ai-leaderboard.js" defer></script>`
    });
  }

  function renderNotFound() {
    return renderSitePage({
      title: "Not Found — Maze Bench",
      main: `<div class="empty-state"><span class="glyph">?</span><p>Page not found.</p><p><a class="text-link" href="/">Back to Maze Bench</a></p></div>`
    });
  }

  return {
    renderAgentPage,
    renderAgentRunPage,
    renderAuthorPage,
    renderBuildPage,
    renderExternalPlayLandingPage,
    renderExternalPlayRunPage,
    renderFlyoverPage,
    renderGamePage,
    renderHomePage,
    renderLeaderboardPage,
    renderNotFound,
    renderPlayPage,
    renderWorldMapEditorPage
  };
}

module.exports = {
  createPageRenderer
};
