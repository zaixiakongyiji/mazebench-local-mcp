(function () {
  "use strict";

  // Lock user inputs unconditionally for spectator session
  window.__MAZEBENCH_INPUT_LOCKED__ = true;

  const PITCH_INDEX_TO_TILT_RAD = [0, 0.22, 0.55, 0.95, 1.3];

  function convertPitchToTilt(pitch) {
    if (typeof pitch === "number" && Number.isInteger(pitch) && pitch >= 0 && pitch <= 4) {
      return PITCH_INDEX_TO_TILT_RAD[pitch];
    }
    const num = Number(pitch);
    if (Number.isFinite(num)) {
      if (num >= 0 && num <= 4 && Number.isInteger(num)) {
        return PITCH_INDEX_TO_TILT_RAD[num];
      }
      return num;
    }
    return 0.22;
  }

  let currentAnimationRaf = 0;
  let currentAnimationDoneCallback = null;

  function cancelCurrentAnimation() {
    if (currentAnimationRaf) {
      cancelAnimationFrame(currentAnimationRaf);
      currentAnimationRaf = 0;
    }
    if (typeof currentAnimationDoneCallback === "function") {
      const cb = currentAnimationDoneCallback;
      currentAnimationDoneCallback = null;
      cb();
    }
  }

  function getApp() {
    return window.__MAZEBENCH_APP__ || null;
  }

  function waitForApp(maxWaitMs = 10000) {
    return new Promise((resolve) => {
      const app = getApp();
      if (app) return resolve(app);
      const start = Date.now();
      const interval = setInterval(() => {
        const currentApp = getApp();
        if (currentApp || Date.now() - start > maxWaitMs) {
          clearInterval(interval);
          resolve(currentApp);
        }
      }, 50);
    });
  }

  async function applyViewerStateToApp(app, state) {
    if (!app || !state) return;

    // 1. Authoritative Room Transition (awaited for full room load)
    const targetRoom = state.current_room || state.level_id || "level_HxI";
    if (app.currentLevelId && app.currentLevelId !== targetRoom) {
      if (typeof app.switchPlayWorldLevel === "function") {
        try {
          await app.switchPlayWorldLevel(targetRoom, { immediate: true });
        } catch (_e) {}
      }
    }

    // 2. Authoritative 3D Camera Angles
    if (state.yaw !== undefined) {
      const targetYawRad = (Number(state.yaw) || 0) * (Math.PI / 2);
      if (typeof app.setSpectatorCameraYaw === "function") {
        app.setSpectatorCameraYaw(targetYawRad);
      } else if (app.threeRenderer && typeof app.threeRenderer.setDebugCameraView === "function") {
        app.threeRenderer.setDebugCameraView({
          yaw: targetYawRad,
          preserveSceneCache: true,
          skipRender: false,
          skipResize: true
        });
      }
    }
    if (state.pitch !== undefined) {
      const targetTilt = convertPitchToTilt(state.pitch);
      if (typeof app.setSpectatorCameraTilt === "function") {
        app.setSpectatorCameraTilt(targetTilt);
      } else if (app.threeRenderer && typeof app.threeRenderer.setDebugCameraView === "function") {
        app.threeRenderer.setDebugCameraView({
          tilt: targetTilt,
          preserveSceneCache: true,
          skipRender: false,
          skipResize: true
        });
      }
    }

    // 3. Authoritative Player Position using viewer_actor_index
    if (state.player) {
      let playerIdx = state.player.viewer_actor_index;
      if (playerIdx === undefined || playerIdx < 0) {
        if (Array.isArray(app.playData?.actors)) {
          const found = app.playData.actors.findIndex((a) =>
            typeof app.isMainPlayerActor === "function" ? app.isMainPlayerActor(a) : a.type === "player"
          );
          if (found >= 0) playerIdx = found;
        }
      }
      if (playerIdx === undefined || playerIdx < 0) {
        playerIdx = app.playerActorIndex ?? 0;
      }

      if (app.state?.actors?.[playerIdx]) {
        app.state.actors[playerIdx].type = "player";
        app.state.actors[playerIdx].x = state.player.x;
        app.state.actors[playerIdx].y = state.player.y;
        app.state.actors[playerIdx].elevation = state.player.elevation;
        app.state.actors[playerIdx].renderX = state.player.x;
        app.state.actors[playerIdx].renderY = state.player.y;
        app.state.actors[playerIdx].renderElevation = state.player.elevation;
        app.state.actors[playerIdx].renderScale = 1;
        app.state.actors[playerIdx].renderAlpha = 1;
        app.state.actors[playerIdx].renderSink = 0;
        app.state.actors[playerIdx].renderInHole = false;
        app.state.actors[playerIdx].removed = false;
      }
      if (app.playData?.actors?.[playerIdx]) {
        app.playData.actors[playerIdx].type = "player";
        app.playData.actors[playerIdx].x = state.player.x;
        app.playData.actors[playerIdx].y = state.player.y;
        app.playData.actors[playerIdx].elevation = state.player.elevation;
        app.playData.actors[playerIdx].renderX = state.player.x;
        app.playData.actors[playerIdx].renderY = state.player.y;
        app.playData.actors[playerIdx].renderElevation = state.player.elevation;
        app.playData.actors[playerIdx].removed = false;
      }
      app.playerActorIndex = playerIdx;
    }

    // 4. Non-Player Actors using authoritative viewer_actor_index
    if (Array.isArray(state.actors)) {
      for (const a of state.actors) {
        let idx = a.viewer_actor_index;
        if (idx === undefined || idx < 0) {
          const match = String(a.id || "").match(/:actor:(\d+)$/);
          if (match) idx = parseInt(match[1], 10);
        }
        if (idx !== undefined && idx >= 0) {
          const isPlayerIdx = state.player && idx === state.player.viewer_actor_index;
          if (!isPlayerIdx) {
            if (app.state?.actors?.[idx]) {
              if (a.type) app.state.actors[idx].type = a.type;
              app.state.actors[idx].x = a.x;
              app.state.actors[idx].y = a.y;
              app.state.actors[idx].elevation = a.elevation;
              app.state.actors[idx].renderX = a.x;
              app.state.actors[idx].renderY = a.y;
              app.state.actors[idx].renderElevation = a.elevation;
              app.state.actors[idx].removed = Boolean(a.removed);
              if (a.removed) {
                app.state.actors[idx].renderScale = 0;
                app.state.actors[idx].renderAlpha = 0;
                app.state.actors[idx].renderInHole = false;
              } else {
                app.state.actors[idx].renderScale = 1;
                app.state.actors[idx].renderAlpha = 1;
                app.state.actors[idx].renderInHole = false;
              }
            }
            if (app.playData?.actors?.[idx]) {
              if (a.type) app.playData.actors[idx].type = a.type;
              app.playData.actors[idx].x = a.x;
              app.playData.actors[idx].y = a.y;
              app.playData.actors[idx].elevation = a.elevation;
              app.playData.actors[idx].renderX = a.x;
              app.playData.actors[idx].renderY = a.y;
              app.playData.actors[idx].renderElevation = a.elevation;
              app.playData.actors[idx].removed = Boolean(a.removed);
            }
          }
        }
      }
    }

    // 5. Collected Gems
    const collected = state.collected_gems || state.collected_gem_ids;
    if (Array.isArray(collected) && app.collectedGemIds instanceof Set) {
      app.collectedGemIds.clear();
      collected.forEach((id) => app.collectedGemIds.add(id));
    }
    const currentRoomId = state.current_room || app.currentLevelId || "level_HxI";
    if (Array.isArray(app.state?.actors)) {
      for (let i = 0; i < app.state.actors.length; i++) {
        const act = app.state.actors[i];
        if (act && act.type === "gem") {
          const origX = app.playData?.actors?.[i]?.x ?? act.x;
          const origY = app.playData?.actors?.[i]?.y ?? act.y;
          const origElev = app.playData?.actors?.[i]?.elevation ?? act.elevation ?? 0;
          const gemId = act.collectionId || `${currentRoomId}:gem:${origX},${origY},${origElev}`;
          const isCollected = Boolean(app.collectedGemIds?.has(gemId));

          if (isCollected) {
            if (typeof app.applyCollectedGemVisual === "function") {
              app.applyCollectedGemVisual(act);
            } else {
              act.collected = true;
              act.removed = true;
              act.showCollectedGhost = true;
              act.renderScale = 1;
              act.renderAlpha = app.COLLECTED_GEM_ALPHA ?? 0.22;
              act.renderSink = 0;
              act.renderInHole = false;
            }
            act.collectionId = gemId;
          } else {
            if (typeof app.clearCollectedGemVisual === "function") {
              app.clearCollectedGemVisual(act);
            } else {
              act.collected = false;
              act.removed = false;
              act.showCollectedGhost = false;
              act.renderScale = 1;
              act.renderAlpha = 1;
              act.renderSink = 0;
              act.renderInHole = false;
            }
            act.collectionId = gemId;
          }

          if (app.playData?.actors?.[i]) {
            const playAct = app.playData.actors[i];
            playAct.collectionId = gemId;
            playAct.collected = isCollected;
            playAct.removed = isCollected;
            playAct.showCollectedGhost = isCollected;
            playAct.renderScale = 1;
            playAct.renderAlpha = isCollected ? (app.COLLECTED_GEM_ALPHA ?? 0.22) : 1;
          }
        }
      }
    }
    if (typeof app.applyCollectedGemProgressToActors === "function") {
      app.applyCollectedGemProgressToActors(app.state?.actors, currentRoomId);
    }
    app.threeRenderer?.invalidateSceneCache?.();

    // 6. Terrain Overrides (Lifts & Devices)
    if (Array.isArray(state.terrain_overrides)) {
      for (const ov of state.terrain_overrides) {
        const width = app.state?.width || 10;
        const x = ov.index % width;
        const y = Math.floor(ov.index / width);
        if (ov.type && app.state?.terrain?.[y]?.[x] && app.state.terrain[y][x].type !== ov.type) {
          if (ov.type === "floor") {
            app.state.terrain[y][x] = {
              type: "floor",
              label: "Floor",
              imageUrl: null,
              underlay: null,
              raised: false
            };
          } else {
            app.state.terrain[y][x].type = ov.type;
          }
          app.terrainRenderVersion = (Number(app.terrainRenderVersion) || 0) + 1;
        }
        if (ov.raised !== undefined && typeof app.setPlayerLiftRaised === "function") {
          app.setPlayerLiftRaised(x, y, Boolean(ov.raised));
        }
      }
    }
    app.syncPlayerLiftAnimationTargets?.();
    app.syncOrangeWallAnimationTargets?.();

    // 7. Re-sync Camera & Render
    if (typeof app.syncCameraTarget === "function") {
      app.syncCameraTarget(true);
    }
    if (typeof app.render === "function") {
      app.render();
    }
  }

  async function animateViewerTransition(app, transition, postViewerState, callback) {
    if (!transition || !transition.duration_ms || transition.duration_ms <= 0) {
      await applyViewerStateToApp(app, postViewerState || transition?.keyframes?.[1]?.viewer_state);
      if (typeof callback === "function") callback();
      return;
    }

    cancelCurrentAnimation();
    currentAnimationDoneCallback = callback;

    const startMs = performance.now();
    const durationMs = transition.duration_ms;
    const startState = transition.keyframes?.[0]?.viewer_state;
    const endState = postViewerState || transition.keyframes?.[1]?.viewer_state;

    if (!startState || !endState) {
      await applyViewerStateToApp(app, endState || startState);
      currentAnimationDoneCallback = null;
      if (typeof callback === "function") callback();
      return;
    }

    // Sync gem collection immediately when move begins so ghost material takes effect
    const transCollected = endState.collected_gems || endState.collected_gem_ids;
    if (Array.isArray(transCollected) && app.collectedGemIds instanceof Set) {
      app.collectedGemIds.clear();
      transCollected.forEach((id) => app.collectedGemIds.add(id));
      const room = endState.current_room || app.currentLevelId || "level_HxI";
      if (Array.isArray(app.state?.actors)) {
        for (let i = 0; i < app.state.actors.length; i++) {
          const act = app.state.actors[i];
          if (act && act.type === "gem") {
            const origX = app.playData?.actors?.[i]?.x ?? act.x;
            const origY = app.playData?.actors?.[i]?.y ?? act.y;
            const origElev = app.playData?.actors?.[i]?.elevation ?? act.elevation ?? 0;
            const gemId = act.collectionId || `${room}:gem:${origX},${origY},${origElev}`;
            if (app.collectedGemIds.has(gemId)) {
              if (typeof app.applyCollectedGemVisual === "function") {
                app.applyCollectedGemVisual(act);
              } else {
                act.collected = true;
                act.removed = true;
                act.showCollectedGhost = true;
                act.renderScale = 1;
                act.renderAlpha = app.COLLECTED_GEM_ALPHA ?? 0.22;
              }
            }
          }
        }
      }
      app.threeRenderer?.invalidateSceneCache?.();
    }

    function stepAnimation(now) {
      const elapsed = now - startMs;
      const progress = Math.min(1, Math.max(0, elapsed / durationMs));

      // Interpolate camera
      if (transition.camera_delta && transition.camera_delta.from_yaw !== undefined && transition.camera_delta.to_yaw !== undefined) {
        const fromYaw = (Number(transition.camera_delta.from_yaw) || 0) * (Math.PI / 2);
        const toYaw = (Number(transition.camera_delta.to_yaw) || 0) * (Math.PI / 2);
        const curYaw = fromYaw + (toYaw - fromYaw) * progress;
        if (typeof app.setSpectatorCameraYaw === "function") {
          app.setSpectatorCameraYaw(curYaw);
        }
      }
      if (transition.camera_delta && transition.camera_delta.from_pitch !== undefined && transition.camera_delta.to_pitch !== undefined) {
        const fromTilt = convertPitchToTilt(transition.camera_delta.from_pitch);
        const toTilt = convertPitchToTilt(transition.camera_delta.to_pitch);
        const curTilt = fromTilt + (toTilt - fromTilt) * progress;
        if (typeof app.setSpectatorCameraTilt === "function") {
          app.setSpectatorCameraTilt(curTilt);
        }
      }

      // Interpolate actors
      if (Array.isArray(transition.actor_deltas)) {
        for (const delta of transition.actor_deltas) {
          const deltaStart = delta.start_time_ratio ?? 0;
          const deltaEnd = delta.end_time_ratio ?? 1;
          const localT = Math.min(1, Math.max(0, (progress - deltaStart) / Math.max(0.001, deltaEnd - deltaStart)));

          const curX = delta.before.x + (delta.after.x - delta.before.x) * localT;
          const curY = delta.before.y + (delta.after.y - delta.before.y) * localT;
          const curElev = delta.before.elevation + (delta.after.elevation - delta.before.elevation) * localT;

          let targetIdx = -1;
          const isPlayerDelta = delta.type === "player" || delta.type === "circle_player";
          if (isPlayerDelta) {
            targetIdx = endState.player?.viewer_actor_index ?? app.playerActorIndex ?? 0;
          } else {
            const m = String(delta.id || "").match(/:actor:(\d+)$/);
            if (m) targetIdx = parseInt(m[1], 10);
          }

          if (targetIdx >= 0 && app.state?.actors?.[targetIdx]) {
            const actor = app.state.actors[targetIdx];
            if (isPlayerDelta) {
              actor.type = "player";
            } else if (delta.type) {
              actor.type = delta.type;
            }
            actor.x = curX;
            actor.y = curY;
            actor.elevation = curElev;
            actor.renderX = curX;
            actor.renderY = curY;
            actor.renderElevation = curElev;

            // Handle falling into void/hole animation
            if (delta.after.removed) {
              actor.renderSink = localT * 50;
              actor.renderScale = Math.max(0, 1 - localT);
              actor.renderAlpha = Math.max(0, 1 - localT);
              if (localT >= 1) {
                actor.removed = true;
                actor.renderScale = 0;
                actor.renderAlpha = 0;
                actor.renderInHole = false;
              }
            } else {
              actor.removed = false;
              actor.renderScale = 1;
              actor.renderAlpha = 1;
              actor.renderSink = 0;
            }
          }
        }
      }

      if (typeof app.syncCameraTarget === "function") {
        app.syncCameraTarget(true);
      }
      if (typeof app.render === "function") {
        app.render();
      }

      if (progress < 1) {
        currentAnimationRaf = requestAnimationFrame(stepAnimation);
      } else {
        currentAnimationRaf = 0;
        const cb = currentAnimationDoneCallback;
        currentAnimationDoneCallback = null;
        applyViewerStateToApp(app, endState).then(() => {
          if (typeof cb === "function") cb();
        });
      }
    }

    currentAnimationRaf = requestAnimationFrame(stepAnimation);
  }

  const SpectatorHost = {
    getApp,
    waitForApp,

    async applyAction(action, transition = null, postViewerState = null, options = {}) {
      const app = await waitForApp(3000) || getApp();
      if (!app) return false;

      // 1. Authoritative Transition Processing
      if (transition) {
        if (options.immediate === true || !transition.duration_ms) {
          await applyViewerStateToApp(app, postViewerState || transition.keyframes?.[1]?.viewer_state);
          return true;
        }
        return new Promise((resolve) => {
          animateViewerTransition(app, transition, postViewerState, () => resolve(true));
        });
      }

      // 2. Authoritative Post State Alignment
      if (postViewerState) {
        await applyViewerStateToApp(app, postViewerState);
        return true;
      }

      // 3. Fallback Action Execution
      const act = String(action || "").trim().toLowerCase();

      // Camera rotation
      if (act === "rotate camera left" || act === "rotate_camera_left") {
        const curYaw = typeof app.getSpectatorCameraYaw === "function"
          ? app.getSpectatorCameraYaw()
          : (app.cameraState?.yaw || 0);
        if (typeof app.setSpectatorCameraYaw === "function") {
          app.setSpectatorCameraYaw(curYaw - Math.PI / 2);
        }
        return true;
      }
      if (act === "rotate camera right" || act === "rotate_camera_right") {
        const curYaw = typeof app.getSpectatorCameraYaw === "function"
          ? app.getSpectatorCameraYaw()
          : (app.cameraState?.yaw || 0);
        if (typeof app.setSpectatorCameraYaw === "function") {
          app.setSpectatorCameraYaw(curYaw + Math.PI / 2);
        }
        return true;
      }
      if (act === "rotate camera up" || act === "rotate_camera_up") {
        app.adjustCameraTilt?.(-0.15);
        return true;
      }
      if (act === "rotate camera down" || act === "rotate_camera_down") {
        app.adjustCameraTilt?.(0.15);
        return true;
      }

      // Undo & Reset
      if (act === "undo") {
        if (typeof app.undoMove === "function") app.undoMove();
        return true;
      }
      if (act === "reset") {
        if (typeof app.resetPositions === "function") app.resetPositions();
        return true;
      }

      // Room change
      const roomMatch = act.match(/^(?:go to level|goto_level|go_to_level|goto)\s*([a-zA-Z0-9_-]+)?$/i);
      if (roomMatch && roomMatch[1]) {
        const targetRoom = roomMatch[1];
        if (typeof app.switchPlayWorldLevel === "function") {
          await app.switchPlayWorldLevel(targetRoom);
        }
        return true;
      }

      // Directional movement
      const DIRECTION_VECTORS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const vec = DIRECTION_VECTORS[act];
      if (vec && typeof app.movePlayers === "function") {
        const mapped = typeof app.mapCameraRelativeDirection === "function"
          ? app.mapCameraRelativeDirection(vec[0], vec[1])
          : vec;
        app.movePlayers(mapped[0], mapped[1], { inputSource: "external_mcp" });
        return true;
      }

      return false;
    },

    async applySnapshot(snapshot) {
      const app = await waitForApp(3000) || getApp();
      if (!app || !snapshot) return;
      return applyViewerStateToApp(app, snapshot);
    }
  };

  window.__MAZEBENCH_SPECTATOR_HOST__ = SpectatorHost;
})();
