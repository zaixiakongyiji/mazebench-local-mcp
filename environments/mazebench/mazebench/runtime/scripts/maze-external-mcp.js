#!/usr/bin/env node

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { TERMINAL_STATUSES } = require("../server/external-run-groups");

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
const HEARTBEAT_INTERVAL_MS = 10000;

function resolveDataHome() {
  const custom = process.env.MAZEBENCH_DATA_HOME || process.env.MAZEBENCH_HOME;
  if (custom) {
    return path.resolve(custom.replace(/^~(?=$|\/|\\)/, os.homedir()));
  }
  return path.join(os.homedir(), ".mazebench");
}

function logStderr(msg) {
  process.stderr.write(`[mazebench-mcp] ${msg}\n`);
}

function sendStdout(jsonRpcObj) {
  process.stdout.write(`${JSON.stringify(jsonRpcObj)}\n`);
}

const TOOLS_MANIFEST = [
  {
    name: "start",
    description: "Claim an armed MazeBench run for the current controller. Provide the model name specified by the user; the result contains authoritative run instructions and initial observation.",
    inputSchema: {
      type: "object",
      required: ["model_name"],
      properties: {
        model_name: { type: "string", minLength: 1, maxLength: 128, description: "Model name specified by the user. Required when claiming a new run." }
      },
      additionalProperties: false
    }
  },
  {
    name: "resume",
    description: "Request authorization to resume an existing MazeBench run across sessions. Initiates an approval request and polls until approved on the local dashboard, then attaches to the run.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string", minLength: 1, maxLength: 128, description: "Run ID to resume." }
      },
      additionalProperties: false
    }
  },
  {
    name: "observe",
    description: "Get the current sanitized game observation without consuming an action turn.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "up",
    description: "Move the player character upward on screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "down",
    description: "Move the player character downward on screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "left",
    description: "Move the player character to the left on screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "right",
    description: "Move the player character to the right on screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "rotate_camera_up",
    description: "Rotate the camera view pitch upward (towards top-down view).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "rotate_camera_down",
    description: "Rotate the camera view pitch downward (towards side view).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "rotate_camera_left",
    description: "Rotate the camera view yaw 90 degrees counter-clockwise.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "rotate_camera_right",
    description: "Rotate the camera view yaw 90 degrees clockwise.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "undo",
    description: "Undo the last player move in the current room.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "reset",
    description: "Reset the current room to its state upon entry.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "go_to_level",
    description: "Teleport to a previously visited room coordinates (e.g. x='H', y='I').",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: {
        x: { type: "string", pattern: "^[A-Za-z]$", maxLength: 8 },
        y: { type: "string", pattern: "^[A-Za-z]$", maxLength: 8 }
      },
      additionalProperties: false
    }
  },
  {
    name: "action_sequence",
    description: "Apply up to 1,000 game actions in order. Returns compact step summaries and the final observation by default.",
    inputSchema: {
      type: "object",
      required: ["actions"],
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: { type: "string", minLength: 1, maxLength: 64 }
        },
        include_intermediate_observations: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  }
];

const VALID_TOOL_NAMES = new Set(TOOLS_MANIFEST.map((t) => t.name));

function validateToolArguments(toolName, args = {}) {
  if (!VALID_TOOL_NAMES.has(toolName)) {
    return { valid: false, error: `Unknown tool '${toolName}'` };
  }

  const toolDef = TOOLS_MANIFEST.find((t) => t.name === toolName);
  if (!toolDef) return { valid: false, error: `Tool ${toolName} not defined` };

  const schema = toolDef.inputSchema;
  if (schema.additionalProperties === false) {
    const allowedKeys = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(args || {})) {
      if (!allowedKeys.has(key)) {
        return { valid: false, error: `Unknown argument '${key}' for tool '${toolName}'` };
      }
    }
  }

  if (Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (args[req] === undefined || args[req] === null || args[req] === "") {
        return { valid: false, error: `Missing required argument '${req}' for tool '${toolName}'` };
      }
    }
  }

  if (toolName === "go_to_level") {
    if (!/^[A-Za-z]$/.test(String(args.x || "")) || !/^[A-Za-z]$/.test(String(args.y || ""))) {
      return { valid: false, error: "go_to_level x and y arguments must be a single letter (e.g. 'H', 'I')" };
    }
  }

  if (toolName === "start") {
    if (args.run_id !== undefined) {
      return { valid: false, error: "start does not accept run_id; use resume({run_id}) to request run resumption" };
    }
    if (args.model_name !== undefined) {
      if (typeof args.model_name !== "string" || !args.model_name.trim() || args.model_name.trim().length > 128) {
        return { valid: false, error: "start model_name must be a non-empty string of at most 128 characters" };
      }
      if (/[\u0000-\u001f\u007f]/.test(args.model_name.trim())) {
        return { valid: false, error: "start model_name must not contain control characters" };
      }
    }
  }

  if (toolName === "resume") {
    if (typeof args.run_id !== "string" || !args.run_id.trim() || args.run_id.trim().length > 128) {
      return { valid: false, error: "resume run_id must be a non-empty string of at most 128 characters" };
    }
    if (/[\u0000-\u001f\u007f]/.test(args.run_id.trim())) {
      return { valid: false, error: "resume run_id must not contain control characters" };
    }
  }

  if (toolName === "action_sequence") {
    if (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > 1000) {
      return { valid: false, error: "action_sequence actions must contain between 1 and 1000 items" };
    }
    for (let index = 0; index < args.actions.length; index += 1) {
      if (typeof args.actions[index] !== "string" || !args.actions[index].trim() || args.actions[index].trim().length > 64) {
        return { valid: false, error: `actions[${index}] must be a non-empty string of at most 64 characters` };
      }
      const parsed = parseSequenceAction(args.actions[index]);
      if (!parsed.ok) return { valid: false, error: `actions[${index}]: ${parsed.error}` };
    }
    if (args.include_intermediate_observations !== undefined && typeof args.include_intermediate_observations !== "boolean") {
      return { valid: false, error: "include_intermediate_observations must be a boolean" };
    }
  }

  return { valid: true };
}

function parseSequenceAction(rawAction) {
  const action = String(rawAction || "").trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
  const direct = new Map([
    ["up", "up"], ["down", "down"], ["left", "left"], ["right", "right"],
    ["rotate camera up", "rotate_camera_up"], ["rotate camera down", "rotate_camera_down"],
    ["rotate camera left", "rotate_camera_left"], ["rotate camera right", "rotate_camera_right"],
    ["undo", "undo"], ["reset", "reset"]
  ]);
  if (direct.has(action)) return { ok: true, tool: direct.get(action), arguments: {} };
  const goto = action.match(/^go to level ([a-z]) ([a-z])$/i);
  if (goto) return { ok: true, tool: "go_to_level", arguments: { x: goto[1].toUpperCase(), y: goto[2].toUpperCase() } };
  return { ok: false, error: `unsupported action '${rawAction}'` };
}

function parseToolResultPayload(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text !== "string") return {};
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { message: text };
  }
}

class StdioMcpAdapter {
  constructor() {
    if (process.env.MAZEBENCH_LOCAL_MCP_TOKEN) {
      logStderr("Error: MAZEBENCH_LOCAL_MCP_TOKEN environment variable is deprecated and unsupported. Each MCP adapter instance automatically negotiates an isolated controller session.");
      process.exit(1);
    }
    this.serverUrl = process.env.MAZEBENCH_SERVER_URL || null;
    this.controllerToken = null;
    this.controllerId = null;
    this.instanceId = null;

    this.initialized = false;
    this.clientInfo = null;

    this.claimedState = null;
    this.authorizationRequired = false;
    this.pendingResume = null;
    this.activeRunId = null;
    this.leaseId = null;
    this.leaseEpoch = null;
    this.generation = 0;
    this.startInProgress = false;

    this.cancelledRequests = new Set();
    this.activeRequests = new Map();
    this.heartbeatTimer = null;
    this.dataHome = resolveDataHome();
    this.serverJsonPath = path.join(this.dataHome, "server.json");
  }

  async httpRequest(method, urlPath, body = null, headers = {}, requestId = null) {
    const url = new URL(urlPath, this.serverUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        ...headers
      }
    };

    if (this.controllerToken && !headers["Authorization"]) {
      options.headers["Authorization"] = `Bearer ${this.controllerToken}`;
    }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const client = url.protocol === "https:" ? https : http;
      let settled = false;
      let timer;
      let tracked;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (requestId !== null && this.activeRequests.get(requestId) === tracked) this.activeRequests.delete(requestId);
        if (err) {
          logStderr(`HTTP ${method} ${url.pathname} failed after ${Date.now() - startedAt}ms (${err.code || err.statusCode || "NETWORK_ERROR"})`);
          reject(err);
        } else resolve(value);
      };
      const req = client.request(options, (res) => {
        let responseData = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseData += chunk));
        res.on("error", (err) => finish(err));
        res.on("aborted", () => finish(Object.assign(new Error("HTTP response interrupted"), { code: "ECONNRESET" })));
        res.on("end", () => {
          try {
            const parsed = responseData ? JSON.parse(responseData) : null;
            if (res.statusCode >= 200 && res.statusCode < 300) finish(null, parsed);
            else finish(Object.assign(new Error(parsed?.error || parsed?.message || `HTTP ${res.statusCode}`), { statusCode: res.statusCode, data: parsed }));
          } catch (err) {
            finish(Object.assign(new Error("Invalid JSON response from MazeBench"), { code: "INVALID_RESPONSE", statusCode: res.statusCode }));
          }
        });
      });
      const abort = (err) => {
        finish(err);
        req.destroy();
      };
      tracked = { abort: () => abort(Object.assign(new Error("Request cancelled by client"), { code: "CANCELLED" })) };
      if (requestId !== null) this.activeRequests.set(requestId, tracked);
      // 总期限覆盖连接、响应头和响应体，避免半响应或慢速流无限占用连接。
      const timeoutMs = this.httpTimeoutMs || (url.pathname.endsWith("/heartbeat") ? 8000 : 20000);
      timer = setTimeout(() => abort(Object.assign(new Error(`MazeBench request timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })), timeoutMs);
      req.on("error", (err) => finish(err));
      if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
      req.end();
    });
  }

  async connectServer(force = false, { forResume = false, assertCurrent = () => {} } = {}) {
    if (this.claimedState && (force || !this.controllerToken)) {
      this.requireResumption();
      if (!forResume) throw new Error("Controller authentication lost. Use resume to request resumption approval.");
    }
    let serverJson = null;
    for (let retry = 0; retry < 3; retry++) {
      if (fs.existsSync(this.serverJsonPath)) {
        try {
          serverJson = JSON.parse(fs.readFileSync(this.serverJsonPath, "utf8"));
          break;
        } catch (_e) {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!serverJson && !this.serverUrl) {
      logStderr("MazeBench server is not running. Please start it first using 'mazebench launch'.");
      if (!force) process.exit(1);
      throw new Error("MazeBench server is not running.");
    }

    if (serverJson) {
      this.serverUrl = serverJson.url;
      this.instanceId = serverJson.instance_id;
    }

    // Exchange mcp_bootstrap_nonce for controller token if token not given or forced
    if (force || !this.controllerToken) {
      let exchanged = false;
      for (let retry = 0; retry < 12; retry++) {
        try {
          serverJson = JSON.parse(fs.readFileSync(this.serverJsonPath, "utf8"));
        } catch (_e) {}
        if (!serverJson?.mcp_bootstrap_nonce) {
          await new Promise((r) => setTimeout(r, 50 + retry * 20));
          continue;
        }

        try {
          const sessionRes = await this.httpRequest(
            "POST",
            "/api/external-play/controller/session",
            {
              mcp_bootstrap_nonce: serverJson.mcp_bootstrap_nonce,
              clientInfo: this.clientInfo || {}
            }
          );
          assertCurrent();
          this.controllerToken = sessionRes.controller_token;
          this.controllerId = sessionRes.controller_id;
          this.instanceId = sessionRes.instance_id;
          this.generation += 1;
          exchanged = true;
          break;
        } catch (err) {
          if (err.statusCode === 403) {
            serverJson = null;
            await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50) + retry * 20));
            continue;
          }
          logStderr(`Failed to exchange controller session token: ${err.message}`);
          break;
        }
      }

      if (!exchanged) {
        logStderr("Failed to authenticate with MazeBench External Play service.");
        if (!force) process.exit(1);
        throw new Error("Failed to authenticate with MazeBench External Play service.");
      }
    }

    // Check health
    try {
      const health = await this.httpRequest("GET", "/api/external-play/health");
      if (this.instanceId && health.instance_id !== this.instanceId) {
        logStderr(`Server instance mismatch: expected ${this.instanceId}, got ${health.instance_id}`);
        if (!force) process.exit(1);
        throw new Error(`Server instance mismatch: expected ${this.instanceId}, got ${health.instance_id}`);
      }
      if (this.leaseId && !this.activeRunId) this.activeRunId = health.active_run_id || null;
    } catch (err) {
      logStderr(`Health check failed: ${err.message}`);
      if (!force) process.exit(1);
      throw err;
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const heartbeatGen = this.generation;
    const heartbeatRunId = this.activeRunId;
    const heartbeatLeaseId = this.leaseId;
    const heartbeatLeaseEpoch = this.leaseEpoch;

    let inFlight = false;
    this.heartbeatTimer = setInterval(async () => {
      if (inFlight) return;
      if (
        this.generation !== heartbeatGen ||
        this.activeRunId !== heartbeatRunId ||
        this.leaseId !== heartbeatLeaseId ||
        this.leaseEpoch !== heartbeatLeaseEpoch ||
        !this.activeRunId ||
        !this.leaseId
      ) {
        return;
      }
      inFlight = true;
      try {
        await this.httpRequest("POST", "/api/external-play/lease/heartbeat", {
          run_id: heartbeatRunId,
          lease_id: heartbeatLeaseId,
          lease_epoch: heartbeatLeaseEpoch
        });
      } catch (err) {
        if (this.generation !== heartbeatGen || this.leaseId !== heartbeatLeaseId) return;
        logStderr(`Heartbeat failed: ${err.message}`);
        if ([401, 403, 404, 409].includes(err.statusCode)) {
          if (err.statusCode === 401 || err.statusCode === 403) this.controllerToken = null;
          this.requireResumption();
        }
      }
      finally { inFlight = false; }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  requireResumption() {
    this.authorizationRequired = true;
    this.leaseId = null;
    this.leaseEpoch = null;
    this.stopHeartbeat();
    this.stopResumePolling();
  }

  _cleanupSession({ resetClaimedState = true } = {}) {
    this.generation += 1;
    this.stopHeartbeat();
    this.stopResumePolling();
    this.activeRunId = null;
    this.leaseId = null;
    this.leaseEpoch = null;
    this.authorizationRequired = false;
    if (resetClaimedState) {
      this.claimedState = null;
    }
  }

  async _authenticateWithPreviousRun(previousRunId, requestId, assertCurrent = () => {}) {
    let serverJson = null;
    for (let retry = 0; retry < 3; retry++) {
      if (fs.existsSync(this.serverJsonPath)) {
        try {
          serverJson = JSON.parse(fs.readFileSync(this.serverJsonPath, "utf8"));
          break;
        } catch (_e) {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!serverJson && !this.serverUrl) {
      logStderr("MazeBench server is not running. Please start it first using 'mazebench launch'.");
      throw new Error("MazeBench server is not running.");
    }

    if (serverJson) {
      this.serverUrl = serverJson.url;
      this.instanceId = serverJson.instance_id;
    }

    let sessionRes = null;
    for (let retry = 0; retry < 12; retry++) {
      assertCurrent();
      try {
        serverJson = JSON.parse(fs.readFileSync(this.serverJsonPath, "utf8"));
      } catch (_e) {}
      if (!serverJson?.mcp_bootstrap_nonce) {
        await new Promise((r) => setTimeout(r, 50 + retry * 20));
        continue;
      }

      try {
        sessionRes = await this.httpRequest(
          "POST",
          "/api/external-play/controller/session",
          {
            mcp_bootstrap_nonce: serverJson.mcp_bootstrap_nonce,
            clientInfo: this.clientInfo || {},
            previous_run_id: previousRunId
          }, {}, requestId
        );
        assertCurrent();
        break;
      } catch (err) {
        if (err.statusCode === 403) {
          serverJson = null;
          await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50) + retry * 20));
          continue;
        }
        throw err;
      }
    }

    if (!sessionRes) {
      logStderr("Failed to authenticate with MazeBench External Play service.");
      throw new Error("Failed to authenticate with MazeBench External Play service.");
    }

    assertCurrent();
    return sessionRes;
  }

  stopResumePolling() {
    const pending = this.pendingResume;
    this.pendingResume = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    const active = this.activeRequests.get(pending.httpRequestId);
    if (active) {
      this.activeRequests.delete(pending.httpRequestId);
      active.abort();
    }
  }

  attachResumedLease(data) {
    this.stopResumePolling();
    this.pendingStart = null;
    this.generation += 1;
    this.activeRunId = data.run_id;
    this.leaseId = data.lease_id;
    this.leaseEpoch = data.lease_epoch;
    this.claimedState = this.activeRunId;
    this.authorizationRequired = false;
    this.startHeartbeat();
  }

  startResumePolling(requestId) {
    this.stopResumePolling();
    const currentGen = this.generation;
    const pending = { requestId, token: this.controllerToken, generation: currentGen, httpRequestId: Symbol("resume-poll"), timer: null };
    this.pendingResume = pending;
    const poll = async () => {
      if (this.pendingResume !== pending || this.generation !== currentGen) return;
      try {
        const data = await this.httpRequest(
          "GET", `/api/external-play/resume-requests/${encodeURIComponent(requestId)}/status`,
          null, {}, pending.httpRequestId
        );
        // 取消或换会话后，迟到的审批响应不能重新附着租约。
        if (
          this.pendingResume !== pending ||
          this.generation !== currentGen ||
          this.controllerToken !== pending.token
        ) return;
        if (data.status === "approved") {
          this.attachResumedLease(data);
          logStderr(`Resume approved for ${data.run_id}. Lease attached; call observe or resume to retrieve the current state.`);
          return;
        }
        if (data.status !== "pending_approval") {
          this.stopResumePolling();
          logStderr(`Resume request ${requestId} ended: ${data.status}. Call resume to request approval again.`);
          return;
        }
        pending.timer = setTimeout(poll, 2000);
      } catch (err) {
        if (this.pendingResume !== pending || this.generation !== currentGen) return;
        this.stopResumePolling();
        if (err.statusCode === 401 || err.statusCode === 403) {
          this.controllerToken = null;
          if (this.claimedState) this.requireResumption();
        }
        logStderr(`Resume polling stopped: ${err.message}. Call resume to request approval again.`);
      }
    };
    pending.timer = setTimeout(poll, 2000);
  }

  async detach() {
    this.generation += 1;
    this.stopResumePolling();
    this.stopHeartbeat();
    if (this.activeRunId && this.leaseId && this.leaseEpoch) {
      try {
        await this.httpRequest("POST", "/api/external-play/lease/detach", {
          run_id: this.activeRunId,
          lease_id: this.leaseId,
          lease_epoch: this.leaseEpoch
        });
      } catch (_e) {}
    }
  }

  _sendStartSuccess(id, proxyRes) {
    this.generation += 1;
    this.authorizationRequired = false;
    if (proxyRes.run_id) {
      this.activeRunId = proxyRes.run_id;
      this.claimedState = this.activeRunId;
    }
    if (proxyRes.lease_id && proxyRes.lease_epoch) {
      this.leaseId = proxyRes.lease_id;
      this.leaseEpoch = proxyRes.lease_epoch;
      this.startHeartbeat();
    }
    const observation = proxyRes.observation || (
      proxyRes.sanitized_result?.content?.[0]?.text
        ? (() => {
            try {
              return JSON.parse(proxyRes.sanitized_result.content[0].text).observation;
            } catch (_e) {
              return {};
            }
          })()
        : {}
    ) || {};
    sendStdout({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              run_id: this.activeRunId,
              ...(proxyRes.group_id ? {
                group_id: proxyRes.group_id,
                entry_id: proxyRes.entry_id,
                group_mode: proxyRes.group_mode
              } : {}),
              model_name: proxyRes.model_name,
              harness: proxyRes.harness,
              instructions_version: proxyRes.instructions_version,
              run_instructions: proxyRes.run_instructions,
              status: proxyRes.status,
              action_seq: proxyRes.action_seq ?? observation.action_count ?? 0,
              observation,
              game_won: Boolean(proxyRes.game_won),
              ended: Boolean(proxyRes.ended),
              ...(proxyRes.outcome ? { outcome: proxyRes.outcome } : {}),
              ...(proxyRes.max_actions ? {
                max_actions: proxyRes.max_actions,
                actions_remaining: proxyRes.actions_remaining
              } : {}),
              ...(proxyRes.duration_ms ? {
                duration_ms: proxyRes.duration_ms,
                deadline_at: proxyRes.deadline_at,
                time_remaining_ms: proxyRes.time_remaining_ms
              } : {}),
              message: "MazeBench session armed and ready"
            })
          }
        ],
        isError: false
      }
    });
  }

  async handleRequest(request) {
    const { id, method, params } = request;

    // Handle notifications
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") {
        logStderr("Received notifications/initialized.");
      } else if (method === "notifications/cancelled") {
        if (params?.requestId !== undefined) {
          const reqId = params.requestId;
          this.cancelledRequests.add(reqId);
          if (this.activeRequests.has(reqId)) {
            const active = this.activeRequests.get(reqId);
            this.activeRequests.delete(reqId);
            active.abort();
          }
          logStderr(`Received notifications/cancelled for requestId ${params.requestId}.`);
        }
      }
      return;
    }

    if (method === "initialize") {
      const clientVersion = params?.protocolVersion || "unknown";
      this.clientInfo = params?.clientInfo || { name: "unknown" };

      if (!SUPPORTED_PROTOCOL_VERSIONS.has(clientVersion)) {
        sendStdout({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Unsupported protocol version '${clientVersion}'. Supported: ${Array.from(SUPPORTED_PROTOCOL_VERSIONS).join(", ")}`
          }
        });
        return;
      }

      await this.connectServer();
      this.initialized = true;

      sendStdout({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientVersion,
          serverInfo: {
            name: "mazebench",
            version: "1.0.0"
          },
          instructions: "Create a MazeBench session first. Call start with the model_name specified by the user, or call resume with run_id to resume an existing run across sessions. Then follow the returned run_instructions until the run reaches a terminal state.",
          capabilities: {
            tools: { listChanged: false }
          }
        }
      });
      return;
    }

    if (!this.initialized) {
      sendStdout({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32002,
          message: "Server not initialized"
        }
      });
      return;
    }

    if (method === "ping") {
      sendStdout({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      sendStdout({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS_MANIFEST
        }
      });
      return;
    }

    if (method === "tools/call") {
      // Check if this request was cancelled before execution
      if (this.cancelledRequests.has(id)) {
        this.cancelledRequests.delete(id);
        sendStdout({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32800,
            message: "Request cancelled by client"
          }
        });
        return;
      }

      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      const validation = validateToolArguments(toolName, toolArgs);
      if (!validation.valid) {
        sendStdout({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Invalid params: ${validation.error}`
          }
        });
        return;
      }

      if (toolName === "start" || toolName === "resume") {
        if (this.startInProgress) {
          sendStdout({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: "Error: A start operation is already in progress or a resume transition is in progress for this adapter." }],
              isError: true
            }
          });
          return;
        }
        this.startInProgress = true;
      }

      // 请求代次必须在 catch 可见；只有本请求主动切换认证时才更新。
      let requestGen = this.generation;
      const ensureCurrent = () => {
        if (this.cancelledRequests.has(id)) {
          throw Object.assign(new Error("Request cancelled by client"), { code: "CANCELLED" });
        }
        if (this.generation !== requestGen) {
          throw new Error("Session changed while request was in progress; request stopped.");
        }
      };
      const reauthenticateEndedRun = async () => {
        const previousRunId = this.claimedState;
        let data;
        try {
          data = await this._authenticateWithPreviousRun(previousRunId, id, ensureCurrent);
          ensureCurrent();
          const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
          if (data?.previous_run?.run_id !== previousRunId || data.previous_run.ended !== true ||
              !TERMINAL_STATUSES.has(data.previous_run.status) ||
              !nonempty(data.controller_token) || !nonempty(data.controller_id) ||
              !nonempty(data.instance_id) || data.instance_id !== this.instanceId) {
            throw new Error("Invalid previous_run verification. Please update the matching server and adapter.");
          }
        } catch (err) {
          ensureCurrent();
          this.requireResumption();
          if (err.data?.code === "RUN_RESUME_REQUIRED") {
            throw new Error(`Run ${previousRunId} requires resume approval before continuing.`);
          }
          if (err.data?.code === "PREVIOUS_RUN_UNVERIFIED") {
            throw new Error(`Previous run ${previousRunId} cannot be verified. Ask the user to check the service and run history.`);
          }
          throw err;
        }
        this._cleanupSession();
        this.controllerToken = data.controller_token;
        this.controllerId = data.controller_id;
        this.instanceId = data.instance_id;
        requestGen = this.generation;
        logStderr(`Previous run ${previousRunId} confirmed ended (${data.previous_run.status}). Session ready for explicit start.`);
      };
      const reconnect = async (forResume = false) => {
        ensureCurrent();
        const connectionGen = requestGen;
        await this.connectServer(true, { forResume, assertCurrent: ensureCurrent });
        if (this.generation !== connectionGen + 1) {
          throw new Error("Session changed during authentication; request stopped.");
        }
        requestGen = this.generation;
        ensureCurrent();
      };
      try {
        let proxyRes;
        ensureCurrent();
        if (toolName === "start") {
          if (this.pendingResume) {
            throw new Error("Run authorization required. A resume request is currently pending approval.");
          }
          if (this.claimedState && (this.authorizationRequired || !this.controllerToken)) {
            await reauthenticateEndedRun();
          }
        }

        if (toolName !== "resume" && toolName !== "start" && (this.authorizationRequired || this.pendingResume ||
            (this.claimedState && !this.controllerToken))) {
          throw new Error("Run authorization required. Use resume and wait for approval before continuing.");
        }

        if (toolName === "action_sequence") {
          if (!this.activeRunId || !this.leaseId || !this.leaseEpoch) {
            throw new Error("Call start or resume before action_sequence.");
          }
          const includeIntermediate = toolArgs.include_intermediate_observations === true;
          const steps = [];
          let finalObservation = null;
          let ended = false;
          let stopReason = null;

          const sequenceRunId = this.activeRunId;
          const sequenceLeaseId = this.leaseId;
          const sequenceLeaseEpoch = this.leaseEpoch;
          for (let index = 0; index < toolArgs.actions.length; index += 1) {
            ensureCurrent();
            if (this.cancelledRequests.has(id)) {
              const cancelled = new Error("Request cancelled by client");
              cancelled.code = "CANCELLED";
              throw cancelled;
            }
            const action = toolArgs.actions[index];
            const parsedAction = parseSequenceAction(action);
            const stepResponse = await this.httpRequest(
              "POST",
              "/api/external-play/mcp",
              {
                run_id: sequenceRunId,
                tool: parsedAction.tool,
                arguments: parsedAction.arguments,
                lease_id: sequenceLeaseId,
                lease_epoch: sequenceLeaseEpoch,
                operation_id: `mcp-seq-${crypto.randomUUID()}-${index}`
              },
              {},
              id
            );
            ensureCurrent();
            const stepResult = stepResponse?.result || stepResponse;
            const payload = parseToolResultPayload(stepResult);
            finalObservation = payload.observation || finalObservation;
            const playerDead = Boolean(payload.player_dead || payload.observation?.player_dead);
            ended = Boolean(payload.ended);
            steps.push({
              index,
              action,
              action_seq: payload.action_seq ?? null,
              accepted: !stepResult?.isError,
              player_dead: playerDead,
              ended,
              ...(includeIntermediate ? { observation: payload.observation || null } : {})
            });
            if (stepResult?.isError) {
              stopReason = payload.error || "action_error";
              break;
            }
            if (ended) {
              stopReason = payload.outcome || "action_limit";
              break;
            }
            if (playerDead) {
              stopReason = "player_dead";
              break;
            }
          }

          if (ended) {
            if (this.generation === requestGen) {
              this._cleanupSession({ resetClaimedState: false });
            }
          }
          sendStdout({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify({
                  requested_count: toolArgs.actions.length,
                  attempted_count: steps.length,
                  completed_count: steps.filter((step) => step.accepted).length,
                  stopped_early: steps.length < toolArgs.actions.length,
                  stop_reason: stopReason,
                  steps,
                  final_observation: finalObservation,
                  ended
                })
              }],
              isError: false
            }
          });
          return;
        }

        if (toolName === "resume") {
          this.stopResumePolling();
          const targetRunId = toolArgs?.run_id;
          if (!targetRunId || typeof targetRunId !== "string") {
            sendStdout({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: "Missing or invalid required argument: run_id"
              }
            });
            return;
          }

          if (!this.controllerToken) {
            await reconnect(true);
          }

          const resumeOpId = `mcp-resume-${id}-${crypto.randomUUID()}`;
          let initialRes;
          try {
            initialRes = await this.httpRequest(
              "POST",
              "/api/external-play/mcp",
              {
                tool: "resume",
                arguments: { run_id: targetRunId },
                operation_id: resumeOpId
              },
              {},
              id
            );
          } catch (requestErr) {
            ensureCurrent();
            if (
              requestErr.statusCode === 401 ||
              requestErr.statusCode === 403 ||
              requestErr.statusCode === 404
            ) {
              logStderr(`Resume request failed with status ${requestErr.statusCode}. Attempting to reconnect...`);
              if (requestErr.statusCode === 401 || requestErr.statusCode === 403) {
                this.controllerToken = null;
              }
              await reconnect(true);
              initialRes = await this.httpRequest(
                "POST",
                "/api/external-play/mcp",
                {
                  tool: "resume",
                  arguments: { run_id: targetRunId },
                  operation_id: resumeOpId
                },
                {},
                id
              );
            } else {
              throw requestErr;
            }
          }

          ensureCurrent();
          const reqData = initialRes.result?.content?.[0]?.text
            ? JSON.parse(initialRes.result.content[0].text)
            : initialRes;

          if (reqData.status === "pending_approval") {
            this.stopHeartbeat();
            this.startResumePolling(reqData.request_id);
            logStderr(`Resume request submitted (${reqData.request_id}). Waiting for user approval on dashboard: ${reqData.review_url}`);
            sendStdout({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      status: "pending_approval",
                      request_id: reqData.request_id,
                      run_id: reqData.run_id,
                      review_url: reqData.review_url,
                      message: reqData.message || "Resume request submitted. Resumption must be approved by the user in the local web interface before play can continue."
                    })
                  }
                ],
                isError: false
              }
            });
            return;
          }

          if (reqData.status === "approved") {
            this.attachResumedLease(reqData);

            const observation = reqData.observation || {};
            sendStdout({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      run_id: this.activeRunId,
                      ...(reqData.group_id ? {
                        group_id: reqData.group_id,
                        entry_id: reqData.entry_id,
                        group_mode: reqData.group_mode
                      } : {}),
                      model_name: reqData.model_name,
                      harness: reqData.harness,
                      instructions_version: reqData.instructions_version,
                      run_instructions: reqData.run_instructions,
                      status: reqData.run_status || "active",
                      action_seq: reqData.action_seq ?? observation.action_count ?? 0,
                      observation,
                      game_won: Boolean(reqData.game_won),
                      ended: Boolean(reqData.ended),
                      ...(reqData.outcome ? { outcome: reqData.outcome } : {}),
                      ...(reqData.max_actions ? {
                        max_actions: reqData.max_actions,
                        actions_remaining: reqData.actions_remaining
                      } : {}),
                      ...(reqData.duration_ms ? {
                        duration_ms: reqData.duration_ms,
                        deadline_at: reqData.deadline_at,
                        time_remaining_ms: reqData.time_remaining_ms
                      } : {}),
                      message: "MazeBench run resumed and lease attached successfully"
                    })
                  }
                ],
                isError: false
              }
            });
            return;
          }

          throw new Error(reqData.message || `Resume request returned status ${reqData.status}`);
        }

        const retryingStart = toolName === "start" && Boolean(this.pendingStart);
        const startFingerprint = JSON.stringify(toolArgs);
        if (toolName === "start" && this.pendingStart && this.pendingStart.fingerprint !== startFingerprint) {
          throw new Error("Previous start outcome is unknown. Retry start with the same arguments first.");
        }
        const callOperationId = toolName === "start" && this.pendingStart
          ? this.pendingStart.operationId : `mcp-call-${id}-${crypto.randomUUID()}`;
        if (toolName === "start" && !this.pendingStart) this.pendingStart = { operationId: callOperationId, fingerprint: startFingerprint };
        const callTool = () => {
          ensureCurrent();
          if (toolName === "start") {
            if (this.pendingStart?.controllerToken && this.pendingStart.controllerToken !== this.controllerToken) {
              throw new Error("Previous start outcome is unknown and controller changed. Request resume approval for the claimed run.");
            }
            this.pendingStart = { operationId: callOperationId, fingerprint: startFingerprint, controllerToken: this.controllerToken };
          }
          return this.httpRequest("POST", "/api/external-play/mcp", {
            run_id: toolName === "start" ? undefined : this.activeRunId,
            tool: toolName,
            arguments: toolArgs,
            lease_id: this.leaseId,
            lease_epoch: this.leaseEpoch,
            operation_id: callOperationId
          }, {}, id);
        };
        if (!this.controllerToken) await reconnect();
        try {
          proxyRes = await callTool();
        } catch (err) {
          ensureCurrent();
          if (![401, 403, 404].includes(err.statusCode)) {
            // 保留未知认领的幂等 ID；网络失败后显式重试不得领取新席位。
            if (toolName === "start" && err.statusCode >= 400 && err.statusCode < 500) this.pendingStart = null;
            throw err;
          }
          if (toolName === "start" && [401, 403].includes(err.statusCode)) {
            if (retryingStart) throw new Error("Previous start outcome is unknown and authentication is no longer valid. Request resume approval for the claimed run.");
            this.pendingStart = null;
          }
          if (err.statusCode === 401 || err.statusCode === 403) {
            this.controllerToken = null;
            if (toolName === "start" && this.claimedState) {
              await reauthenticateEndedRun();
            } else if (this.claimedState) {
              this.requireResumption();
              throw new Error(`Controller authentication lost for claimed run ${this.claimedState}. Use resume tool to request resumption approval.`);
            } else {
              await reconnect();
            }
          } else {
            await reconnect();
          }
          proxyRes = await callTool();
        }
        ensureCurrent();
        if (toolName === "start") {
          this.pendingStart = null;
          this._sendStartSuccess(id, proxyRes);
          return;
        }

        const result = proxyRes.result || proxyRes;
        if (parseToolResultPayload(result).ended) {
          if (this.generation === requestGen) {
            this._cleanupSession({ resetClaimedState: false });
          }
        }
        sendStdout({
          jsonrpc: "2.0",
          id,
          result
        });
      } catch (err) {
        if ((err.statusCode === 401 || err.statusCode === 403) && this.claimedState) {
          if (this.generation === requestGen) {
            this.controllerToken = null;
            this.requireResumption();
          }
        }
        if (err.code === "CANCELLED" || this.cancelledRequests.has(id)) {
          this.cancelledRequests.delete(id);
          sendStdout({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32800,
              message: "Request cancelled by client"
            }
          });
          return;
        }
        sendStdout({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true
          }
        });
      } finally {
        if (toolName === "start" || toolName === "resume") {
          this.startInProgress = false;
        }
      }
      return;
    }

    sendStdout({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method '${method}' not found`
      }
    });
  }

  start() {
    let buffer = Buffer.alloc(0);

    process.stdin.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      this._processBuffer();
    });

    this._processBuffer = () => {
      while (true) {
        // 1. Look for Content-Length framing delimiter
        const headerEnd = buffer.indexOf("\r\n\r\n");
        const altHeaderEnd = buffer.indexOf("\n\n");
        let effectiveHeaderEnd = -1;
        let delimiterLen = 0;

        if (headerEnd !== -1 && (altHeaderEnd === -1 || headerEnd <= altHeaderEnd)) {
          effectiveHeaderEnd = headerEnd;
          delimiterLen = 4;
        } else if (altHeaderEnd !== -1) {
          effectiveHeaderEnd = altHeaderEnd;
          delimiterLen = 2;
        }

        if (effectiveHeaderEnd !== -1) {
          const headerStr = buffer.slice(0, effectiveHeaderEnd).toString("utf8");
          const match = headerStr.match(/Content-Length:\s*(\d+)/i);
          if (match) {
            const contentLength = parseInt(match[1], 10);
            const totalRequired = effectiveHeaderEnd + delimiterLen + contentLength;
            if (buffer.length >= totalRequired) {
              const bodyBuf = buffer.slice(effectiveHeaderEnd + delimiterLen, totalRequired);
              buffer = buffer.slice(totalRequired);
              try {
                const req = JSON.parse(bodyBuf.toString("utf8"));
                this.handleRequest(req);
              } catch (err) {
                sendStdout({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
              }
              continue;
            }
            break; // need more bytes
          }
        }

        // 2. Standard JSONL (line delimited) fallback
        const newlineIdx = buffer.indexOf(10); // '\n' = 10
        if (newlineIdx !== -1) {
          const lineBuf = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          const lineStr = lineBuf.toString("utf8").trim();
          if (lineStr.length > 0) {
            try {
              const req = JSON.parse(lineStr);
              this.handleRequest(req);
            } catch (err) {
              sendStdout({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            }
          }
          continue;
        }

        break;
      }
    };

    const cleanup = async () => {
      await this.detach();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.stdin.on("end", cleanup);
  }
}

if (require.main === module) {
  const adapter = new StdioMcpAdapter();
  adapter.start();
}

module.exports = { StdioMcpAdapter, TOOLS_MANIFEST, validateToolArguments };
