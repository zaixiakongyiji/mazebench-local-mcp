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

  const port = PORT;

  server.on("error", (error) => {
    console.error(`MazeBench: could not start on ${HOST}:${port} — ${error.message}`);
    process.exit(1);
  });

  server.on("listening", () => {
    const url = `http://${browserHostForBind(HOST)}:${port}`;
    console.log(`MazeBench running at ${url}`);
    if (externalPlay) {
      externalPlay.serverPort = port;
      externalPlay._writeServerJson();
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      handleShutdown();
      process.exit(0);
    });
  }
  process.on("exit", handleShutdown);

  server.listen(port, HOST);
}

startServer();
