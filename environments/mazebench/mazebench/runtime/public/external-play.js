(function () {
  "use strict";

  const STORAGE_KEY_MINIMAL_MODE = "mazebench_spectator_minimal_mode";

  function readMinimalModeFromStorage() {
    try {
      return localStorage.getItem(STORAGE_KEY_MINIMAL_MODE) === "true";
    } catch (_) {
      return false;
    }
  }

  function writeMinimalModeToStorage(value) {
    try {
      localStorage.setItem(STORAGE_KEY_MINIMAL_MODE, value ? "true" : "false");
    } catch (_) {}
  }

  let viewerToken = null;
  let currentGenerationId = 0;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Simple in-browser SHA-256 for blob validation
  async function computeSha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // 1. Landing Page Logic
  function initLandingPage() {
    const form = document.getElementById("create-external-run-form");
    if (!form) return;

    const modeOptActions = document.getElementById("mode-opt-actions");
    const modeOptTime = document.getElementById("mode-opt-time");
    const fieldMaxActions = document.getElementById("field-max-actions");
    const fieldTimeLimit = document.getElementById("field-time-limit");
    const maxActionsInput = document.getElementById("ext-max-actions");
    const timeLimitInput = document.getElementById("ext-time-limit");
    const presetBtns = form.querySelectorAll(".preset-btn");
    const sessionTypeInputs = [...form.querySelectorAll('input[name="ext-session-type"]')];
    const groupCountField = document.getElementById("field-group-count");
    const groupCountInput = document.getElementById("ext-group-count");
    const statusText = document.getElementById("create-ext-status");
    const submitBtn = document.getElementById("create-ext-run-btn");

    let currentMode = "actions";
    let currentSessionType = "single";

    function isZh() {
      if (window.MazeBenchI18n && typeof window.MazeBenchI18n.getLanguage === "function") {
        return window.MazeBenchI18n.getLanguage() === "zh";
      }
      try {
        return localStorage.getItem("mazebench_lang") === "zh";
      } catch (_) {
        return true;
      }
    }

    function updateSessionTypeButtons(type) {
      sessionTypeInputs.forEach((input) => {
        const parentLabel = input.closest("label");
        if (!parentLabel) return;
        if (input.value === type) {
          parentLabel.classList.add("is-selected");
        } else {
          parentLabel.classList.remove("is-selected");
        }
      });
    }

    function getSubmitButtonText(type) {
      if (isZh()) {
        if (type === "single") return "创建并启动会话";
        if (type === "competition") return "创建同台竞技赛";
        return "创建多模型并发组";
      } else {
        if (type === "single") return "Create Armed Session";
        if (type === "competition") return "Create Competition";
        return "Create Concurrent Group";
      }
    }

    function setSessionType(type) {
      currentSessionType = type;
      updateSessionTypeButtons(type);
      if (groupCountField) groupCountField.hidden = type === "single";
      if (groupCountInput) groupCountInput.required = type !== "single";
      if (submitBtn) {
        submitBtn.textContent = getSubmitButtonText(type);
      }
    }

    sessionTypeInputs.forEach((input) => {
      input.addEventListener("change", () => setSessionType(input.value));
    });

    function setMode(mode) {
      currentMode = mode;
      if (mode === "actions") {
        if (modeOptActions) {
          modeOptActions.classList.add("is-selected");
          modeOptActions.style.background = "rgba(124, 58, 237, 0.2)";
          modeOptActions.style.borderColor = "#7c3aed";
        }
        if (modeOptTime) {
          modeOptTime.classList.remove("is-selected");
          modeOptTime.style.background = "rgba(30, 41, 59, 0.7)";
          modeOptTime.style.borderColor = "rgba(148, 163, 184, 0.2)";
        }
        if (fieldMaxActions) fieldMaxActions.style.display = "";
        if (fieldTimeLimit) fieldTimeLimit.style.display = "none";
        if (maxActionsInput) maxActionsInput.required = true;
        if (timeLimitInput) timeLimitInput.required = false;
      } else {
        if (modeOptTime) {
          modeOptTime.classList.add("is-selected");
          modeOptTime.style.background = "rgba(124, 58, 237, 0.2)";
          modeOptTime.style.borderColor = "#7c3aed";
        }
        if (modeOptActions) {
          modeOptActions.classList.remove("is-selected");
          modeOptActions.style.background = "rgba(30, 41, 59, 0.7)";
          modeOptActions.style.borderColor = "rgba(148, 163, 184, 0.2)";
        }
        if (fieldMaxActions) fieldMaxActions.style.display = "none";
        if (fieldTimeLimit) fieldTimeLimit.style.display = "";
        if (maxActionsInput) maxActionsInput.required = false;
        if (timeLimitInput) timeLimitInput.required = true;
      }
    }

    if (modeOptActions) {
      modeOptActions.addEventListener("click", () => setMode("actions"));
    }
    if (modeOptTime) {
      modeOptTime.addEventListener("click", () => setMode("time"));
    }

    presetBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const sec = btn.getAttribute("data-seconds");
        if (timeLimitInput && sec) {
          timeLimitInput.value = sec;
          presetBtns.forEach((b) => {
            b.style.background = "rgba(30, 41, 59, 0.8)";
            b.style.borderColor = "rgba(148, 163, 184, 0.3)";
            b.style.color = "#cbd5e1";
          });
          btn.style.background = "rgba(124, 58, 237, 0.25)";
          btn.style.borderColor = "#7c3aed";
          btn.style.color = "#c4b5fd";
        }
      });
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      statusText.textContent = isZh() ? "正在创建会话并启动..." : "Creating armed session...";

      try {
        const payload = {};
        if (currentSessionType !== "single") {
          payload.mode = currentSessionType;
          payload.count = parseInt(groupCountInput?.value, 10) || 2;
        }

        if (currentMode === "actions") {
          payload.max_actions = parseInt(maxActionsInput.value, 10) || 256;
        } else {
          const seconds = parseInt(timeLimitInput?.value, 10) || 120;
          payload.duration_ms = Math.max(60000, seconds * 1000);
        }

        const endpoint = currentSessionType === "single"
          ? "/api/external-play/runs"
          : "/api/external-play/groups";
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        statusText.textContent = isZh() ? "创建成功，正在跳转..." : "Created. Redirecting...";
        window.location.assign(currentSessionType === "single"
          ? `/external-play/${encodeURIComponent(data.run_id)}`
          : `/external-play/groups/${encodeURIComponent(data.group_id)}`);
      } catch (err) {
        statusText.textContent = (isZh() ? "创建失败: " : "Error: ") + err.message;
        submitBtn.disabled = false;
      }
    });
  }

  function initGroupPage() {
    let group = window.__EXTERNAL_PLAY_GROUP__;
    if (!group) return;

    function isZh() {
      if (window.MazeBenchI18n && typeof window.MazeBenchI18n.getLanguage === "function") {
        return window.MazeBenchI18n.getLanguage() === "zh";
      }
      try {
        return localStorage.getItem("mazebench_lang") === "zh";
      } catch (_) {
        return true;
      }
    }

    const status = document.getElementById("external-group-status");
    const claimCount = document.getElementById("external-group-claim-count");
    const entriesRoot = document.getElementById("external-group-entries");
    const rankingRoot = document.getElementById("external-group-ranking");
    const rankingSection = document.getElementById("external-group-ranking-section");
    const cancelButton = document.getElementById("cancel-external-group");
    let pollTimer = null;

    function renderEntry(entry) {
      const model = entry.model_name || (isZh() ? "等待模型连接" : "Waiting for model");
      const stats = isZh()
        ? `${entry.rooms_visited || 0} 房间 · ${entry.gems_collected || 0} 宝石 · ${entry.actions_total || 0} 步`
        : `${entry.rooms_visited || 0} rooms · ${entry.gems_collected || 0} gems · ${entry.actions_total || 0} actions`;
      const harnessText = entry.harness || (isZh() ? "MCP 客户端未连接" : "MCP client not connected");
      const replayText = isZh() ? "观战 / 回放" : "Watch / replay";
      return `<article class="external-group-entry">
        <div class="external-group-entry__head"><strong>${escapeHtml(model)}</strong><span class="status-pill status-pill--${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span></div>
        <p>${escapeHtml(harnessText)}</p>
        <p>${escapeHtml(stats)}</p>
        <a class="text-link" href="${escapeHtml(entry.replay_url)}">${escapeHtml(replayText)}</a>
      </article>`;
    }

    function renderRanking(ranking) {
      if (!rankingRoot || !rankingSection) return;
      if (!Array.isArray(ranking)) {
        rankingRoot.innerHTML = isZh()
          ? '<p class="muted">所有运行结束后将生成最终排名。</p>'
          : '<p class="muted">Ranking is finalized after every run ends.</p>';
        return;
      }
      rankingSection.hidden = false;
      rankingRoot.innerHTML = `<div class="external-ranking-table">${ranking.map((entry) => `
        <div class="external-ranking-row">
          <strong>#${entry.rank}</strong>
          <span>${escapeHtml(entry.model_name || entry.entry_id)}</span>
          <span>${entry.rooms_visited} ${isZh() ? "房间" : "rooms"}</span>
          <span>${entry.gems_collected} ${isZh() ? "宝石" : "gems"}</span>
          <span>${entry.actions_total} ${isZh() ? "步" : "actions"}</span>
        </div>`).join("")}</div>`;
    }

    function render() {
      const claimed = group.entries.filter((entry) => Boolean(entry.model_name || entry.started_at)).length;
      if (status) status.textContent = group.status;
      if (claimCount) {
        claimCount.textContent = isZh()
          ? `${claimed} / ${group.entries.length} 个模型已认领`
          : `${claimed} / ${group.entries.length} models claimed`;
      }
      if (entriesRoot) entriesRoot.innerHTML = group.entries.map(renderEntry).join("");
      if (group.mode === "competition") renderRanking(group.result?.ranking || null);
      if (cancelButton) cancelButton.hidden = group.status === "completed";
      if (group.status === "completed" && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    async function refresh() {
      try {
        const response = await fetch(`/api/external-play/groups/${encodeURIComponent(group.group_id)}`, { cache: "no-store" });
        if (response.ok) {
          group = await response.json();
          render();
        }
      } catch (_error) {}
    }

    if (cancelButton) {
      cancelButton.addEventListener("click", async () => {
        cancelButton.disabled = true;
        try {
          const response = await fetch(`/api/external-play/groups/${encodeURIComponent(group.group_id)}/cancel`, { method: "POST" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          group = await response.json();
          render();
        } finally {
          cancelButton.disabled = false;
        }
      });
    }

    render();
    if (group.status !== "completed") pollTimer = setInterval(refresh, 1000);
  }

  // 3. Spectator Page Logic
  async function initSpectatorPage() {
    const runData = window.__EXTERNAL_PLAY_RUN__;
    if (!runData || !runData.run_id) return;

    const runId = runData.run_id;
    const host = window.__MAZEBENCH_SPECTATOR_HOST__;

    const statusPill = document.getElementById("external-status-pill");
    const budgetElem = document.getElementById("spectator-budget");
    const budgetValElem = document.getElementById("spectator-budget-val");
    const roomsElem = document.getElementById("spectator-rooms-stat");
    const roomsValElem = document.getElementById("spectator-rooms-val");
    const gemsElem = document.getElementById("spectator-gems");
    const gemsValElem = document.getElementById("spectator-gems-val");
    const actionsElem = document.getElementById("spectator-actions");
    const actionsValElem = document.getElementById("spectator-actions-val");
    const roomElem = document.getElementById("spectator-room") || document.getElementById("spectator-room-stat");
    const roomValElem = document.getElementById("spectator-room-val");
    const controllerStatusElem = document.getElementById("controller-status");
    const cancelBtn = document.getElementById("cancel-run-btn");

    // Action Feed Elements
    const feedSidebar = document.getElementById("spectator-action-feed");
    const actionFeedList = document.getElementById("action-feed-list");
    const toggleFeedBtn = document.getElementById("toggle-feed-btn");

    const summaryOverlay = document.getElementById("summary-overlay");
    const summaryOutcomeBadge = document.getElementById("summary-outcome-badge");
    const summaryOutcome = document.getElementById("summary-outcome");
    const summaryElapsed = document.getElementById("summary-elapsed");
    const summaryActions = document.getElementById("summary-actions");
    const summaryGems = document.getElementById("summary-gems");
    const summaryRooms = document.getElementById("summary-rooms");
    const summaryCli = document.getElementById("summary-cli");
    const summaryReplayBtn = document.getElementById("summary-replay-btn");

    // Playback scrubber elements
    const scrubber = document.getElementById("playback-scrubber");
    const playBtn = document.getElementById("playback-play-btn");
    const prevBtn = document.getElementById("playback-prev-btn");
    const nextBtn = document.getElementById("playback-next-btn");
    const stepLabel = document.getElementById("playback-step-label");
    const liveBtn = document.getElementById("playback-live-btn");
    const minimalBtn = document.getElementById("playback-minimal-btn");

    let isMinimalMode = readMinimalModeFromStorage();

    function updateMinimalButtonUI(active) {
      if (!minimalBtn) return;
      minimalBtn.classList.toggle("is-active", active);
      minimalBtn.setAttribute("aria-pressed", active ? "true" : "false");
    }

    function applyMinimalModeToApp(app, minimalActive) {
      if (!app || !app.state || !app.state.effects) return;
      app.state.effects.fuzzyEnabled = !minimalActive;
      if (typeof app.syncNoiseTicker === "function") {
        app.syncNoiseTicker();
      }
      if (typeof app.render === "function") {
        app.render();
      } else if (typeof app.renderOncePerFrame === "function") {
        app.renderOncePerFrame();
      }
    }

    function syncAppMinimalMode() {
      const app = window.__MAZEBENCH_APP__;
      if (app) {
        applyMinimalModeToApp(app, isMinimalMode);
        return true;
      }
      return false;
    }

    // Read initial state on boot: if saved as "true", mark button as .is-active and aria-pressed="true"
    updateMinimalButtonUI(isMinimalMode);

    if (!syncAppMinimalMode()) {
      const appPollStart = Date.now();
      const appPollInterval = setInterval(() => {
        if (syncAppMinimalMode() || Date.now() - appPollStart > 10000) {
          clearInterval(appPollInterval);
        }
      }, 50);
    }

    let baseViewerState = null;
    let historyActions = [];
    let currentPlaybackStep = 0;
    let isLiveMode = true;
    let isPaused = false;
    let autoPlayInterval = null;
    let currentSummaryData = null;

    let eventLog = [];
    let actionQueue = [];
    let isProcessingQueue = false;
    let totalActions = 0;
    let gemCount = 0;
    let currentRoom = "level_HxI";
    let visitedRooms = new Set(["level_HxI"]);
    let isEnded = ["won", "action_limit", "timed_out", "cancelled", "failed", "ended"].includes(runData.status);
    let lastEventTimestamp = Date.now();
    let lastEventId = 0;
    let dynamicStepDelayMs = 200;
    let sseRetryCount = 0;

    function formatTool(tool) {
      const t = String(tool || "move").toLowerCase();
      if (t === "up") return { icon: "⬆️", name: "UP" };
      if (t === "down") return { icon: "⬇️", name: "DOWN" };
      if (t === "left") return { icon: "⬅️", name: "LEFT" };
      if (t === "right") return { icon: "➡️", name: "RIGHT" };
      if (t === "rotate_camera_up") return { icon: "🔼", name: "CAM_UP" };
      if (t === "rotate_camera_down") return { icon: "🔽", name: "CAM_DOWN" };
      if (t === "rotate_camera_left") return { icon: "🔄", name: "ROT_L" };
      if (t === "rotate_camera_right") return { icon: "🔄", name: "ROT_R" };
      if (t === "undo") return { icon: "↩️", name: "UNDO" };
      if (t === "reset") return { icon: "⏮️", name: "RESET" };
      if (t === "go_to_level") return { icon: "🚪", name: "GOTO" };
      if (t === "observe") return { icon: "👁️", name: "OBSERVE" };
      return { icon: "🎮", name: escapeText(tool).toUpperCase() };
    }

    function appendFeedItem(item, stepIndex) {
      if (!actionFeedList) return;
      const emptyTip = actionFeedList.querySelector(".feed-empty-tip");
      if (emptyTip) emptyTip.remove();

      const { icon, name } = formatTool(item.action);
      let statusHtml = '<span class="feed-item-status">✓</span>';
      if (item.observation?.gem_delta > 0 || (item.observation?.collected_gems_count !== undefined && item.observation.collected_gems_count > gemCount)) {
        statusHtml = '<span class="feed-item-status feed-item-status--gem">💎 Gem!</span>';
      } else if (item.action && item.action.startsWith("rotate")) {
        statusHtml = '<span class="feed-item-status">Cam</span>';
      }

      const feedItem = document.createElement("div");
      feedItem.className = "feed-item";
      feedItem.dataset.step = String(stepIndex);
      feedItem.innerHTML = `
        <div class="feed-item-left">
          <span class="feed-step-num">#${stepIndex}</span>
          <span>${icon}</span>
          <span class="feed-item-action">${name}</span>
        </div>
        ${statusHtml}
      `;

      feedItem.addEventListener("click", () => {
        isLiveMode = false;
        isPaused = true;
        stopAutoPlay();
        seekToStep(stepIndex);
      });

      actionFeedList.appendChild(feedItem);
      if (isLiveMode) {
        feedItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    function highlightFeedStep(stepIndex) {
      if (!actionFeedList) return;
      const items = actionFeedList.querySelectorAll(".feed-item");
      items.forEach((it) => {
        const itStep = parseInt(it.dataset.step, 10);
        const isCur = itStep === stepIndex;
        it.classList.toggle("is-current", isCur);
        if (isCur) {
          it.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
    }

    function updateStatsUI(roomsCount, roomName, gems, actions) {
      if (roomsValElem) {
        roomsValElem.textContent = String(roomsCount);
      } else if (roomsElem) {
        roomsElem.innerHTML = `🏛️ <strong>${escapeText(roomsCount)}</strong>`;
      }
      if (roomValElem) {
        roomValElem.textContent = String(roomName);
      } else if (roomElem) {
        roomElem.innerHTML = `🚪 <strong>${escapeText(roomName)}</strong>`;
      }
      if (gemsValElem) {
        gemsValElem.textContent = String(gems);
      } else if (gemsElem) {
        gemsElem.innerHTML = `💎 <strong>${escapeText(gems)}</strong>`;
      }
      if (actionsValElem) {
        actionsValElem.textContent = String(actions);
      } else if (actionsElem) {
        actionsElem.innerHTML = `👟 <strong>${escapeText(actions)}</strong>`;
      }
    }

    function updateScrubberUI() {
      const maxSteps = historyActions.length;
      const isZh = Boolean(window.i18n?.isZh ? window.i18n.isZh() : window.MazeBenchI18n?.isZh?.());
      if (scrubber) {
        scrubber.max = String(maxSteps);
        scrubber.value = String(currentPlaybackStep);
      }
      if (stepLabel) {
        const stepText = isZh ? "步数" : "Step";
        stepLabel.innerHTML = `${stepText}: <strong>${currentPlaybackStep} / ${maxSteps}</strong>`;
      }
      if (liveBtn) {
        liveBtn.classList.toggle("is-active", isLiveMode);
        liveBtn.textContent = isZh ? "🔴 实时" : "🔴 Live";
      }
      if (playBtn) {
        playBtn.textContent = isPaused ? (isZh ? "▶️ 播放" : "▶️ Play") : (isZh ? "⏸️ 暂停" : "⏸️ Pause");
      }
      if (prevBtn) {
        prevBtn.disabled = currentPlaybackStep <= 0;
      }
      if (nextBtn) {
        nextBtn.disabled = currentPlaybackStep >= maxSteps;
      }
      highlightFeedStep(currentPlaybackStep);
    }

    async function seekToStep(targetStep) {
      const clamped = Math.max(0, Math.min(historyActions.length, targetStep));
      currentPlaybackStep = clamped;
      updateScrubberUI();

      if (!host) return;

      if (clamped === 0) {
        if (baseViewerState) {
          await host.applySnapshot(baseViewerState);
          currentRoom = baseViewerState.current_room || "level_HxI";
        }
        gemCount = 0;
        updateStatsUI(1, currentRoom, 0, 0);
        return;
      }

      const targetAction = historyActions[clamped - 1];
      if (targetAction) {
        if (targetAction.post_viewer_state) {
          await host.applySnapshot(targetAction.post_viewer_state);
        } else if (targetAction.transition?.keyframes?.[1]?.viewer_state) {
          await host.applySnapshot(targetAction.transition.keyframes[1].viewer_state);
        }

        const roomName = targetAction.post_viewer_state?.current_room
          || targetAction.transition?.world_transition?.target_room
          || targetAction.observation?.current_room;
        if (roomName) {
          currentRoom = roomName;
          visitedRooms.add(roomName);
        }

        if (targetAction.observation) {
          const obs = targetAction.observation;
          if (obs.collected_gems_count !== undefined) {
            gemCount = obs.collected_gems_count;
          } else if (obs.gem_count !== undefined) {
            gemCount = obs.gem_count;
          }
        }

        updateStatsUI(visitedRooms.size, currentRoom, gemCount, clamped);
      }
    }

    if (toggleFeedBtn && feedSidebar) {
      toggleFeedBtn.addEventListener("click", () => {
        const isCollapsed = feedSidebar.classList.toggle("is-collapsed");
        toggleFeedBtn.textContent = isCollapsed ? "◀" : "▶";
        toggleFeedBtn.title = isCollapsed ? "Expand Feed" : "Collapse Feed";
      });
    }

    function stopAutoPlay() {
      if (autoPlayInterval) {
        clearInterval(autoPlayInterval);
        autoPlayInterval = null;
      }
    }

    function startAutoPlay() {
      stopAutoPlay();
      autoPlayInterval = setInterval(async () => {
        if (currentPlaybackStep < historyActions.length) {
          await seekToStep(currentPlaybackStep + 1);
        } else {
          stopAutoPlay();
          isPaused = true;
          if (isEnded) isLiveMode = false;
          updateScrubberUI();
        }
      }, 250);
    }

    function togglePlayPause() {
      if (isPaused) {
        isPaused = false;
        if (currentPlaybackStep >= historyActions.length) {
          seekToStep(0).then(() => startAutoPlay());
        } else {
          startAutoPlay();
        }
      } else {
        isPaused = true;
        stopAutoPlay();
      }
      updateScrubberUI();
    }

    if (scrubber) {
      scrubber.addEventListener("input", (e) => {
        isLiveMode = false;
        isPaused = true;
        stopAutoPlay();
        seekToStep(parseInt(e.target.value, 10));
      });
    }

    if (playBtn) {
      playBtn.addEventListener("click", () => {
        togglePlayPause();
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        isLiveMode = false;
        isPaused = true;
        stopAutoPlay();
        seekToStep(currentPlaybackStep - 1);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        stopAutoPlay();
        seekToStep(currentPlaybackStep + 1);
        if (currentPlaybackStep >= historyActions.length) {
          isLiveMode = true;
          isPaused = false;
        }
        updateScrubberUI();
      });
    }

    if (liveBtn) {
      liveBtn.addEventListener("click", () => {
        isLiveMode = true;
        isPaused = false;
        stopAutoPlay();
        seekToStep(historyActions.length);
      });
    }

    if (minimalBtn) {
      minimalBtn.addEventListener("click", () => {
        isMinimalMode = !isMinimalMode;
        updateMinimalButtonUI(isMinimalMode);
        writeMinimalModeToStorage(isMinimalMode);
        const app = window.__MAZEBENCH_APP__;
        if (app) {
          applyMinimalModeToApp(app, isMinimalMode);
        }
      });
    }

    const hudElem = document.getElementById("spectator-overlay-hud");
    const toggleHudBtn = document.getElementById("toggle-hud-btn");
    if (toggleHudBtn && hudElem) {
      toggleHudBtn.addEventListener("click", () => {
        const isCollapsed = hudElem.classList.toggle("is-collapsed");
        toggleHudBtn.textContent = isCollapsed ? "🔼" : "🔽";
        toggleHudBtn.title = isCollapsed ? "Expand HUD" : "Collapse HUD";
      });
    }

    function formatTimeRemaining(ms) {
      if (ms <= 0) return "0s left";
      const totalSec = Math.ceil(ms / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      if (m > 0) {
        return `${m}:${s.toString().padStart(2, "0")} left`;
      }
      return `${s}s left`;
    }

    // Action budget and controller liveness display.
    function updateRunStatus() {
      if (isEnded) return;

      const isTimeLimited = !runData.max_actions && (runData.duration_ms || runData.deadline_at);

      if (!runData.started_at) {
        if (budgetValElem) {
          if (isTimeLimited) {
            const sec = Math.round((Number(runData.duration_ms) || 120000) / 1000);
            budgetValElem.textContent = `Waiting for MCP (${sec}s limit)`;
          } else {
            budgetValElem.textContent = "Waiting for MCP";
          }
        }
        return;
      }

      const now = Date.now();

      if (isTimeLimited) {
        const deadline = runData.deadline_at
          ? Date.parse(runData.deadline_at)
          : Date.parse(runData.started_at) + (Number(runData.duration_ms) || 120000);
        const remainingMs = Math.max(0, deadline - now);
        if (budgetValElem) {
          budgetValElem.textContent = formatTimeRemaining(remainingMs);
        }
        if (budgetElem) {
          budgetElem.style.color = remainingMs <= 10000 ? "#f87171" : "";
        }
      } else {
        const maxActions = Number(runData.max_actions) || 256;
        const remainingActions = Math.max(0, maxActions - totalActions);
        if (budgetValElem) {
          budgetValElem.textContent = `${remainingActions} actions left`;
        }
        if (budgetElem) {
          budgetElem.style.color = remainingActions <= 0 ? "#f87171" : "";
        }
      }

      // Controller heartbeat check
      if (now - lastEventTimestamp > 32000) {
        controllerStatusElem.textContent = "Controller: Inactive";
        controllerStatusElem.className = "spectator-badge controller-badge is-disconnected";
      }
    }

    const statusInterval = setInterval(updateRunStatus, 1000);

    // Cancel Button
    if (cancelBtn) {
      cancelBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to cancel this External Play session?")) return;
        try {
          const res = await fetch(`/api/external-play/runs/${encodeURIComponent(runId)}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
          }
        } catch (err) {
          alert(`Failed to cancel run: ${err.message}`);
        }
      });
    }

    // Action execution with dynamic step time calibration
    async function processActionQueue(genId) {
      if (isProcessingQueue || actionQueue.length === 0) return;
      isProcessingQueue = true;

      try {
        while (actionQueue.length > 0) {
          if (genId !== undefined && genId !== currentGenerationId) {
            return;
          }

          const item = actionQueue.shift();
          const isImmediate = isEnded || item.immediate === true;

          // Calibrate step delay: if ended or behind queue, speed up smoothly
          if (isImmediate) {
            dynamicStepDelayMs = 0;
          } else if (actionQueue.length > 10) {
            dynamicStepDelayMs = 20;
          } else if (actionQueue.length > 5) {
            dynamicStepDelayMs = 60;
          } else if (actionQueue.length > 2) {
            dynamicStepDelayMs = 120;
          } else {
            dynamicStepDelayMs = 220;
          }

          if (host && item.action && (isLiveMode || isImmediate)) {
            try {
              await host.applyAction(item.action, item.transition, item.post_viewer_state, { immediate: isImmediate });
            } catch (err) {
              console.warn("Error applying action in host:", err);
            }
          }

          const roomName = item.post_viewer_state?.current_room || item.transition?.world_transition?.target_room || item.observation?.current_room;
          if (roomName) {
            currentRoom = roomName;
            visitedRooms.add(roomName);
          }

          if (item.observation) {
            if (item.observation.collected_gems_count !== undefined) {
              gemCount = item.observation.collected_gems_count;
            } else if (item.observation.gem_count !== undefined) {
              gemCount = item.observation.gem_count;
            }
          }

          totalActions++;
          if (isLiveMode || isImmediate) {
            currentPlaybackStep = totalActions;
            updateStatsUI(visitedRooms.size, currentRoom, gemCount, totalActions);
          }
          updateScrubberUI();

          if (dynamicStepDelayMs > 0 && !isImmediate) {
            await new Promise((resolve) => setTimeout(resolve, dynamicStepDelayMs));
          }
        }
      } finally {
        isProcessingQueue = false;
      }
    }

    function escapeText(str) {
      return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Obtain Viewer Token
    async function obtainViewerToken() {
      try {
        const res = await fetch(`/api/external-play/runs/${encodeURIComponent(runId)}/viewer-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        if (res.ok) {
          const data = await res.json();
          viewerToken = data.viewer_token;
        }
      } catch (err) {
        console.warn("Failed to acquire viewer token:", err);
      }
    }

    // Fetch, verify hash and validate schema for blob
    async function fetchAndVerifyBlob(digest, kind = "transition") {
      if (!digest) return null;
      try {
        const authHeaders = viewerToken ? { Authorization: `Bearer ${viewerToken}` } : {};
        const res = await fetch(`/api/external-play/runs/${encodeURIComponent(runId)}/blobs/${digest}`, {
          headers: authHeaders
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching blob ${digest}`);
        const text = await res.text();
        const computed = await computeSha256Hex(text);
        if (computed.toLowerCase() !== digest.toLowerCase()) {
          throw new Error(`Blob digest mismatch: expected ${digest}, got ${computed}`);
        }
        const parsed = JSON.parse(text);
        if (window.Validators) {
          if (kind === "transition" && typeof window.Validators.validateViewerTransition === "function") {
            if (!window.Validators.validateViewerTransition(parsed)) {
              throw new Error("Invalid viewer_transition schema");
            }
          } else if (kind === "viewer_state" && typeof window.Validators.validateViewerState === "function") {
            if (!window.Validators.validateViewerState(parsed)) {
              throw new Error("Invalid viewer_state schema");
            }
          }
        } else {
          if (kind === "transition") {
            if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.keyframes) || !parsed.type) {
              throw new Error("Invalid transition schema");
            }
          } else if (kind === "viewer_state") {
            if (!parsed || parsed.v !== 1 || !parsed.current_room || !parsed.player || !Array.isArray(parsed.actors) || !Array.isArray(parsed.gems)) {
              throw new Error("Invalid viewer_state schema");
            }
          }
        }
        return parsed;
      } catch (e) {
        console.warn("Failed to fetch or parse blob:", e);
        return null;
      }
    }

    // Expose the same read-only verification path used by catch-up/SSE so the
    // local observability UI and browser E2E can diagnose content-addressed
    // replay failures without exposing the viewer token itself.
    window.__MAZEBENCH_EXTERNAL_PLAY_DEBUG__ = Object.freeze({ fetchAndVerifyBlob });

    // Load Initial Snapshot and catch up all actions
    async function loadSnapshotAndCatchUp() {
      const myGen = ++currentGenerationId;
      await obtainViewerToken();

      const authHeaders = viewerToken ? { Authorization: `Bearer ${viewerToken}` } : {};

      try {
        const snapRes = await fetch(`/api/external-play/runs/${encodeURIComponent(runId)}/snapshot`, {
          headers: authHeaders
        });
        if (!snapRes.ok) return;

        const snapshot = await snapRes.json();
        if (myGen !== currentGenerationId) return;

        lastEventId = snapshot.as_of_event_id || 0;
        totalActions = 0;
        actionQueue = [];
        eventLog = [];

        // Save base viewer state
        if (snapshot.base_viewer_state) {
          baseViewerState = snapshot.base_viewer_state;
        }

        // Sync lifecycle and action budget.
        if (snapshot.started_at) runData.started_at = snapshot.started_at;
        if (snapshot.max_actions) runData.max_actions = snapshot.max_actions;
        if (snapshot.duration_ms) runData.duration_ms = snapshot.duration_ms;
        if (snapshot.deadline_at) runData.deadline_at = snapshot.deadline_at;
        if (snapshot.status === "active") {
          statusPill.textContent = "ACTIVE";
          statusPill.className = "status-pill status-pill--running";
        }
        updateRunStatus();

        // Apply initial base viewer state to 3D scene
        if (baseViewerState && host) {
          await host.applySnapshot(baseViewerState);
        }

        // Catch up all historical actions up to the exact snapshot.action_seq watermark
        const snapshotActionSeq = Number(snapshot.action_seq) || 0;
        let nextFromSeq = 1;
        while (nextFromSeq <= snapshotActionSeq) {
          if (myGen !== currentGenerationId) return;
          const actionsRes = await fetch(
            `/api/external-play/runs/${encodeURIComponent(runId)}/actions?from_seq=${nextFromSeq}&to_seq=${snapshotActionSeq}&limit=100`,
            { headers: authHeaders }
          );
          if (!actionsRes.ok) break;

          const actData = await actionsRes.json();
          const list = actData.actions || [];
          if (list.length === 0) break;

          for (const act of list) {
            let transition = act.viewer_transition;
            if (!transition && act.transition_digest) {
              transition = await fetchAndVerifyBlob(act.transition_digest, "transition");
            }
            if (!act.post_viewer_state && act.post_viewer_state_digest) {
              act.post_viewer_state = await fetchAndVerifyBlob(act.post_viewer_state_digest, "viewer_state");
            }

            const item = {
              seq: act.seq,
              action: act.tool,
              transition,
              post_viewer_state: act.post_viewer_state,
              observation: act.sanitized_status,
              immediate: true
            };
            historyActions.push(item);
            actionQueue.push(item);
            appendFeedItem(item, historyActions.length);
            eventLog.push({ type: "action", ...act, viewer_transition: transition });
          }

          if (actData.has_more) {
            if (actData.next_seq) {
              nextFromSeq = actData.next_seq;
            } else {
              nextFromSeq = list[list.length - 1].seq + 1;
            }
          } else {
            break;
          }
        }

        if (myGen !== currentGenerationId) return;

        // Process and drain all caught-up actions immediately to sync 3D position
        await processActionQueue(myGen);
        while (actionQueue.length > 0 || isProcessingQueue) {
          await new Promise((r) => setTimeout(r, 20));
        }
        currentPlaybackStep = historyActions.length;
        updateStatsUI(visitedRooms.size, currentRoom, gemCount, totalActions);
        updateScrubberUI();

        // Check if run is in a terminal state
        if (["won", "action_limit", "timed_out", "cancelled", "failed"].includes(snapshot.status)) {
          isEnded = true;
          statusPill.textContent = snapshot.status.toUpperCase();
          statusPill.className = "status-pill status-pill--ended";

          await showSummaryModal();
          return;
        }

        // For non-terminal running state, connect SSE stream for live actions
        startSSEStream(myGen);
      } catch (err) {
        console.warn("Catch-up failed:", err);
        if (myGen === currentGenerationId) {
          setTimeout(loadSnapshotAndCatchUp, 2000);
        }
      }
    }

    // Stream SSE using fetch() and ReadableStream with named event handling
    async function startSSEStream(genId) {
      if (genId !== undefined && genId !== currentGenerationId) return;

      const authHeaders = viewerToken ? { Authorization: `Bearer ${viewerToken}` } : {};
      const url = `/api/external-play/runs/${encodeURIComponent(runId)}/events?after_event_id=${lastEventId}`;

      try {
        const response = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
            ...authHeaders
          }
        });

        if (response.status === 409 || response.status === 410) {
          // Gap detected or desynced: full snapshot catch-up
          console.warn("SSE stream desynced (gap), triggering catch-up...");
          loadSnapshotAndCatchUp();
          return;
        }

        if (!response.ok) {
          if (controllerStatusElem) {
            controllerStatusElem.textContent = "Stream Reconnecting...";
            controllerStatusElem.className = "spectator-badge controller-badge is-disconnected";
          }
          const delay = Math.min(5000, 500 * Math.pow(1.5, sseRetryCount++));
          setTimeout(() => startSSEStream(genId), delay);
          return;
        }

        sseRetryCount = 0;
        if (controllerStatusElem) {
          controllerStatusElem.textContent = "Live Stream Connected";
          controllerStatusElem.className = "spectator-badge controller-badge is-connected";
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          if (genId !== undefined && genId !== currentGenerationId) {
            reader.cancel();
            return;
          }

          const { value, done } = await reader.read();
          if (done) {
            // Normal stream close (EOF): reconnect if not ended
            if (!isEnded && (genId === undefined || genId === currentGenerationId)) {
              if (controllerStatusElem) {
                controllerStatusElem.textContent = "Stream Reconnecting...";
                controllerStatusElem.className = "spectator-badge controller-badge is-disconnected";
              }
              const delay = Math.min(5000, 500 * Math.pow(1.5, sseRetryCount++));
              setTimeout(() => startSSEStream(genId), delay);
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop(); // keep remainder

          for (const block of parts) {
            if (!block.trim()) continue;
            if (block.startsWith(":")) {
              lastEventTimestamp = Date.now();
              if (controllerStatusElem && !isEnded) {
                controllerStatusElem.textContent = "Live Stream Connected";
                controllerStatusElem.className = "spectator-badge controller-badge is-connected";
              }
              continue;
            }

            const lines = block.split("\n");
            let eventType = "message";
            let eventDataStr = "";
            let eventId = null;

            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                eventDataStr += line.slice(5).trim();
              } else if (line.startsWith("id:")) {
                eventId = parseInt(line.slice(3).trim(), 10);
              }
            }

            if (eventId !== null) {
              if (eventId <= lastEventId) continue; // idempotent duplicate drop
              lastEventId = eventId;
            }

            lastEventTimestamp = Date.now();
            if (controllerStatusElem && !isEnded) {
              controllerStatusElem.textContent = "Live Stream Connected";
              controllerStatusElem.className = "spectator-badge controller-badge is-connected";
            }

            if (eventDataStr) {
              try {
                const record = JSON.parse(eventDataStr);
                eventLog.push(record);
                await handleSSEMessage(eventType, record, genId);
              } catch (e) {
                console.warn("Failed to parse SSE payload:", e);
              }
            }
          }
        }
      } catch (err) {
        if (controllerStatusElem) {
          controllerStatusElem.textContent = "Stream Disconnected";
          controllerStatusElem.className = "spectator-badge controller-badge is-disconnected";
        }
        if (!isEnded && (genId === undefined || genId === currentGenerationId)) {
          const delay = Math.min(5000, 500 * Math.pow(1.5, sseRetryCount++));
          setTimeout(() => startSSEStream(genId), delay);
        }
      }
    }

    async function handleSSEMessage(type, record, genId) {
      if (type === "started" || record.type === "started") {
        if (record.started_at) runData.started_at = record.started_at;
        if (record.max_actions) runData.max_actions = record.max_actions;
        if (record.duration_ms) runData.duration_ms = record.duration_ms;
        if (record.deadline_at) runData.deadline_at = record.deadline_at;
        statusPill.textContent = "ACTIVE";
        statusPill.className = "status-pill status-pill--running";
        controllerStatusElem.textContent = "Live Stream Connected";
        controllerStatusElem.className = "spectator-badge controller-badge is-connected";
        updateRunStatus();
      } else if (type === "action" || record.type === "action") {
        let transition = record.action_record?.viewer_transition || record.transition;
        if (!transition && record.action_record?.transition_digest) {
          transition = await fetchAndVerifyBlob(record.action_record.transition_digest);
        }
        let postViewerState = record.action_record?.post_viewer_state || null;
        if (!postViewerState && record.action_record?.post_viewer_state_digest) {
          postViewerState = await fetchAndVerifyBlob(
            record.action_record.post_viewer_state_digest,
            "viewer_state"
          );
        }
        if (record.action_record) {
          record.action_record.viewer_transition = transition;
          record.action_record.post_viewer_state = postViewerState;
        }

        const item = {
          seq: record.action_seq,
          action: record.tool || record.action,
          transition,
          post_viewer_state: postViewerState,
          observation: record.action_record?.sanitized_status || record.observation
        };
        historyActions.push(item);
        actionQueue.push(item);
        appendFeedItem(item, historyActions.length);
        updateScrubberUI();
        processActionQueue(genId);
      } else if (type === "ended" || record.type === "ended") {
        isEnded = true;
        statusPill.textContent = (record.outcome || "ENDED").toUpperCase();
        statusPill.className = "status-pill status-pill--ended";

        // Wait for Live FIFO animation queue to completely drain before showing summary
        while (actionQueue.length > 0 || isProcessingQueue) {
          await new Promise((r) => setTimeout(r, 50));
        }

        await showSummaryModal(record.summary);
      }
    }

    // Show Summary Modal
    async function showSummaryModal(initialSummary) {
      let summary = initialSummary;
      if (!summary) {
        try {
          const authHeaders = viewerToken ? { Authorization: `Bearer ${viewerToken}` } : {};
          const res = await fetch(`/api/external-play/runs/${encodeURIComponent(runId)}/summary`, {
            headers: authHeaders
          });
          if (res.ok) summary = await res.json();
        } catch (_e) {}
      }

      if (!summary) {
        summary = {
          outcome: runData.status || "CANCELLED",
          elapsed_seconds: runData.started_at ? Math.max(0, Math.round((Date.now() - Date.parse(runData.started_at)) / 1000)) : 0,
          actions_total: totalActions,
          gems_collected: gemCount,
          rooms_visited: 1,
          declared_cli: runData.declared_cli || "browser-test-cli"
        };
      }

      currentSummaryData = summary;
      const rawOutcome = (summary.outcome || summary.status || "ENDED").toLowerCase();
      const outcomeKey = `outcome_${rawOutcome}`;
      const translatedOutcome = window.i18n?.t ? window.i18n.t(outcomeKey, rawOutcome.toUpperCase()) : (window.MazeBenchI18n?.t ? window.MazeBenchI18n.t(outcomeKey, rawOutcome.toUpperCase()) : rawOutcome.toUpperCase());
      summaryOutcomeBadge.textContent = translatedOutcome;
      summaryOutcomeBadge.className = `badge badge--${rawOutcome}`;
      summaryOutcome.textContent = translatedOutcome;

      const durationSec = summary.elapsed_seconds || 0;
      summaryElapsed.textContent = `${durationSec}s`;
      summaryActions.textContent = summary.actions_total ?? summary.action_count ?? totalActions;
      summaryGems.textContent = summary.gems_collected ?? gemCount;
      summaryRooms.textContent = summary.rooms_visited ?? (summary.route ? summary.route.length : 1);
      summaryCli.textContent = summary.declared_cli || "browser-test-cli";

      console.log("[Spectator] Showing summary modal with outcome:", outcomeKey, translatedOutcome);
      summaryOverlay.removeAttribute("hidden");
      summaryOverlay.hidden = false;
      summaryOverlay.style.display = "flex";
      const summaryBarBtn = document.getElementById("playback-summary-btn");
      if (summaryBarBtn) {
        summaryBarBtn.removeAttribute("hidden");
        summaryBarBtn.hidden = false;
        summaryBarBtn.style.display = "inline-flex";
      }
      if (window.i18n?.applyI18n) {
        window.i18n.applyI18n();
      } else if (window.MazeBenchI18n?.applyI18n) {
        window.MazeBenchI18n.applyI18n();
      }
    }

    function dismissSummaryModal() {
      summaryOverlay.hidden = true;
      summaryOverlay.style.display = "none";
      isLiveMode = false;
      isPaused = true;
      updateScrubberUI();
    }

    const summaryDismissBtn = document.getElementById("summary-dismiss-btn");
    if (summaryDismissBtn) {
      summaryDismissBtn.addEventListener("click", dismissSummaryModal);
    }
    const summaryCloseBtn = document.getElementById("summary-close-btn");
    if (summaryCloseBtn) {
      summaryCloseBtn.addEventListener("click", dismissSummaryModal);
    }
    const summaryBarBtn = document.getElementById("playback-summary-btn");
    if (summaryBarBtn) {
      summaryBarBtn.addEventListener("click", () => {
        summaryOverlay.removeAttribute("hidden");
        summaryOverlay.hidden = false;
        summaryOverlay.style.display = "flex";
        if (window.i18n?.applyI18n) {
          window.i18n.applyI18n();
        } else if (window.MazeBenchI18n?.applyI18n) {
          window.MazeBenchI18n.applyI18n();
        }
      });
    }

    document.addEventListener("languagechange", () => {
      updateScrubberUI();
      if (currentSummaryData) {
        const rawOutcome = (currentSummaryData.outcome || currentSummaryData.status || "ENDED").toLowerCase();
        const outcomeKey = `outcome_${rawOutcome}`;
        const translatedOutcome = window.i18n?.t ? window.i18n.t(outcomeKey, rawOutcome.toUpperCase()) : (window.MazeBenchI18n?.t ? window.MazeBenchI18n.t(outcomeKey, rawOutcome.toUpperCase()) : rawOutcome.toUpperCase());
        summaryOutcomeBadge.textContent = translatedOutcome;
        summaryOutcome.textContent = translatedOutcome;
      }
    });
    if (summaryOverlay) {
      summaryOverlay.addEventListener("click", (e) => {
        if (e.target === summaryOverlay) {
          dismissSummaryModal();
        }
      });
    }

    if (summaryReplayBtn) {
      summaryReplayBtn.addEventListener("click", () => {
        summaryOverlay.hidden = true;
        summaryOverlay.style.display = "none";
        isLiveMode = false;
        isPaused = false;
        seekToStep(0).then(() => {
          startAutoPlay();
        });
      });
    }

    // Kickoff initial catch-up and SSE connection
    await loadSnapshotAndCatchUp();
  }

  // Initialization
  async function startup() {
    initLandingPage();
    initGroupPage();
    await initSpectatorPage();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startup);
  } else {
    startup();
  }
})();
