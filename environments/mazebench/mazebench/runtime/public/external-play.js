(function () {
  "use strict";

  let viewerToken = null;
  let currentGenerationId = 0;

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

    const durationInput = document.getElementById("ext-duration-min");
    const winThresholdInput = document.getElementById("ext-win-threshold");
    const modelNameInput = document.getElementById("ext-model-name");
    const harnessNameInput = document.getElementById("ext-harness-name");
    const statusText = document.getElementById("create-ext-status");
    const submitBtn = document.getElementById("create-ext-run-btn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      statusText.textContent = "Creating armed session...";

      try {
        const durationMin = parseInt(durationInput.value, 10) || 30;
        const winThreshold = parseInt(winThresholdInput.value, 10) || 10;
        const duration_ms = durationMin * 60000;
        const model_name = modelNameInput?.value?.trim() || undefined;
        const harness_name = harnessNameInput?.value?.trim() || undefined;

        const res = await fetch("/api/external-play/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duration_ms,
            win_threshold: winThreshold,
            model_name,
            harness_name
          })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        statusText.textContent = "Session created! Redirecting...";
        window.location.assign(`/external-play/${encodeURIComponent(data.run_id)}`);
      } catch (err) {
        statusText.textContent = `Error: ${err.message}`;
        submitBtn.disabled = false;
      }
    });
  }

  // 3. Spectator Page Logic
  async function initSpectatorPage() {
    const runData = window.__EXTERNAL_PLAY_RUN__;
    if (!runData || !runData.run_id) return;

    const runId = runData.run_id;
    const host = window.__MAZEBENCH_SPECTATOR_HOST__;

    const statusPill = document.getElementById("external-status-pill");
    const timerElem = document.getElementById("spectator-timer");
    const timerValElem = document.getElementById("spectator-timer-val");
    const roomsElem = document.getElementById("spectator-rooms-stat");
    const roomsValElem = document.getElementById("spectator-rooms-val");
    const gemsElem = document.getElementById("spectator-gems");
    const gemsValElem = document.getElementById("spectator-gems-val");
    const actionsElem = document.getElementById("spectator-actions");
    const actionsValElem = document.getElementById("spectator-actions-val");
    const roomElem = document.getElementById("spectator-room-stat");
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

    let baseViewerState = null;
    let historyActions = [];
    let currentPlaybackStep = 0;
    let isLiveMode = true;
    let isPaused = false;
    let autoPlayInterval = null;

    let eventLog = [];
    let actionQueue = [];
    let isProcessingQueue = false;
    let totalActions = 0;
    let gemCount = 0;
    let currentRoom = "level_HxI";
    let visitedRooms = new Set(["level_HxI"]);
    let isEnded = ["won", "timed_out", "cancelled", "failed", "ended"].includes(runData.status);
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
      if (scrubber) {
        scrubber.max = String(maxSteps);
        scrubber.value = String(currentPlaybackStep);
      }
      if (stepLabel) {
        stepLabel.innerHTML = `Step: <strong>${currentPlaybackStep} / ${maxSteps}</strong>`;
      }
      if (liveBtn) {
        liveBtn.classList.toggle("is-active", isLiveMode);
      }
      if (playBtn) {
        playBtn.textContent = isPaused ? "▶️ Play" : "⏸️ Pause";
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

    const hudElem = document.getElementById("spectator-overlay-hud");
    const toggleHudBtn = document.getElementById("toggle-hud-btn");
    if (toggleHudBtn && hudElem) {
      toggleHudBtn.addEventListener("click", () => {
        const isCollapsed = hudElem.classList.toggle("is-collapsed");
        toggleHudBtn.textContent = isCollapsed ? "🔼" : "🔽";
        toggleHudBtn.title = isCollapsed ? "Expand HUD" : "Collapse HUD";
      });
    }

    // Timer loop
    function updateTimer() {
      if (isEnded) return;

      if (!runData.started_at) {
        if (timerElem) timerElem.innerHTML = `⏱️ <strong id="spectator-timer-val">Waiting for MCP</strong>`;
        return;
      }

      const now = Date.now();
      const started = new Date(runData.started_at).getTime();
      const deadline = runData.deadline_at ? new Date(runData.deadline_at).getTime() : started + (runData.duration_ms || 1800000);
      const remainingMs = Math.max(0, deadline - now);

      const mins = Math.floor(remainingMs / 60000);
      const secs = Math.floor((remainingMs % 60000) / 1000);
      const timeStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

      if (remainingMs <= 0) {
        if (timerElem) {
          timerElem.innerHTML = `⏱️ <strong id="spectator-timer-val">00:00</strong>`;
          timerElem.style.color = "#f87171";
        }
      } else {
        if (timerElem) {
          timerElem.innerHTML = `⏱️ <strong id="spectator-timer-val">${timeStr}</strong>`;
        }
      }

      // Controller heartbeat check
      if (now - lastEventTimestamp > 32000) {
        controllerStatusElem.textContent = "Controller: Inactive";
        controllerStatusElem.className = "spectator-badge controller-badge is-disconnected";
      }
    }

    const timerInterval = setInterval(updateTimer, 250);

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

        // Sync lifecycle & timer timestamps
        if (snapshot.started_at) runData.started_at = snapshot.started_at;
        if (snapshot.deadline_at) runData.deadline_at = snapshot.deadline_at;
        if (snapshot.duration_ms) runData.duration_ms = snapshot.duration_ms;
        if (snapshot.status === "active") {
          statusPill.textContent = "ACTIVE";
          statusPill.className = "status-pill status-pill--running";
        }
        updateTimer();

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
        if (["won", "timed_out", "cancelled", "failed"].includes(snapshot.status)) {
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
        if (record.deadline_at) runData.deadline_at = record.deadline_at;
        if (record.duration_ms) runData.duration_ms = record.duration_ms;
        statusPill.textContent = "ACTIVE";
        statusPill.className = "status-pill status-pill--running";
        controllerStatusElem.textContent = "Live Stream Connected";
        controllerStatusElem.className = "spectator-badge controller-badge is-connected";
        updateTimer();
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
          duration_ms: runData.duration_ms || 0,
          actions_total: totalActions,
          gems_collected: gemCount,
          rooms_visited: 1,
          declared_cli: runData.declared_cli || "browser-test-cli"
        };
      }

      const outcome = (summary.outcome || summary.status || "ENDED").toUpperCase();
      summaryOutcomeBadge.textContent = outcome;
      summaryOutcomeBadge.className = `badge badge--${outcome.toLowerCase()}`;
      summaryOutcome.textContent = outcome;

      const durationSec = summary.elapsed_seconds || Math.round((summary.duration_ms || 0) / 1000);
      summaryElapsed.textContent = `${durationSec}s`;
      summaryActions.textContent = summary.actions_total ?? summary.action_count ?? totalActions;
      summaryGems.textContent = summary.gems_collected ?? gemCount;
      summaryRooms.textContent = summary.rooms_visited ?? (summary.route ? summary.route.length : 1);
      summaryCli.textContent = summary.declared_cli || "browser-test-cli";

      console.log("[Spectator] Showing summary modal with outcome:", outcome);
      summaryOverlay.removeAttribute("hidden");
      summaryOverlay.hidden = false;
      summaryOverlay.style.display = "flex";
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
    await initSpectatorPage();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startup);
  } else {
    startup();
  }
})();
