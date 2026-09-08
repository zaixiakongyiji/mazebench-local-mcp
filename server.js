const fs = require("fs");
const path = require("path");
const http = require("http");
const { HOST, PORT, createRequestHandler, externalPlay } = require("./server/app");
const { browserHostForBind } = require("./server/network");

const server = http.createServer(createRequestHandler());

function handleShutdown() {
  if (externalPlay) {
    try {
      externalPlay.shutdown();
    } catch (_e) {}
  }
  if (process.env.MAZEBENCH_STATE_FILE) {
    try {
      if (fs.existsSync(process.env.MAZEBENCH_STATE_FILE)) {
        const content = JSON.parse(fs.readFileSync(process.env.MAZEBENCH_STATE_FILE, "utf8"));
        if (content.pid === process.pid) {
          fs.rmSync(process.env.MAZEBENCH_STATE_FILE, { force: true });
        }
      }
    } catch (_e) {}
  }
}

async function startServer() {
  if (externalPlay) {
    try {
      await externalPlay.initialize();
    } catch (err) {
      console.error("Failed to initialize ExternalPlayService:", err.message);
      process.exit(1);
    }
  }

  const basePort = Number(PORT) || 3000;
  const maxPort = basePort + 50;
  let currentPort = basePort;

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && currentPort < maxPort) {
      console.warn(`MazeBench: port ${currentPort} in use, trying ${currentPort + 1}...`);
      currentPort += 1;
      server.listen(currentPort, HOST);
      return;
    }
    console.error(`MazeBench: could not start on ${HOST}:${currentPort} — ${error.message}`);
    process.exit(1);
  });

  server.on("listening", () => {
    const url = `http://${browserHostForBind(HOST)}:${currentPort}`;
    console.log(`MazeBench running at ${url}`);
    if (externalPlay) {
      externalPlay.serverPort = currentPort;
      externalPlay._writeServerJson();
    }
    if (process.env.MAZEBENCH_STATE_FILE) {
      try {
        const statePath = process.env.MAZEBENCH_STATE_FILE;
        let existingState = {};
        if (fs.existsSync(statePath)) {
          try {
            existingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
          } catch (_e) {}
        }
        const updatedState = {
          ...existingState,
          pid: process.pid,
          host: HOST,
          port: currentPort,
          url
        };
        const stateTmp = `${statePath}.${process.pid}.tmp`;
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(stateTmp, JSON.stringify(updatedState, null, 2) + "\n", "utf8");
        fs.renameSync(stateTmp, statePath);
      } catch (_err) {}
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      handleShutdown();
      process.exit(0);
    });
  }
  process.on("exit", handleShutdown);

  server.listen(currentPort, HOST);
}

startServer();
