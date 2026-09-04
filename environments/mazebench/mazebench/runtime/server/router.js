const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { isLoopbackHost, isLoopbackPeer } = require("./network");

const PREVIEW_REQUEST_BODY_MAX_BYTES = 20 * 1024 * 1024;
const EXTERNAL_PLAY_BLOB_MAX_BYTES = 10 * 1024 * 1024;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function createRequestRouter({
  agentRuns,
  buildMazePreviewData,
  buildMazeWorldMapEditorData,
  buildWorlds,
  capabilities = { external_play: true, local_mcp: true, prime_integration: false },
  externalPlay,
  getContentType,
  getEditableLevel,
  getGame,
  getLevel,
  getLevelEditorState,
  getLevelFilePath,
  getLevelState,
  gamesDir,
  loadJson,
  publicFileRoutes,
  readJsonBody,
  remote,
  renderAgentPage,
  renderAgentRunPage,
  renderAuthorPage,
  renderBuildPage,
  renderExternalPlayGroupPage,
  renderExternalPlayLandingPage,
  renderExternalPlayRunPage,
  renderFlyoverPage,
  renderGamePage,
  renderHomePage,
  renderLeaderboardPage,
  renderNotFound,
  renderPlayPage,
  renderWorldMapEditorPage,
  resolveGameAssetPath,
  sanitizeEditorPayload,
  sendFile,
  sendHtml,
  sendJson,
  sendRedirect,
  solverExports,
  worldMaps,
  writeMazePreviewImageData
}) {
  const defaultLevelIdForGame = (game) => worldMaps.defaultLevelIdForGame(game);
  const isWorldLevelId = (game, levelId) => worldMaps.isMazeWorldLevelId(game.id, levelId);
  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);
    const publicFilePath = publicFileRoutes.get(url.pathname);
    if (!isLoopbackRequest(request)) {
      sendHtml(response, 403, "Forbidden.");
      return;
    }
    if (segments[0] === "api") {
      const localApiError = validateLocalApiRequest(request, url, segments);
      if (localApiError) {
        sendJson(response, localApiError.status, { error: localApiError.message });
        return;
      }
    }

    if (publicFilePath) {
      sendFile(request, response, publicFilePath, getContentType(publicFilePath));
      return;
    }

    if (segments.length >= 3 && segments[0] === "assets") {
      const gameId = segments[1];
      const relativePath = segments.slice(2).map(decodeURIComponent).join(path.sep);
      const assetPath = resolveGameAssetPath(gameId, relativePath);

      if (!assetPath) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendFile(request, response, assetPath, getContentType(assetPath));
      return;
    }

    if (url.pathname === "/") {
      sendHtml(response, 200, renderHomePage());
      return;
    }

    if (url.pathname === "/build") {
      sendHtml(response, 200, renderBuildPage());
      return;
    }

    if (url.pathname === "/play") {
      sendRedirect(response, "/build");
      return;
    }

    if (url.pathname === "/external-play" || (segments.length === 1 && segments[0] === "external-play")) {
      if (externalPlay) {
        sendHtml(
          response,
          200,
          renderExternalPlayLandingPage({
            activeRun: externalPlay.getRun(externalPlay.activeRunId),
            activeGroupId: externalPlay.activeGroupId,
            groups: externalPlay.listGroups(),
            runs: Array.from(externalPlay.runs.values())
          })
        );
        return;
      }
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (segments.length === 2 && segments[0] === "external-play") {
      const runId = segments[1];
      const run = externalPlay ? externalPlay.getRun(runId) : null;
      if (!run) {
        sendHtml(response, 404, renderNotFound());
        return;
      }
      sendHtml(response, 200, renderExternalPlayRunPage(run));
      return;
    }

    if (segments.length === 3 && segments[0] === "external-play" && segments[1] === "groups") {
      const group = externalPlay ? externalPlay.getGroup(segments[2]) : null;
      if (!group) {
        sendHtml(response, 404, renderNotFound());
        return;
      }
      sendHtml(response, 200, renderExternalPlayGroupPage(group));
      return;
    }

    // External Play APIs
    if (segments[0] === "api" && segments[1] === "external-play") {
      if (!externalPlay) {
        sendJson(response, 503, { error: "External play service not initialized", code: "SERVICE_UNAVAILABLE" });
        return;
      }

      // 1. Health
      if (segments.length === 3 && segments[2] === "health") {
        if (request.method !== "GET") {
          response.writeHead(405, { Allow: "GET" });
          response.end();
          return;
        }
        sendJson(response, 200, {
          status: "ok",
          service_state: externalPlay.serviceState,
          instance_id: externalPlay.instanceId,
          active_run_id: externalPlay.activeRunId,
          active_group_id: externalPlay.activeGroupId,
          claimable_run_count: externalPlay.claimableRunIds.length
        });
        return;
      }

      // Check INITIALIZING state for all other external API calls
      if (externalPlay.serviceState === "INITIALIZING") {
        sendJson(response, 503, { error: "Service is initializing", code: "INITIALIZING" });
        return;
      }

      // 2. Controller Session
      if (segments.length === 4 && segments[2] === "controller" && segments[3] === "session") {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" });
          response.end();
          return;
        }
        const payload = await readJsonBody(request);
        try {
          const nonce = payload.mcp_bootstrap_nonce || payload.nonce;
          const res = await externalPlay.handleControllerSession(nonce, payload.clientInfo);
          sendJson(response, 200, res);
        } catch (err) {
          sendJson(response, err.status || 403, { error: err.message, code: err.code || "FORBIDDEN" });
        }
        return;
      }

      // 4. MCP Proxy
      if (segments.length === 3 && segments[2] === "mcp") {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" });
          response.end();
          return;
        }
        const controllerInfo = externalPlay.validateControllerToken(request.headers.authorization);
        if (!controllerInfo) {
          sendJson(response, 401, { error: "Unauthorized controller token", code: "UNAUTHORIZED" });
          return;
        }
        const payload = await readJsonBody(request);
        const run = payload.tool === "start"
          ? null
          : (payload.run_id ? externalPlay.getRun(payload.run_id) : null);

        if (payload.tool !== "start" && !run) {
          sendJson(response, 404, {
            error: `Run not found: ${payload.run_id}`,
            code: "NOT_FOUND"
          });
          return;
        }

        const requestAbort = new AbortController();
        let requestFinished = false;
        const abortOnDisconnect = () => {
          if (!requestFinished) requestAbort.abort();
        };
        response.once("close", abortOnDisconnect);

        try {
          let res;
          if (payload.tool === "start") {
            res = await externalPlay.claimOrAttachRun(
              controllerInfo,
              { ...(payload.arguments || {}), ...(payload.run_id ? { run_id: payload.run_id } : {}) },
              payload.operation_id,
              requestAbort.signal
            );
          } else if (payload.tool === "observe") {
            const obs = await run.observe();
            res = {
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(obs)
                  }
                ],
                isError: false
              },
              ...obs
            };
          } else {
            res = await run.executeAction(
              controllerInfo,
              payload.lease_id,
              payload.lease_epoch,
              payload.tool,
              payload.arguments,
              payload.operation_id,
              requestAbort.signal
            );
          }
          if (!requestAbort.signal.aborted) sendJson(response, 200, res);
        } catch (err) {
          if (!requestAbort.signal.aborted) {
            sendJson(response, err.status || 500, { error: err.message, code: err.code || "INTERNAL_ERROR" });
          }
        } finally {
          requestFinished = true;
          response.off("close", abortOnDisconnect);
        }
        return;
      }

      // 5. Lease Heartbeat
      if (segments.length === 4 && segments[2] === "lease" && segments[3] === "heartbeat") {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" });
          response.end();
          return;
        }
        const controllerInfo = externalPlay.validateControllerToken(request.headers.authorization);
        if (!controllerInfo) {
          sendJson(response, 401, { error: "Unauthorized controller token", code: "UNAUTHORIZED" });
          return;
        }
        const payload = await readJsonBody(request);
        const run = externalPlay.getRun(payload.run_id);
        if (!run) {
          sendJson(response, 404, { error: `Run not found: ${payload.run_id}`, code: "NOT_FOUND" });
          return;
        }
        try {
          const res = await run.heartbeat(controllerInfo, payload.lease_id, payload.lease_epoch);
          sendJson(response, 200, res);
        } catch (err) {
          sendJson(response, err.status || 500, { error: err.message, code: err.code || "INTERNAL_ERROR" });
        }
        return;
      }

      // 6. Lease Detach
      if (segments.length === 4 && segments[2] === "lease" && segments[3] === "detach") {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" });
          response.end();
          return;
        }
        const controllerInfo = externalPlay.validateControllerToken(request.headers.authorization);
        if (!controllerInfo) {
          sendJson(response, 401, { error: "Unauthorized controller token", code: "UNAUTHORIZED" });
          return;
        }
        const payload = await readJsonBody(request);
        const run = externalPlay.getRun(payload.run_id);
        if (!run) {
          sendJson(response, 404, { error: `Run not found: ${payload.run_id}`, code: "NOT_FOUND" });
          return;
        }
        try {
          const res = await run.detach(controllerInfo, payload.lease_id, payload.lease_epoch);
          sendJson(response, 200, res);
        } catch (err) {
          sendJson(response, err.status || 500, { error: err.message, code: err.code || "INTERNAL_ERROR" });
        }
        return;
      }

      // 7. Run Groups Collection: GET /groups & POST /groups
      if (segments.length === 3 && segments[2] === "groups") {
        if (request.method === "GET") {
          sendJson(response, 200, {
            groups: externalPlay.listGroups(),
            active_group_id: externalPlay.activeGroupId
          });
          return;
        }
        if (request.method === "POST") {
          const payload = await readJsonBody(request);
          try {
            const group = await externalPlay.createGroup({
              mode: payload.mode,
              count: payload.count,
              maxActions: payload.max_actions !== undefined ? payload.max_actions : undefined,
              durationMs: payload.max_actions === undefined && payload.duration_ms !== undefined ? payload.duration_ms : undefined,
              winThreshold: payload.win_threshold !== undefined ? payload.win_threshold : undefined
            });
            sendJson(response, 201, group);
          } catch (err) {
            sendJson(response, err.status || 500, { error: err.message, code: err.code || "INTERNAL_ERROR" });
          }
          return;
        }
        response.writeHead(405, { Allow: "GET, POST" });
        response.end();
        return;
      }

      // 8. Individual Run Group: GET /groups/:id & POST /groups/:id/cancel
      if (segments.length >= 4 && segments[2] === "groups") {
        const groupId = segments[3];
        if (segments.length === 4 && request.method === "GET") {
          const group = externalPlay.getGroup(groupId);
          if (!group) {
            sendJson(response, 404, { error: `Run group not found: ${groupId}`, code: "NOT_FOUND" });
          } else {
            sendJson(response, 200, group);
          }
          return;
        }
        if (segments.length === 5 && segments[4] === "cancel" && request.method === "POST") {
          try {
            sendJson(response, 200, await externalPlay.cancelGroup(groupId));
          } catch (err) {
            sendJson(response, err.status || 500, { error: err.message, code: err.code || "INTERNAL_ERROR" });
          }
          return;
        }
        response.writeHead(405, { Allow: "GET, POST" });
        response.end();
        return;
      }

      // 9. Runs Collection: GET /runs & POST /runs
      if (segments.length === 3 && segments[2] === "runs") {
        if (request.method === "GET") {
          const runsList = Array.from(externalPlay.runs.values()).map((r) => ({
            run_id: r.runId,
            status: r.status,
            started_at: r.startedAt,
            max_actions: r.maxActions,
            ...(r.maxActions ? {} : { deadline_at: r.deadlineAt, duration_ms: r.durationMs }),
            ...(r.winThreshold ? { win_threshold: r.winThreshold } : {}),
            manifest: r.manifest
          }));
          sendJson(response, 200, { runs: runsList, active_run_id: externalPlay.activeRunId });
          return;
        }
        if (request.method === "POST") {
          const payload = await readJsonBody(request);
          try {
            const run = await externalPlay.createRun({
              maxActions: payload.max_actions !== undefined ? payload.max_actions : undefined,
              durationMs: payload.max_actions === undefined && payload.duration_ms !== undefined ? payload.duration_ms : undefined,
              winThreshold: payload.win_threshold !== undefined ? payload.win_threshold : undefined
            });
            sendJson(response, 201, { run_id: run.runId, status: run.status });
          } catch (err) {
            sendJson(response, err.status || 500, { error: err.message, code: err.code || "INTERNAL_ERROR" });
          }
          return;
        }
        response.writeHead(405, { Allow: "GET, POST" });
        response.end();
        return;
      }

      // 8. Individual Run Operations / Data
      if (segments.length >= 4 && segments[2] === "runs") {
        const runId = segments[3];
        const run = externalPlay.getRun(runId);
        if (!run) {
          sendJson(response, 404, { error: `Run not found: ${runId}`, code: "NOT_FOUND" });
          return;
        }

        // Cancel: POST /api/external-play/runs/:runId/cancel
        if (segments.length === 5 && segments[4] === "cancel") {
          if (request.method !== "POST") {
            response.writeHead(405, { Allow: "POST" });
            response.end();
            return;
          }
          const res = await run.cancelRun();
          sendJson(response, 200, res);
          return;
        }

        // Viewer Token: POST /api/external-play/runs/:runId/viewer-token
        if (segments.length === 5 && segments[4] === "viewer-token") {
          if (request.method !== "POST") {
            response.writeHead(405, { Allow: "POST" });
            response.end();
            return;
          }
          const viewerToken = externalPlay.generateViewerToken(runId);
          sendJson(response, 200, { viewer_token: viewerToken });
          return;
        }

        // Helper for viewer auth
        const authHeader = request.headers.authorization || "";
        const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
        const token = tokenMatch ? tokenMatch[1] : null;
        const hasViewerToken = externalPlay.validateViewerToken(token, runId);

        if (!hasViewerToken) {
          sendJson(response, 401, { error: "Viewer token required", code: "UNAUTHORIZED" });
          return;
        }

        // Snapshot: GET /api/external-play/runs/:runId/snapshot
        if (segments.length === 5 && segments[4] === "snapshot") {
          if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
          }
          sendJson(response, 200, {
            base_viewer_state: run.baseViewerState,
            world_bundle_digest: run.worldBundleDigest,
            action_seq: run.lastActionSeq,
            as_of_event_id: run.lastEventId,
            status: run.status,
            started_at: run.startedAt,
            max_actions: run.maxActions,
            ...(run.maxActions ? {} : { deadline_at: run.deadlineAt, duration_ms: run.durationMs }),
            ...(run.winThreshold ? { win_threshold: run.winThreshold } : {}),
            model_name: run.modelName,
            harness_name: run.harnessName,
            viewer_state_hash: run.currentViewerStateHash
          });
          return;
        }

        // Actions: GET /api/external-play/runs/:runId/actions
        if (segments.length === 5 && segments[4] === "actions") {
          if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
          }
          const fromSeq = Number(url.searchParams.get("from_seq") || 1);
          const toSeq = url.searchParams.has("to_seq")
            ? Number(url.searchParams.get("to_seq"))
            : run.lastActionSeq;
          const limit = Number(url.searchParams.get("limit") || 500);
          if (
            !Number.isInteger(fromSeq) || fromSeq < 1
            || !Number.isInteger(toSeq) || toSeq < 0 || toSeq < fromSeq - 1
            || !Number.isInteger(limit) || limit < 1 || limit > 500
          ) {
            sendJson(response, 400, { error: "Invalid actions pagination parameters", code: "INVALID_ARGUMENT" });
            return;
          }

          const actions = [];
          if (run.actionsPath && fs.existsSync(run.actionsPath)) {
            const content = fs.readFileSync(run.actionsPath, "utf8");
            const lines = content.split("\n").filter((l) => l.trim().length > 0);
            for (const line of lines) {
              const act = JSON.parse(line);
              if (act.seq >= fromSeq && act.seq <= toSeq) {
                actions.push(act);
                if (actions.length >= limit) break;
              }
            }
          }

          const lastReturnedSeq = actions.length > 0 ? actions[actions.length - 1].seq : fromSeq - 1;
          const hasMore = lastReturnedSeq < toSeq && lastReturnedSeq < run.lastActionSeq;
          const nextSeq = hasMore ? lastReturnedSeq + 1 : null;

          sendJson(response, 200, {
            ok: true,
            run_id: run.runId,
            from_seq: fromSeq,
            to_seq: toSeq,
            limit,
            count: actions.length,
            has_more: hasMore,
            next_seq: nextSeq,
            actions
          });
          return;
        }

        // Events (SSE): GET /api/external-play/runs/:runId/events
        if (segments.length === 5 && segments[4] === "events") {
          if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
          }

          const afterEventIdStr = url.searchParams.get("after_event_id") || request.headers["last-event-id"];
          const afterEventId = afterEventIdStr !== undefined && afterEventIdStr !== null ? Number(afterEventIdStr) : 0;

          if (afterEventIdStr !== undefined && afterEventIdStr !== null && afterEventIdStr !== "") {
            if (!Number.isInteger(afterEventId) || afterEventId < 0) {
              sendJson(response, 410, {
                error: "Event cursor expired or invalid",
                code: "CURSOR_EXPIRED",
                latest_event_id: run.lastEventId
              });
              return;
            }
            if (afterEventId > run.lastEventId) {
              sendJson(response, 409, {
                error: "Event ID gap detected",
                code: "EVENT_GAP",
                latest_event_id: run.lastEventId
              });
              return;
            }
          }

          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive"
          });
          response.flushHeaders?.();

          // Replay past events from journal
          let replayActionSeq = 0;
          if (fs.existsSync(run.journalPath)) {
            const content = fs.readFileSync(run.journalPath, "utf8");
            const lines = content.split("\n").filter((l) => l.trim().length > 0);
            for (const line of lines) {
              const rec = JSON.parse(line);
              let sseData = null;
              if (rec.type === "action_committed") {
                replayActionSeq = rec.action_seq;
                if (rec.event_id > afterEventId) {
                  sseData = {
                    event_id: rec.event_id,
                    type: "action",
                    action_seq: rec.action_seq,
                    tool: rec.action_record.tool,
                    action_record: rec.action_record
                  };
                }
              } else if (rec.type === "action_rejected" && rec.event_id > afterEventId) {
                sseData = {
                  event_id: rec.event_id,
                  type: "action_rejected",
                  action_seq: replayActionSeq,
                  tool: rec.tool,
                  error: rec.error_payload.message
                };
              } else if ((rec.type === "run_finalized" || rec.type === "run_failed") && rec.ended_event_id > afterEventId) {
                sseData = {
                  event_id: rec.ended_event_id,
                  type: "ended",
                  action_seq: run.lastActionSeq,
                  outcome: rec.outcome,
                  summary_digest: rec.summary_digest || rec.partial_summary_digest || null,
                  summary_url: rec.final_response?.summary_url || null
                };
              }
              if (sseData) {
                response.write(`id: ${sseData.event_id}\nevent: ${sseData.type}\ndata: ${JSON.stringify(sseData)}\n\n`);
              }
            }
          }

          // Register subscriber for live fanout if run is not terminal
          if (["armed", "active", "finalizing"].includes(run.status)) {
            run.subscribers.add(response);
          } else {
            response.end();
            return;
          }

          const heartbeatInterval = setInterval(() => {
            try {
              response.write(": heartbeat\n\n");
            } catch (_e) {
              clearInterval(heartbeatInterval);
              run.subscribers.delete(response);
            }
          }, 15000);

          request.on("close", () => {
            clearInterval(heartbeatInterval);
            run.subscribers.delete(response);
          });
          return;
        }

        // Blobs: GET /api/external-play/runs/:runId/blobs/:digest
        if (segments.length === 6 && segments[4] === "blobs") {
          if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
          }
          const digest = segments[5];
          if (!/^[0-9a-f]{64}$/.test(digest)) {
            sendJson(response, 400, { error: "Invalid digest format", code: "INVALID_ARGUMENT" });
            return;
          }
          const blobPath = path.join(run.blobsDir, `${digest}.json`);
          if (!fs.existsSync(blobPath)) {
            sendJson(response, 404, { error: "Blob not found", code: "NOT_FOUND" });
            return;
          }
          if (fs.statSync(blobPath).size > EXTERNAL_PLAY_BLOB_MAX_BYTES) {
            sendJson(response, 413, { error: "Blob exceeds the 10MB response limit", code: "PAYLOAD_TOO_LARGE" });
            return;
          }
          response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
          sendFile(request, response, blobPath, "application/json");
          return;
        }

        // World bundle: GET /api/external-play/runs/:runId/world-bundle
        if (segments.length === 5 && segments[4] === "world-bundle") {
          if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
          }
          if (fs.existsSync(run.worldBundlePath)) {
            sendFile(request, response, run.worldBundlePath, "application/json");
            return;
          }
          sendJson(response, 404, { error: "Frozen world bundle is unavailable", code: "NOT_FOUND" });
          return;
        }

        // Summary: GET /api/external-play/runs/:runId/summary
        if (segments.length === 5 && segments[4] === "summary") {
          if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
          }
          if (!fs.existsSync(run.summaryPath)) {
            sendJson(response, 404, { error: "Summary not available yet", code: "NOT_FOUND" });
            return;
          }
          sendFile(request, response, run.summaryPath, "application/json");
          return;
        }
      }

      sendJson(response, 404, { error: "Endpoint not found", code: "NOT_FOUND" });
      return;
    }

    if (url.pathname === "/api/capabilities" && request.method === "GET") {
      sendJson(response, 200, { capabilities });
      return;
    }

    if (url.pathname === "/agent") {
      sendHtml(response, 200, renderAgentPage());
      return;
    }

    if (url.pathname === "/leaderboard" || url.pathname === "/leaderboard/ai") {
      sendHtml(response, 200, renderLeaderboardPage());
      return;
    }

    if (segments.length === 3 && segments[0] === "agent" && segments[1] === "runs") {
      const runId = decodeURIComponent(segments[2]);
      const summary = agentRuns.summarizeRun(runId);

      if (!summary) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderAgentRunPage(summary));
      return;
    }

    if (segments.length >= 4 && segments[0] === "agent-runs" && segments[2] === "files") {
      const runId = decodeURIComponent(segments[1]);
      const fileName = segments.slice(3).map(decodeURIComponent).join("/");
      const filePath = agentRuns.resolveRunFilePath(runId, fileName);

      if (!filePath) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendFile(request, response, filePath, getContentType(filePath));
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "models") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }

      sendJson(
        response,
        200,
        agentRuns.listProviderModels(decodeURIComponent(segments[3]), {
          fresh: url.searchParams.get("refresh") === "1",
          harness: url.searchParams.get("harness") || "none"
        })
      );
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "harnesses") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }

      sendJson(response, 200, agentRuns.listPrimeHarnesses());
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "environment") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }

      sendJson(response, 200, await agentRuns.getEnvironmentAsync({ fresh: true }));
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "docker" && segments[3] === "start") {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }

      sendJson(response, 200, agentRuns.startDocker());
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "leaderboard") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }

      sendJson(response, 200, agentRuns.getLeaderboard());
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "runs") {
      if (request.method === "GET") {
        sendJson(
          response,
          200,
          agentRuns.listRuns({
            page: Number(url.searchParams.get("page")) || 1,
            pageSize: Number(url.searchParams.get("page_size")) || 10,
            provider: url.searchParams.get("provider") || "",
            model: url.searchParams.get("model") || "",
            status: url.searchParams.get("status") || "",
            starred: url.searchParams.get("starred") === "1",
            query: url.searchParams.get("q") || "",
            sort: url.searchParams.get("sort") || "newest"
          })
        );
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const runs = agentRuns.launchRuns(payload);
        const waiting = runs.filter((run) => run.status === "waiting").length;
        sendJson(response, 201, {
          run: runs[0],
          runs,
          message:
            runs.length === 1
              ? runs[0].status === "waiting"
                ? `Queued run ${runs[0].id}.`
                : `Launched run ${runs[0].id}.`
              : waiting
                ? `Launched ${runs.length - waiting} run${runs.length - waiting === 1 ? "" : "s"}; ${waiting} waiting.`
                : `Launched ${runs.length} runs.`
        });
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "agent" && segments[2] === "runs") {
      const runId = decodeURIComponent(segments[3]);

      if (request.method === "DELETE") {
        sendJson(response, 200, agentRuns.deleteRun(runId));
        return;
      }

      response.writeHead(405, { Allow: "DELETE" });
      response.end();
      return;
    }

    if (
      (segments.length === 5 || segments.length === 6) &&
      segments[0] === "api" &&
      segments[1] === "agent" &&
      segments[2] === "runs"
    ) {
      const runId = decodeURIComponent(segments[3]);

      if (segments[4] === "diagnostics" && request.method === "GET") {
        const diag = agentRuns.getRunDiagnostics(runId);
        if (!diag) {
          sendJson(response, 404, { error: "Run not found or diagnostics unavailable" });
          return;
        }
        sendJson(response, 200, diag);
        return;
      }

      if (segments[4] === "summary" && request.method === "GET") {
        sendJson(response, 200, { review: agentRuns.getRunReview(runId) });
        return;
      }

      if (segments[4] === "notes" && request.method === "GET") {
        sendJson(response, 200, { notes: agentRuns.getRunNotes(runId) });
        return;
      }

      if (segments[4] === "notes" && request.method === "PUT") {
        const payload = await readJsonBody(request);
        const notes = agentRuns.setRunNotes(runId, payload?.notes);
        sendJson(response, 200, { notes, message: notes.notes ? "Run notes saved." : "Run notes cleared." });
        return;
      }

      if (segments[4] === "tools" && segments[5] === "execution" && request.method === "GET") {
        const execution = agentRuns.getToolExecution(runId, url.searchParams.get("id"));
        if (!execution) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, { execution });
        return;
      }

      if (segments[4] === "tools" && segments[5] === "file" && request.method === "GET") {
        const file = agentRuns.getToolWorkspaceFile(
          runId,
          url.searchParams.get("workspace") || "primary",
          url.searchParams.get("path")
        );
        if (!file) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, { file });
        return;
      }

      if (segments[4] === "progress" && request.method === "GET") {
        const progress = agentRuns.getRunProgress(runId, {
          afterTurn: Number(url.searchParams.get("after_turn")) || 0,
          logOffset: Number(url.searchParams.get("log_offset")) || 0
        });

        if (!progress) {
          sendHtml(response, 404, renderNotFound());
          return;
        }

        sendJson(response, 200, progress);
        return;
      }

      if (segments[4] === "stop" && request.method === "POST") {
        sendJson(response, 200, { run: agentRuns.stopRun(runId) });
        return;
      }

      if (segments[4] === "pause" && request.method === "POST") {
        sendJson(response, 200, { run: agentRuns.pauseRun(runId) });
        return;
      }

      if (segments[4] === "resume" && request.method === "POST") {
        sendJson(response, 200, { run: agentRuns.resumeRun(runId) });
        return;
      }

      if (segments[4] === "continue" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.continueRun(runId, payload?.moves);
        sendJson(response, 201, { run, message: `Continuing as run ${run.id}.` });
        return;
      }

      if (segments[4] === "favorite" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.setRunFavorite(runId, payload?.favorite);
        sendJson(response, 200, {
          run,
          message: run.favorited
            ? "Run added to MazeJam AI leaderboard favorites."
            : "Run removed from MazeJam AI leaderboard favorites."
        });
        return;
      }

      if (segments[4] === "branch" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.branchRun(runId, payload?.turn);
        sendJson(response, 201, {
          run,
          message: `Branched action ${run.branch_turn} into run ${run.id}.`
        });
        return;
      }

      if (segments[4] === "budget" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.setRunMoveTarget(runId, payload?.moves);
        sendJson(response, 200, { run, message: `Move target updated to ${run.moves}.` });
        return;
      }

      if (segments[4] === "prime-sync" && request.method === "POST") {
        if (!capabilities.prime_integration) {
          sendJson(response, 400, { error: "Prime integration is disabled.", code: "INTEGRATION_DISABLED" });
          return;
        }
        const run = agentRuns.syncPrimeEvaluation(runId);
        sendJson(response, 202, { run, message: "Prime evaluation sync started." });
        return;
      }

      if (segments[4] === "video" && segments[5] === "cancel" && request.method === "POST") {
        const run = agentRuns.cancelRunVideo(runId);
        sendJson(response, 200, { run, message: "Replay video generation canceled." });
        return;
      }

      if (segments[4] === "video" && segments[5] === "regenerate" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.regenerateRunVideo(runId, payload);
        sendJson(response, 202, { run, message: "Replay video regeneration started." });
        return;
      }

      if (segments.length === 5 && segments[4] === "video" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const run = agentRuns.generateRunVideo(runId, payload);
        sendJson(response, 202, { run, message: "Replay video generation started." });
        return;
      }

      if (segments[4] === "observations" && request.method === "GET") {
        const observations = agentRuns.getRunObservations(runId, {
          instanceId: url.searchParams.get("instance") || "primary",
          fromTurn: Math.max(0, Number(url.searchParams.get("from_turn")) || 0),
          limit: Math.max(1, Number(url.searchParams.get("limit")) || 1)
        });
        if (!observations) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, observations);
        return;
      }

      if (segments[4] === "observation" && request.method === "GET") {
        const observation = await agentRuns.getRunObservation(runId, {
          instanceId: url.searchParams.get("instance") || "primary",
          turn: Math.max(0, Number(url.searchParams.get("turn")) || 0)
        });
        if (!observation) {
          sendHtml(response, 404, renderNotFound());
          return;
        }
        sendJson(response, 200, observation);
        return;
      }

      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (segments.length >= 2 && segments[0] === "api" && segments[1] === "remote") {
      if (segments.length === 3 && segments[2] === "status" && request.method === "GET") {
        sendJson(response, 200, remote.getStatus());
        return;
      }

      if (segments.length === 3 && segments[2] === "disconnect" && request.method === "POST") {
        sendJson(response, 200, await remote.disconnect());
        return;
      }

      if (segments.length === 3 && segments[2] === "origin" && request.method === "POST") {
        const payload = await readJsonBody(request);
        sendJson(response, 200, remote.setOrigin(payload?.origin));
        return;
      }

      if (segments.length === 4 && segments[2] === "link" && segments[3] === "start" && request.method === "GET") {
        const host = request.headers.host || "localhost:3000";
        const callback = `http://${host}/api/remote/link/callback`;
        sendJson(response, 200, { url: remote.deviceLinkUrl(callback) });
        return;
      }

      if (segments.length === 4 && segments[2] === "link" && segments[3] === "callback" && request.method === "GET") {
        const code = url.searchParams.get("code") || "";

        try {
          await remote.completeDeviceLink(code);
          sendRedirect(response, "/build?linked=1");
        } catch (error) {
          sendRedirect(response, `/build?link_error=${encodeURIComponent(error.message)}`);
        }
        return;
      }

      if (segments.length === 3 && segments[2] === "worlds" && request.method === "GET") {
        const view = url.searchParams.get("view") || "drafts";
        sendJson(response, 200, { worlds: await remote.listRemoteWorlds(view) });
        return;
      }

      if (segments.length === 5 && segments[2] === "worlds" && segments[4] === "pull" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const world = await remote.pullWorld(decodeURIComponent(segments[3]), {
          kind: payload?.kind === "online" ? "online" : "draft"
        });
        sendJson(response, 200, { world, message: `Pulled ${world.title}.` });
        return;
      }

      if (segments.length === 3 && segments[2] === "push" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const world = await remote.pushWorld(payload?.game_id);
        sendJson(response, 200, { world, message: `Pushed ${world.title} to ${remote.getStatus().origin}.` });
        return;
      }

      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "build" && segments[2] === "worlds") {
      if (request.method === "GET") {
        sendJson(response, 200, { worlds: buildWorlds.listLocalWorlds() });
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        let game = null;

        if (payload?.editor_state) {
          game = buildWorlds.createLocalWorld({
            title: payload.title,
            editorState: payload.editor_state
          });
        } else if (payload?.source_game_id) {
          game = buildWorlds.createLocalWorldFromGame(payload.source_game_id, payload.title);
        } else {
          game = buildWorlds.createLocalWorld({
            title: payload?.title,
            worldWidth: payload?.world_width,
            worldHeight: payload?.world_height
          });
        }

        sendJson(response, 201, {
          world: buildWorlds.describeLocalWorld(game.id),
          message: `Created ${game.name}.`
        });
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    if (segments.length >= 4 && segments[0] === "api" && segments[1] === "build" && segments[2] === "worlds") {
      const worldGameId = decodeURIComponent(segments[3]);

      if (!buildWorlds.isLocalWorldGameId(worldGameId) || !buildWorlds.readDraftMeta(worldGameId)) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (segments.length === 5 && segments[4] === "export" && request.method === "GET") {
        const game = getGame(worldGameId);
        sendJson(response, 200, buildWorlds.editorStateForGame(game));
        return;
      }

      if (segments.length === 4 && request.method === "PATCH") {
        const payload = await readJsonBody(request);
        const patch = {};
        const messages = [];

        if (Object.prototype.hasOwnProperty.call(payload || {}, "title")) {
          const title = typeof payload.title === "string" ? payload.title.trim() : "";
          if (!title) {
            sendJson(response, 400, { error: "A non-empty title is required." });
            return;
          }
          patch.title = title;
          messages.push(`Renamed to ${title}.`);
        }

        if (Object.prototype.hasOwnProperty.call(payload || {}, "start_level_id")) {
          const startLevelId = String(payload.start_level_id || "");
          const game = getGame(worldGameId);
          if (!game || !game.worldMap?.byPosition?.has(startLevelId)) {
            sendJson(response, 400, { error: "Choose a saved room as the starting room." });
            return;
          }
          patch.default_level_id = startLevelId;
          messages.push(`Starting room set to ${startLevelId.replace(/^level_/, "")}.`);
        }

        if (Object.keys(patch).length === 0) {
          sendJson(response, 400, { error: "No supported world changes were provided." });
          return;
        }

        buildWorlds.updateDraftMeta(worldGameId, patch);
        sendJson(response, 200, {
          world: buildWorlds.describeLocalWorld(worldGameId),
          message: messages.join(" ")
        });
        return;
      }

      if (segments.length === 4 && request.method === "DELETE") {
        buildWorlds.removeLocalWorld(worldGameId);
        sendJson(response, 200, { message: `Deleted ${worldGameId}.` });
        return;
      }

      response.writeHead(405, { Allow: "GET, PATCH, DELETE" });
      response.end();
      return;
    }

    if (segments.length === 3 && segments[0] === "games" && segments[2] === "level_parsing.json") {
      const parserPath = path.join(gamesDir, segments[1], "level_parsing.json");
      if (!fs.existsSync(parserPath)) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendJson(response, 200, loadJson(parserPath, {}));
      return;
    }

    if (segments.length === 2 && segments[0] === "games") {
      const game = getGame(segments[1]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderGamePage(game));
      return;
    }

    if (segments.length === 2 && segments[0] === "author") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const level = getEditableLevel(game, defaultLevelIdForGame(game));
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderAuthorPage(game, level));
      return;
    }

    if (segments.length === 2 && segments[0] === "world-map") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderWorldMapEditorPage(game));
      return;
    }

    if (segments.length === 3 && segments[0] === "author") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (!isWorldLevelId(game, segments[2])) {
        sendRedirect(
          response,
          `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
        );
        return;
      }

      const level = getEditableLevel(game, segments[2]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderAuthorPage(game, level));
      return;
    }

    if (segments.length === 2 && segments[0] === "play") {
      const game = getGame(segments[1]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const levelId = defaultLevelIdForGame(game);
      if (!levelId) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendRedirect(response, `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(levelId)}`);
      return;
    }

    if (segments.length === 2 && segments[0] === "flyover") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const levelId = defaultLevelIdForGame(game);
      if (!levelId) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendRedirect(response, `/flyover/${encodeURIComponent(game.id)}/${encodeURIComponent(levelId)}`);
      return;
    }

    if (segments.length === 3 && segments[0] === "flyover") {
      const game = getGame(segments[1]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (!isWorldLevelId(game, segments[2])) {
        sendRedirect(
          response,
          `/flyover/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
        );
        return;
      }

      const level = getLevel(game, segments[2]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderFlyoverPage(game, level));
      return;
    }

    if (segments.length === 3 && segments[0] === "play") {
      const game = getGame(segments[1]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (game.worldMap && !isWorldLevelId(game, segments[2])) {
        sendRedirect(
          response,
          `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
        );
        return;
      }

      const level = getLevel(game, segments[2]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendHtml(response, 200, renderPlayPage(game, level));
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "play") {
      const game = getGame(segments[2]);
      if (!game) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (game.worldMap && !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const level = getLevel(game, segments[3]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendJson(response, 200, getLevelState(game, level));
      return;
    }

    if (
      segments.length >= 5 &&
      segments.length <= 7 &&
      segments[0] === "api" &&
      segments[1] === "author" &&
      segments[4] === "solution-export"
    ) {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap || !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const level = getLevel(game, segments[3]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (segments.length === 5) {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST" });
          response.end();
          return;
        }

        const payload = await readJsonBody(request);
        const job = solverExports.start({
          format: url.searchParams.get("format") || "mp4",
          gameId: game.id,
          levelId: level.id,
          payload
        });
        const jobUrl = `${url.pathname}/${encodeURIComponent(job.id)}`;
        sendJson(response, 202, {
          ...job,
          downloadUrl: `${jobUrl}/download`,
          statusUrl: jobUrl
        });
        return;
      }

      const identity = {
        gameId: game.id,
        jobId: segments[5],
        levelId: level.id
      };
      const job = solverExports.status(identity);
      if (!job) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (segments.length === 6) {
        if (request.method === "DELETE") {
          solverExports.cancel(identity);
          response.writeHead(204, { "Cache-Control": "no-store" });
          response.end();
          return;
        }
        if (request.method !== "GET") {
          response.writeHead(405, { Allow: "DELETE, GET" });
          response.end();
          return;
        }
        sendJson(response, 200, job);
        return;
      }

      if (segments[6] !== "download") {
        sendHtml(response, 404, renderNotFound());
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      if (job.status !== "ready") {
        sendJson(response, 409, job);
        return;
      }

      const artifact = solverExports.artifact(identity);
      if (!artifact) {
        sendHtml(response, 404, renderNotFound());
        return;
      }
      const stats = fs.statSync(artifact.filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        "Content-Length": stats.size,
        "Content-Type": artifact.contentType
      });
      const stream = fs.createReadStream(artifact.filePath);
      stream.once("close", artifact.cleanup);
      stream.once("error", () => response.destroy());
      stream.pipe(response);
      return;
    }

    if (
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "author" &&
      segments[4] === "preview"
    ) {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap || !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }

      const level = getLevel(game, segments[3]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const payload = await readJsonBody(request, { maxBytes: PREVIEW_REQUEST_BODY_MAX_BYTES });
      writeMazePreviewImageData(game, level, payload?.imageDataUrl);
      sendJson(response, 200, {
        fileName: level.fileName,
        levelId: level.id,
        message: `Saved preview for ${level.fileName}.`,
        previewUrl: buildMazePreviewData(game, level.fileName).previewUrl
      });
      return;
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "author") {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap || !isWorldLevelId(game, segments[3])) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method === "GET") {
        const level = getEditableLevel(game, segments[3]);
        if (!level) {
          sendHtml(response, 404, renderNotFound());
          return;
        }

        sendJson(response, 200, getLevelEditorState(game, level));
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const level = getEditableLevel(game, segments[3], payload?.fileName);
        if (!level) {
          sendHtml(response, 404, renderNotFound());
          return;
        }

        const editorState = sanitizeEditorPayload(game, payload);
        const levelPath = getLevelFilePath(game, level);
        fs.writeFileSync(levelPath, editorState.rawText, "utf8");
        worldMaps.ensureMazeWorldLevelMapped(game, level);
        buildWorlds.touchLocalWorld(game.id);
        sendJson(response, 200, {
          ...getLevelEditorState(game, level),
          message: `Saved ${level.fileName}.`,
          playUrl: `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}`
        });
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "world-map" &&
      segments[3] === "swap"
    ) {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const entries = worldMaps.swapMazeWorldRooms(
          game,
          String(payload?.firstLevelId || ""),
          String(payload?.secondLevelId || "")
        );
        worldMaps.writeMazeWorldMap(game.id, entries);
        buildWorlds.touchLocalWorld(game.id);
        sendJson(
          response,
          200,
          buildMazeWorldMapEditorData(getGame(game.id), {
            message: `Swapped ${payload.firstLevelId} and ${payload.secondLevelId}.`
          })
        );
        return;
      }

      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "world-map") {
      const game = getGame(segments[2]);
      if (!game || !game.worldMap) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      if (request.method === "GET") {
        sendJson(response, 200, buildMazeWorldMapEditorData(game));
        return;
      }

      if (request.method === "POST") {
        const payload = await readJsonBody(request);
        const rawLevels =
          payload && Object.prototype.hasOwnProperty.call(payload, "entries")
            ? payload.entries
            : payload?.levels;
        const entries = worldMaps.validateMazeWorldMapEntries(game.id, game.levelFiles, rawLevels);
        worldMaps.writeMazeWorldMap(game.id, entries);
        buildWorlds.touchLocalWorld(game.id);
        sendJson(
          response,
          200,
          buildMazeWorldMapEditorData(getGame(game.id), {
            message: `Saved world_map.json with ${entries.length} placed tile${entries.length === 1 ? "" : "s"}.`
          })
        );
        return;
      }

      response.writeHead(405, { Allow: "GET, POST" });
      response.end();
      return;
    }

    sendHtml(response, 404, renderNotFound());
  }

  return {
    handleRequest
  };
}

function validateLocalApiRequest(request, url, segments) {
  const host = String(request.headers.host || "");
  if (!isLoopbackRequest(request)) {
    return {
      status: 403,
      message: "Local API requests require a loopback Host and TCP peer."
    };
  }

  const isLinkCallback =
    request.method === "GET" &&
    segments.length === 4 &&
    segments[1] === "remote" &&
    segments[2] === "link" &&
    segments[3] === "callback";
  if (isLinkCallback) {
    const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
    const fetchMode = String(request.headers["sec-fetch-mode"] || "").toLowerCase();
    const fetchDest = String(request.headers["sec-fetch-dest"] || "").toLowerCase();
    if (
      fetchSite &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none" &&
      (fetchMode !== "navigate" || fetchDest !== "document")
    ) {
      return { status: 403, message: "Local link callbacks require a top-level navigation." };
    }
  } else {
    const expectedOrigin = new URL(`http://${host}`).origin;
    const origin = String(request.headers.origin || "");
    if (origin && origin !== expectedOrigin) {
      return { status: 403, message: "Cross-site local API requests are not allowed." };
    }
    const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return { status: 403, message: "Cross-site local API requests are not allowed." };
    }
  }

  if (UNSAFE_METHODS.has(String(request.method || "").toUpperCase())) {
    const contentType = String(request.headers["content-type"] || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return { status: 415, message: "Local API mutations require application/json." };
    }
  }
  return null;
}

function isLoopbackRequest(request) {
  return (
    isLoopbackHost(request?.headers?.host) &&
    isLoopbackPeer(request?.socket?.remoteAddress)
  );
}

module.exports = {
  createRequestRouter
};
