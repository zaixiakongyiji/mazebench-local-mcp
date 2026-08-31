#!/usr/bin/env node

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  PROTOCOL_VERSION,
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
    description: "Claim and start the currently armed MazeBench game session, starting the timer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
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

  return { valid: true };
}

class StdioMcpAdapter {
  constructor() {
    this.serverUrl = process.env.MAZEBENCH_SERVER_URL || null;
    this.controllerToken = process.env.MAZEBENCH_LOCAL_MCP_TOKEN || null;
    this.controllerId = null;
    this.instanceId = null;

    this.initialized = false;
    this.clientInfo = null;

    this.activeRunId = null;
    this.leaseId = null;
    this.leaseEpoch = null;

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
      const client = url.protocol === "https:" ? https : http;
      const req = client.request(options, (res) => {
        let responseData = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseData += chunk));
        res.on("end", () => {
          if (requestId !== null) this.activeRequests.delete(requestId);
          try {
            const parsed = responseData ? JSON.parse(responseData) : null;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(parsed?.error || parsed?.message || `HTTP ${res.statusCode}`);
              err.statusCode = res.statusCode;
              err.data = parsed;
              reject(err);
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(responseData);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
            }
          }
        });
      });

      if (requestId !== null) {
        this.activeRequests.set(requestId, {
          abort: () => {
            req.destroy();
            const err = new Error("Request cancelled by client");
            err.code = "CANCELLED";
            reject(err);
          }
        });
      }

      req.on("error", (err) => {
        if (requestId !== null) this.activeRequests.delete(requestId);
        reject(err);
      });
      if (body) {
        req.write(typeof body === "string" ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  async connectServer(force = false) {
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
      for (let retry = 0; retry < 3; retry++) {
        if (!serverJson?.mcp_bootstrap_nonce) {
          try {
            serverJson = JSON.parse(fs.readFileSync(this.serverJsonPath, "utf8"));
          } catch (_e) {}
        }
        if (!serverJson?.mcp_bootstrap_nonce) {
          await new Promise((r) => setTimeout(r, 200));
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
          this.controllerToken = sessionRes.controller_token;
          this.controllerId = sessionRes.controller_id;
          this.instanceId = sessionRes.instance_id;
          exchanged = true;
          break;
        } catch (err) {
          if (err.statusCode === 403) {
            try {
              serverJson = JSON.parse(fs.readFileSync(this.serverJsonPath, "utf8"));
            } catch (_e) {}
            await new Promise((r) => setTimeout(r, 200));
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
      this.activeRunId = health.active_run_id;
    } catch (err) {
      logStderr(`Health check failed: ${err.message}`);
      if (!force) process.exit(1);
      throw err;
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (!this.activeRunId || !this.leaseId || !this.leaseEpoch) return;
      try {
        await this.httpRequest("POST", "/api/external-play/lease/heartbeat", {
          run_id: this.activeRunId,
          lease_id: this.leaseId,
          lease_epoch: this.leaseEpoch
        });
      } catch (err) {
        logStderr(`Heartbeat failed: ${err.message}`);
        if (err.statusCode === 409) {
          // Lease was revoked or expired
          this.stopHeartbeat();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async detach() {
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
          instructions: "MazeBench local MCP evaluation service. Call 'start' tool to claim session, then use 'observe' and action tools until terminal.",
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

      try {
        let proxyRes;
        try {
          if (!this.activeRunId) {
            await this.connectServer(true);
          }
          proxyRes = await this.httpRequest(
            "POST",
            "/api/external-play/mcp",
            {
              run_id: this.activeRunId,
              tool: toolName,
              arguments: toolArgs,
              lease_id: this.leaseId,
              lease_epoch: this.leaseEpoch,
              operation_id: `mcp-call-${id}-${Date.now()}`
            },
            {},
            id
          );
        } catch (requestErr) {
          if (
            requestErr.statusCode === 401 ||
            requestErr.statusCode === 403 ||
            requestErr.statusCode === 404
          ) {
            logStderr(`Request failed with status ${requestErr.statusCode}. Attempting to reconnect...`);
            this.controllerToken = null;
            await this.connectServer(true);
            proxyRes = await this.httpRequest(
              "POST",
              "/api/external-play/mcp",
              {
                run_id: this.activeRunId,
                tool: toolName,
                arguments: toolArgs,
                lease_id: this.leaseId,
                lease_epoch: this.leaseEpoch,
                operation_id: `mcp-call-${id}-${Date.now()}`
              },
              {},
              id
            );
          } else {
            throw requestErr;
          }
        }

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

        if (toolName === "start") {
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
                    status: proxyRes.status,
                    action_seq: 0,
                    observation,
                    game_won: false,
                    message: "MazeBench session armed and ready"
                  })
                }
              ],
              isError: false
            }
          });
          return;
        }

        sendStdout({
          jsonrpc: "2.0",
          id,
          result: proxyRes.result || proxyRes
        });
      } catch (err) {
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
