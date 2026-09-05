(() => {
  const MODEL_FAMILY_COLORS = {
    claude: "#ff9b45",
    gemini: "#b18cff",
    gemma: "#b18cff",
    gpt: "#72c7ff",
    kimi: "#67d88b",
    deepseek: "#4fd6c8",
    qwen: "#ff7db8",
    llama: "#f3c05f",
    mistral: "#cf8cff",
    grok: "#d8dd6b"
  };
  const MODEL_FALLBACK_COLORS = [
    "#4fd6c8",
    "#ff7db8",
    "#f3c05f",
    "#7ea6ff",
    "#ff8a72",
    "#cf8cff",
    "#d8dd6b"
  ];
  const DEFAULT_MODEL_COLOR = "#aeb8d8";

  const state = {
    data: null,
    metric: "gems",      // "gems" | "rooms"
    scope: "standard",   // "standard" | "all"
    agg: "per_model",    // "per_model" | "all_runs"
    selectedId: ""
  };

  const elements = {};

  function refreshElements() {
    elements.barTitle = document.querySelector("#bar-title");
    elements.bars = document.querySelector("#leaderboard-bars");
    elements.empty = document.querySelector("#leaderboard-empty");
    elements.detail = document.querySelector("#run-detail, #leaderboard-selected-detail");
    elements.detailEmpty = document.querySelector("#run-detail-empty");
    elements.detailContent = document.querySelector("#run-detail-content");
    elements.selectedName = document.querySelector("#selected-run-name");
    elements.selectedMeta = document.querySelector("#selected-run-meta");
    elements.sourceLink = document.querySelector("#run-source-link, #selected-run-link");
    elements.selectedRooms = document.querySelector("#selected-rooms");
    elements.selectedGems = document.querySelector("#selected-gems");
    elements.selectedMoves = document.querySelector("#selected-moves");
    elements.selectedActions = document.querySelector("#selected-actions");
    elements.selectedStatus = document.querySelector("#selected-status");

    // 全尺寸诊断仪表盘节点
    elements.diagTitle = document.querySelector("#diag-model-title");
    elements.diagBadges = document.querySelector("#diag-badges");
    elements.diagRooms = document.querySelector("#diag-rooms");
    elements.diagGems = document.querySelector("#diag-gems");
    elements.diagMoves = document.querySelector("#diag-moves");
    elements.diagActions = document.querySelector("#diag-actions");
    elements.diagStatus = document.querySelector("#diag-status");
    elements.diagRoomsBadge = document.querySelector("#diag-rooms-badge");
    elements.diagGemsBadge = document.querySelector("#diag-gems-badge");
    elements.diagNoveltyBadge = document.querySelector("#diag-novelty-badge");
    elements.diagRoomsCanvas = document.querySelector("#diag-rooms-canvas");
    elements.diagGemsCanvas = document.querySelector("#diag-gems-canvas");
    elements.diagNoveltyCanvas = document.querySelector("#diag-novelty-canvas");
    elements.diagUniqueCells = document.querySelector("#diag-unique-cells");
    elements.diagSourceLink = document.querySelector("#diag-source-link, #run-source-link");
    elements.diagHeatmapContainer = document.querySelector("#diag-heatmap-container");
    elements.diagPlayBtn = document.querySelector("#diag-play-btn");
    elements.diagScrubber = document.querySelector("#diag-scrubber");
    elements.diagStepCounter = document.querySelector("#diag-step-counter");
  }

  function modelColor(modelName) {
    if (!modelName) return DEFAULT_MODEL_COLOR;
    const clean = String(modelName).trim().toLowerCase();
    for (const [key, color] of Object.entries(MODEL_FAMILY_COLORS)) {
      if (clean.includes(key)) return color;
    }
    let hash = 0;
    for (const char of clean) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return MODEL_FALLBACK_COLORS[hash % MODEL_FALLBACK_COLORS.length];
  }

  function escapeText(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function updateFilterIndicators() {
    document.querySelectorAll(".filter-options").forEach((group) => {
      const active = group.querySelector(".filter-option[aria-pressed='true']");
      if (!active) return;
      const left = active.offsetLeft;
      const width = active.offsetWidth;
      group.style.setProperty("--indicator-x", `${left}px`);
      group.style.setProperty("--indicator-width", `${width}px`);
    });
  }

  function wireFilters() {
    refreshElements();
    // 1. Metric: gems | rooms
    document.querySelectorAll("[data-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.metric = btn.dataset.metric;
        document.querySelectorAll("[data-metric]").forEach((b) => {
          b.setAttribute("aria-pressed", b.dataset.metric === state.metric ? "true" : "false");
        });
        updateFilterIndicators();
        renderView();
      });
    });

    // 2. Scope: standard | all
    document.querySelectorAll("[data-scope]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.scope = btn.dataset.scope;
        document.querySelectorAll("[data-scope]").forEach((b) => {
          b.setAttribute("aria-pressed", b.dataset.scope === state.scope ? "true" : "false");
        });
        updateFilterIndicators();
        renderView();
      });
    });

    // 3. Aggregation: per_model | all_runs
    document.querySelectorAll("[data-agg]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.agg = btn.dataset.agg;
        document.querySelectorAll("[data-agg]").forEach((b) => {
          b.setAttribute("aria-pressed", b.dataset.agg === state.agg ? "true" : "false");
        });
        updateFilterIndicators();
        renderView();
      });
    });
  }

  async function fetchLeaderboardData() {
    refreshElements();
    try {
      const res = await fetch("/api/agent/leaderboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load leaderboard data.`);
      state.data = await res.json();
      renderView();
    } catch (e) {
      console.error("[Leaderboard] Fetch error:", e);
      refreshElements();
      if (elements.bars) {
        elements.bars.innerHTML = `<p class="ai-error" style="color:#f87171;padding:24px;text-align:center;">${escapeText(e.message || "Failed to load leaderboard data.")}</p>`;
      }
    }
  }

  function getActiveEntries() {
    if (!state.data) return [];
    const scopeData = state.data[state.scope] || { by_rooms: { per_model: [], all_runs: [] }, by_gems: { per_model: [], all_runs: [] } };
    const dimension = state.metric === "rooms" ? scopeData.by_rooms : scopeData.by_gems;
    return (dimension && dimension[state.agg]) || [];
  }

  function isZh() {
    if (window.MazeBenchI18n && typeof window.MazeBenchI18n.getLanguage === "function") {
      return window.MazeBenchI18n.getLanguage() === "zh";
    }
    try {
      return localStorage.getItem("mazebench_lang") === "zh";
    } catch (_e) {
      return false;
    }
  }

  function renderView() {
    refreshElements();
    if (!elements.bars) return;

    // 标题更新 (全大写 Orbitron / 中文)
    if (elements.barTitle) {
      if (isZh()) {
        elements.barTitle.textContent = state.metric === "rooms" ? "探索最多房间 (ROOMS VISITED)" : "收集最多宝石 (GEMS COLLECTED)";
      } else {
        elements.barTitle.textContent = state.metric === "rooms" ? "ROOMS VISITED" : "GEMS COLLECTED";
      }
    }

    const entries = getActiveEntries();

    if (elements.empty) {
      elements.empty.hidden = entries.length > 0;
      elements.empty.style.display = entries.length > 0 ? "none" : "flex";
    }

    if (!entries.length) {
      elements.bars.replaceChildren();
      if (elements.detail) elements.detail.hidden = true;
      return;
    }

    // 如果当前选中的不在列表中，默认选中第一条
    if (!entries.some((e) => e.id === state.selectedId)) {
      state.selectedId = entries[0].id;
    }

    elements.bars.dataset.metric = state.metric;
    elements.bars.replaceChildren(...entries.map((entry, index) => createLeaderboardBar(entry, index)));

    renderDetail(entries.find((e) => e.id === state.selectedId) || entries[0]);
    updateFilterIndicators();
  }

  function createLeaderboardBar(entry, index) {
    const isRooms = state.metric === "rooms";
    const percentage = isRooms ? (entry.room_percentage ?? 0) : (entry.gem_percentage ?? 0);
    const roomMax = entry.room_total || 256;
    const gemMax = entry.gem_total || 90;
    const primaryScoreText = isRooms
      ? (isZh() ? `${entry.room_count} / ${roomMax} 房间` : `${entry.room_count} / ${roomMax} rooms`)
      : (isZh() ? `${entry.gem_count} / ${gemMax} 宝石` : `${entry.gem_count} / ${gemMax} gems`);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "leaderboard-bar";
    btn.setAttribute("role", "listitem");
    btn.setAttribute("aria-pressed", entry.id === state.selectedId ? "true" : "false");
    btn.dataset.runId = entry.id;

    // 前三名样式高亮
    if (index === 0) btn.classList.add("rank-top-1");
    else if (index === 1) btn.classList.add("rank-top-2");
    else if (index === 2) btn.classList.add("rank-top-3");

    const color = modelColor(entry.model_name || entry.model);
    btn.style.setProperty("--bar-value", `${percentage}%`);
    btn.style.setProperty("--model-accent", color);

    const identity = document.createElement("span");
    identity.className = "leaderboard-bar__identity";

    const modelSpan = document.createElement("span");
    modelSpan.className = "leaderboard-bar__model";

    const nameStrong = document.createElement("strong");
    nameStrong.textContent = entry.model_name || entry.model || "Unknown";
    nameStrong.title = nameStrong.textContent;
    nameStrong.style.color = color;

    const configSmall = document.createElement("small");
    const metaParts = [];
    if (entry.harness) metaParts.push(entry.harness);
    if (entry.is_time_limited && entry.duration_ms) {
      const mins = Math.round(Number(entry.duration_ms) / 60000);
      metaParts.push(mins >= 1 ? `⏱️ ${mins}m` : `⏱️ ${Math.round(Number(entry.duration_ms) / 1000)}s`);
    } else if (entry.max_actions && state.scope !== "standard" && entry.max_actions !== 256) {
      metaParts.push(`🎯 ${entry.max_actions}`);
    }
    if (entry.elapsed_seconds) {
      const elapsedMin = Math.round(Number(entry.elapsed_seconds) / 60);
      if (elapsedMin > 0 && !entry.is_time_limited) metaParts.push(`${elapsedMin}m`);
    }
    configSmall.textContent = metaParts.join(" · ") || entry.config_label || entry.harness || "";

    modelSpan.append(nameStrong, configSmall);
    identity.append(modelSpan);

    const plot = document.createElement("span");
    plot.className = "leaderboard-bar__plot";

    const fill = document.createElement("span");
    fill.className = "leaderboard-bar__fill";

    const val = document.createElement("span");
    val.className = "leaderboard-bar__value";
    val.textContent = `${percentage}%`;
    val.title = primaryScoreText;

    plot.append(fill, val);
    btn.append(identity, plot);

    btn.addEventListener("click", () => {
      state.selectedId = entry.id;
      document.querySelectorAll(".leaderboard-bar").forEach((b) => {
        b.setAttribute("aria-pressed", b.dataset.runId === entry.id ? "true" : "false");
      });
      renderDetail(entry);
    });

    return btn;
  }

  let currentPlayback = {
    timer: null,
    isPlaying: false,
    trajectory: [],
    currentStep: 0,
    runId: null
  };

  function stopPlayback() {
    if (currentPlayback.timer) {
      clearInterval(currentPlayback.timer);
      currentPlayback.timer = null;
    }
    currentPlayback.isPlaying = false;
    if (elements.diagPlayBtn) elements.diagPlayBtn.textContent = "▶";
  }

  function drawCoordinatedChart(canvas, points, options = {}) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 320;
    const height = rect.height || 150;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const {
      lineColor = "#65f3d4",
      fillColor = "rgba(101, 243, 212, 0.18)",
      isStep = false,
      isPercentage = false,
      yMin = 0,
      yMax = 10,
      yTicks = null,
      maxStep = 256
    } = options;

    const padLeft = isPercentage ? 38 : 28;
    const padRight = 14;
    const padTop = 14;
    const padBottom = 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    // 1. 计算与生成 y 轴刻度
    let ticks = [];
    if (isPercentage) {
      ticks = [
        { v: 100, label: "100%" },
        { v: 75, label: "75%" },
        { v: 50, label: "50%" },
        { v: 25, label: "25%" },
        { v: 0, label: "0%" }
      ];
    } else if (yTicks && yTicks.length) {
      ticks = yTicks.map((t) => ({ v: t, label: String(t) }));
    } else {
      const effMin = yMin;
      const effMax = Math.max(effMin + 1, yMax);
      if (effMax - effMin <= 4) {
        for (let v = effMax; v >= effMin; v--) {
          ticks.push({ v, label: String(v) });
        }
      } else {
        const step = Math.max(1, Math.ceil((effMax - effMin) / 4));
        for (let v = effMax; v >= effMin; v -= step) {
          ticks.push({ v, label: String(v) });
        }
        if (!ticks.some((t) => t.v === effMin)) {
          ticks.push({ v: effMin, label: String(effMin) });
        }
      }
    }

    const domainMin = isPercentage ? 0 : Math.min(...ticks.map((t) => t.v));
    const domainMax = isPercentage ? 100 : Math.max(...ticks.map((t) => t.v));
    const domainRange = domainMax - domainMin || 1;

    // 2. 绘制水平网格参考线与 y 轴标签
    ctx.font = '10px "JetBrains Mono", monospace, sans-serif';
    ctx.textBaseline = "middle";

    ticks.forEach((tick) => {
      const y = padTop + plotH - ((tick.v - domainMin) / domainRange) * plotH;

      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#64748b";
      ctx.textAlign = "right";
      ctx.fillText(tick.label, padLeft - 6, y);
    });

    // 3. 绘制 x 轴底部起止步数刻度
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "left";
    ctx.fillText("1", padLeft, height - 2);
    ctx.textAlign = "right";
    ctx.fillText(maxStep.toLocaleString(), padLeft + plotW, height - 2);

    if (!points || points.length === 0) return;

    // 4. 将数据点映射到画布像素
    const coords = [];
    const totalPoints = points.length;

    for (let i = 0; i < totalPoints; i++) {
      const p = points[i];
      const stepIdx = p.seq != null ? p.seq : (i + 1);
      const ratio = maxStep > 1 ? Math.max(0, Math.min(1, (stepIdx - 1) / (maxStep - 1))) : 0;
      const x = padLeft + ratio * plotW;
      const clampedV = Math.max(domainMin, Math.min(domainMax, p.v));
      const y = padTop + plotH - ((clampedV - domainMin) / domainRange) * plotH;
      coords.push({ x, y });
    }

    if (coords.length === 1) {
      coords.push({ x: padLeft + plotW, y: coords[0].y });
    }

    // 5. 区域填充
    ctx.beginPath();
    ctx.moveTo(coords[0].x, padTop + plotH);
    if (isStep) {
      for (let i = 0; i < coords.length; i++) {
        if (i > 0) ctx.lineTo(coords[i].x, coords[i - 1].y);
        ctx.lineTo(coords[i].x, coords[i].y);
      }
    } else {
      coords.forEach((c) => ctx.lineTo(c.x, c.y));
    }
    ctx.lineTo(coords[coords.length - 1].x, padTop + plotH);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, fillColor);
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = grad;
    ctx.fill();

    // 6. 曲线主体
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    if (isStep) {
      for (let i = 1; i < coords.length; i++) {
        ctx.lineTo(coords[i].x, coords[i - 1].y);
        ctx.lineTo(coords[i].x, coords[i].y);
      }
    } else {
      for (let i = 1; i < coords.length; i++) {
        ctx.lineTo(coords[i].x, coords[i].y);
      }
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // 7. 终点高亮发光小圆点
    const last = coords[coords.length - 1];
    ctx.save();
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.restore();
  }

  function drawMiniCharts(diag) {
    if (!diag) return;
    const maxMoves = Math.max(1, diag.turns || diag.max_actions || 256);

    // 1. Rooms visited (图 1: 阶梯折线，y轴起点为 1)
    const rooms = Math.max(1, diag.room_count || 1);
    const roomsPoints =
      diag.progress_curve && diag.progress_curve.length > 0
        ? diag.progress_curve.map((p) => ({ seq: p.seq || p.action_seq, v: p.rooms || 1 }))
        : [{ seq: 1, v: 1 }, { seq: maxMoves, v: rooms }];

    let roomTicks = [1, 3, 6, 8, 10];
    if (rooms <= 4) {
      roomTicks = Array.from({ length: rooms }, (_, i) => i + 1);
    } else {
      roomTicks = [1, Math.round(rooms * 0.3), Math.round(rooms * 0.6), Math.round(rooms * 0.8), rooms];
      roomTicks = [...new Set(roomTicks)].sort((a, b) => a - b);
    }

    drawCoordinatedChart(elements.diagRoomsCanvas, roomsPoints, {
      lineColor: "#65f3d4",
      fillColor: "rgba(101, 243, 212, 0.22)",
      isStep: true,
      isPercentage: false,
      yMin: 1,
      yMax: rooms,
      yTicks: roomTicks,
      maxStep: maxMoves
    });
    if (elements.diagRoomsBadge) elements.diagRoomsBadge.textContent = rooms;

    // 2. Gems collected (图 2: 阶梯折线，从 0 开始)
    const gems = diag.gem_count || 0;
    const gemsPoints =
      diag.progress_curve && diag.progress_curve.length > 0
        ? diag.progress_curve.map((p) => ({ seq: p.seq || p.action_seq, v: p.gems || 0 }))
        : [{ seq: 1, v: 0 }, { seq: maxMoves, v: gems }];

    const gemTicks = gems <= 1 ? [0, 1] : [0, Math.round(gems / 2), gems];

    drawCoordinatedChart(elements.diagGemsCanvas, gemsPoints, {
      lineColor: "#fcd34d",
      fillColor: "rgba(252, 211, 77, 0.22)",
      isStep: true,
      isPercentage: false,
      yMin: 0,
      yMax: Math.max(1, gems),
      yTicks: gemTicks,
      maxStep: maxMoves
    });
    if (elements.diagGemsBadge) elements.diagGemsBadge.textContent = gems;

    // 3. Board-state novelty (图 3: 波动折线，固定 0%~100% 刻度)
    const noveltyPoints =
      diag.novelty_curve && diag.novelty_curve.length > 0
        ? diag.novelty_curve.map((p) => ({ seq: p.seq, v: p.pct }))
        : [{ seq: 1, v: 100 }, { seq: Math.round(maxMoves * 0.5), v: 75 }, { seq: maxMoves, v: 80 }];

    drawCoordinatedChart(elements.diagNoveltyCanvas, noveltyPoints, {
      lineColor: "#f472b6",
      fillColor: "rgba(244, 114, 182, 0.22)",
      isStep: false,
      isPercentage: true,
      maxStep: maxMoves
    });
    const lastNovelty = noveltyPoints[noveltyPoints.length - 1]?.v || 0;
    if (elements.diagNoveltyBadge) elements.diagNoveltyBadge.textContent = `${lastNovelty}%`;
  }

  function calculateHeatmapBounds(trajectory) {
    if (!trajectory || !trajectory.length) return null;

    let minCol = 16, maxCol = -1;
    let minRow = 16, maxRow = -1;

    trajectory.forEach((point) => {
      const match = String(point.room || "").match(/^level_([A-Z])x([A-Z])$/i);
      let colIdx = 7, rowIdx = 8;
      if (match) {
        colIdx = match[1].toUpperCase().charCodeAt(0) - 65;
        rowIdx = match[2].toUpperCase().charCodeAt(0) - 65;
      }
      minCol = Math.min(minCol, colIdx);
      maxCol = Math.max(maxCol, colIdx);
      minRow = Math.min(minRow, rowIdx);
      maxRow = Math.max(maxRow, rowIdx);
    });

    if (maxCol < 0) {
      minCol = 7; maxCol = 7;
      minRow = 8; maxRow = 8;
    }

    // 精确根据实际访问过的房间范围自适应裁切视口，不再强制补足 4 列或外加 padding
    const viewMinCol = minCol;
    const viewMaxCol = maxCol;
    const viewMinRow = minRow;
    const viewMaxRow = maxRow;

    const roomSpanX = viewMaxCol - viewMinCol + 1;
    const roomSpanY = viewMaxRow - viewMinRow + 1;
    const ROOM_PX = 80;
    const CELL_PX = 5;
    const svgWidth = roomSpanX * ROOM_PX;
    const svgHeight = roomSpanY * ROOM_PX;

    // 预先生成固定的网格分割线与房间外边框，全程稳定不跳变
    const gridLines = [];
    gridLines.push(`<rect x="0.5" y="0.5" width="${svgWidth - 1}" height="${svgHeight - 1}" fill="none" class="heatmap-room-line"></rect>`);
    for (let c = 1; c < roomSpanX; c++) {
      const x = c * ROOM_PX;
      gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${svgHeight}" class="heatmap-room-line"></line>`);
    }
    for (let r = 1; r < roomSpanY; r++) {
      const y = r * ROOM_PX;
      gridLines.push(`<line x1="0" y1="${y}" x2="${svgWidth}" y2="${y}" class="heatmap-room-line"></line>`);
    }

    return {
      viewMinCol,
      viewMaxCol,
      viewMinRow,
      viewMaxRow,
      roomSpanX,
      roomSpanY,
      ROOM_PX,
      CELL_PX,
      svgWidth,
      svgHeight,
      gridLines: gridLines.join("")
    };
  }

  function generateHeatmapSvg(trajectory, currentStep, bounds) {
    if (!trajectory || !trajectory.length || !bounds) {
      return `<div class="diag-heatmap-placeholder">No trajectory points available for this run.</div>`;
    }

    const activeTrajectory = trajectory.slice(0, currentStep);
    if (!activeTrajectory.length) {
      return `<svg viewBox="0 0 ${bounds.svgWidth} ${bounds.svgHeight}" width="${bounds.svgWidth}" height="${bounds.svgHeight}" class="heatmap-svg" role="img" aria-label="Player visit heatmap">
        ${bounds.gridLines}
      </svg>`;
    }

    const cellVisits = new Map();

    activeTrajectory.forEach((point) => {
      const match = String(point.room || "").match(/^level_([A-Z])x([A-Z])$/i);
      let colIdx = 7, rowIdx = 8;
      if (match) {
        colIdx = match[1].toUpperCase().charCodeAt(0) - 65;
        rowIdx = match[2].toUpperCase().charCodeAt(0) - 65;
      }

      const cellX = Math.max(0, Math.min(15, point.x || 0));
      const cellY = Math.max(0, Math.min(15, point.y || 0));
      const worldCellX = colIdx * 16 + cellX;
      const worldCellY = rowIdx * 16 + cellY;
      const key = `${worldCellX},${worldCellY}`;

      const existing = cellVisits.get(key) || { count: 0, col: colIdx, row: rowIdx, cx: cellX, cy: cellY };
      existing.count += 1;
      existing.lastSeq = point.seq;
      cellVisits.set(key, existing);
    });

    const rects = [];
    cellVisits.forEach(({ count, col, row, cx, cy }) => {
      const px = (col - bounds.viewMinCol) * bounds.ROOM_PX + cx * bounds.CELL_PX;
      const py = (row - bounds.viewMinRow) * bounds.ROOM_PX + cy * bounds.CELL_PX;
      const t = Math.min(1, (count - 1) / 5);
      const hue = 195 - t * 18;
      const lightness = 38.66 + t * 37.34;
      const fill = `hsl(${hue.toFixed(2)} 88% ${lightness.toFixed(2)}%)`;

      rects.push(`<rect x="${px}" y="${py}" width="${bounds.CELL_PX}" height="${bounds.CELL_PX}" fill="${fill}" class="heatmap-cell"></rect>`);
    });

    // 玩家最新位置：双层结构，外层呼吸光环 + 内层小白点，彻底避免 transform: scale 导致的斜向晃动 Bug
    const lastPoint = activeTrajectory[activeTrajectory.length - 1];
    let markerHtml = "";
    if (lastPoint) {
      const m = String(lastPoint.room || "").match(/^level_([A-Z])x([A-Z])$/i);
      const cIdx = m ? m[1].toUpperCase().charCodeAt(0) - 65 : 7;
      const rIdx = m ? m[2].toUpperCase().charCodeAt(0) - 65 : 8;
      const mx = (cIdx - bounds.viewMinCol) * bounds.ROOM_PX + Math.max(0, Math.min(15, lastPoint.x || 0)) * bounds.CELL_PX + 2.5;
      const my = (rIdx - bounds.viewMinRow) * bounds.ROOM_PX + Math.max(0, Math.min(15, lastPoint.y || 0)) * bounds.CELL_PX + 2.5;
      markerHtml = `
        <circle cx="${mx}" cy="${my}" r="6" class="heatmap-player-halo"></circle>
        <circle cx="${mx}" cy="${my}" r="3" class="heatmap-player-dot"></circle>
      `;
    }

    return `<svg viewBox="0 0 ${bounds.svgWidth} ${bounds.svgHeight}" width="${bounds.svgWidth}" height="${bounds.svgHeight}" class="heatmap-svg" role="img" aria-label="Player visit heatmap with ${cellVisits.size} visited cells through action ${activeTrajectory.length}">
      ${rects.join("")}
      ${markerHtml}
      ${bounds.gridLines}
    </svg>`;
  }

  function updateHeatmapDisplay() {
    if (!elements.diagHeatmapContainer || !currentPlayback.bounds) return;
    const svgHtml = generateHeatmapSvg(currentPlayback.trajectory, currentPlayback.currentStep, currentPlayback.bounds);
    elements.diagHeatmapContainer.innerHTML = svgHtml;
    if (elements.diagStepCounter) {
      const isZh = window.i18n?.isZh();
      elements.diagStepCounter.textContent = isZh
        ? `第 ${currentPlayback.currentStep} / ${currentPlayback.trajectory.length} 步`
        : `Step ${currentPlayback.currentStep} / ${currentPlayback.trajectory.length}`;
    }
    if (elements.diagScrubber) {
      elements.diagScrubber.value = currentPlayback.currentStep;
    }
  }

  function setupHeatmapPlayback(diag) {
    currentPlayback.trajectory = diag.trajectory || [];
    currentPlayback.bounds = calculateHeatmapBounds(currentPlayback.trajectory);
    currentPlayback.currentStep = currentPlayback.trajectory.length;

    if (elements.diagScrubber) {
      elements.diagScrubber.min = 0;
      elements.diagScrubber.max = currentPlayback.trajectory.length;
      elements.diagScrubber.value = currentPlayback.currentStep;
      elements.diagScrubber.oninput = (e) => {
        stopPlayback();
        currentPlayback.currentStep = Number(e.target.value);
        updateHeatmapDisplay();
      };
    }

    if (elements.diagPlayBtn) {
      elements.diagPlayBtn.onclick = () => {
        if (currentPlayback.isPlaying) {
          stopPlayback();
        } else {
          if (currentPlayback.currentStep >= currentPlayback.trajectory.length) {
            currentPlayback.currentStep = 0;
          }
          currentPlayback.isPlaying = true;
          elements.diagPlayBtn.textContent = "⏸";
          currentPlayback.timer = setInterval(() => {
            if (currentPlayback.currentStep < currentPlayback.trajectory.length) {
              currentPlayback.currentStep += 1;
              updateHeatmapDisplay();
            } else {
              stopPlayback();
            }
          }, 60);
        }
      };
    }

    updateHeatmapDisplay();
  }

  function renderDetail(entry) {
    if (!elements.detail) return;
    if (!entry) {
      if (elements.detailEmpty) elements.detailEmpty.hidden = false;
      if (elements.detailContent) elements.detailContent.hidden = true;
      stopPlayback();
      return;
    }

    if (elements.detailEmpty) elements.detailEmpty.hidden = true;
    if (elements.detailContent) elements.detailContent.hidden = false;
    elements.detail.hidden = false;

    stopPlayback();
    currentPlayback.runId = entry.id;

    const modelTitle = entry.model_name || entry.model || "MODEL-NAME";
    if (elements.diagTitle) {
      elements.diagTitle.textContent = modelTitle.toUpperCase();
      elements.diagTitle.style.color = modelColor(entry.model_name);
    }
    if (elements.selectedName) {
      elements.selectedName.textContent = modelTitle;
      elements.selectedName.style.color = modelColor(entry.model_name);
    }

    if (elements.diagBadges) {
      const harnessText = entry.harness || entry.config_label || "LOCAL MCP";
      elements.diagBadges.innerHTML = `
        <span class="diag-badge diag-badge--cyan">ASCII</span>
        <span class="diag-badge diag-badge--emerald">NO TOOLS</span>
        <span class="diag-badge diag-badge--purple">${escapeText(harnessText.toUpperCase())}</span>
      `;
    }

    if (elements.diagRooms) elements.diagRooms.textContent = entry.room_count || 1;
    if (elements.diagGems) elements.diagGems.textContent = entry.gem_count || 0;
    if (elements.diagActions) {
      if (entry.is_time_limited && entry.duration_ms) {
        const mins = Math.round(Number(entry.duration_ms) / 60000);
        elements.diagActions.textContent = mins >= 1 ? `${mins}m limit` : `${Math.round(Number(entry.duration_ms) / 1000)}s limit`;
      } else {
        elements.diagActions.textContent = entry.max_actions || 256;
      }
    }
    if (elements.diagStatus) {
      const rawStatus = (entry.status || (entry.complete ? "FINISHED" : "ACTIVE")).toUpperCase();
      if (window.i18n?.isZh()) {
        const statusMap = {
          STOPPED: "已终止 (STOPPED)",
          FINISHED: "已完成 (FINISHED)",
          ACTIVE: "运行中 (ACTIVE)",
          RUNNING: "运行中 (RUNNING)",
          FAILED: "失败 (FAILED)"
        };
        elements.diagStatus.textContent = statusMap[rawStatus] || rawStatus;
      } else {
        elements.diagStatus.textContent = rawStatus;
      }
    }

    if (elements.selectedRooms) elements.selectedRooms.textContent = `${entry.room_count} / ${entry.room_total || 256}`;
    if (elements.selectedGems) elements.selectedGems.textContent = `${entry.gem_count} / ${entry.gem_total || 90}`;
    if (elements.selectedMoves) elements.selectedMoves.textContent = `${entry.moves ?? entry.turns ?? 0}`;
    if (elements.selectedActions) {
      if (entry.is_time_limited && entry.duration_ms) {
        const mins = Math.round(Number(entry.duration_ms) / 60000);
        elements.selectedActions.textContent = mins >= 1 ? `${mins}m limit` : `${Math.round(Number(entry.duration_ms) / 1000)}s limit`;
      } else {
        elements.selectedActions.textContent = `${entry.max_actions || 256}`;
      }
    }
    if (elements.selectedStatus) elements.selectedStatus.textContent = entry.status || (entry.complete ? "finished" : "active");

    if (elements.diagSourceLink) {
      elements.diagSourceLink.href = entry.url;
      elements.diagSourceLink.textContent = window.i18n?.t("lb_open_run") || "Open agent run →";
    }
    if (elements.sourceLink) elements.sourceLink.href = entry.url;

    if (elements.diagHeatmapContainer) {
      elements.diagHeatmapContainer.innerHTML = `<div class="diag-heatmap-placeholder"><span class="inline-spinner"></span></div>`;
    }

    fetch(`/api/agent/runs/${encodeURIComponent(entry.id)}/diagnostics`)
      .then((res) => (res.ok ? res.json() : null))
      .then((diag) => {
        if (!diag || currentPlayback.runId !== entry.id) return;
        if (elements.diagUniqueCells) {
          const count = diag.unique_cells || diag.trajectory?.length || 0;
          elements.diagUniqueCells.textContent = window.i18n?.isZh()
            ? `${count} 个独立单元格`
            : `${count} unique cells`;
        }
        drawMiniCharts(diag);
        setupHeatmapPlayback(diag);
      })
      .catch((err) => {
        console.warn("Failed to load run diagnostics:", err);
      });
  }

  function initLeaderboard() {
    wireFilters();
    updateFilterIndicators();
    void fetchLeaderboardData();
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", initLeaderboard);
  } else {
    initLeaderboard();
  }

  window.addEventListener("resize", () => {
    updateFilterIndicators();
  });

  function onLanguageSwitch() {
    if (window.i18n?.applyI18n) window.i18n.applyI18n();
    renderView();
    if (state.selectedId) {
      const entry = state.runs.find((r) => r.id === state.selectedId);
      if (entry) renderDetail(entry);
    }
  }

  document.addEventListener("languagechange", onLanguageSwitch);
  document.addEventListener("mazebench:langchange", onLanguageSwitch);

  // 暴露给外部刷新
  window.MazeBenchLeaderboard = {
    fetch: fetchLeaderboardData,
    render: renderView,
    state
  };
})();
