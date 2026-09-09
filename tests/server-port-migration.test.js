const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

// AC-R6: 服务端口占用自动换端口并同步元数据
async function testPortMigration() {
  console.log("Starting server port migration test (AC-R6)...");

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-port-test-"));
  const stateFilePath = path.join(tempHome, "custom-state.json");
  const serverJsonPath = path.join(tempHome, "server.json");

  // 选择测试基准端口
  const basePort = 38500 + Math.floor(Math.random() * 500);

  // 1. 预先占用 basePort
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.listen(basePort, "127.0.0.1", () => resolve());
    blocker.on("error", reject);
  });
  console.log(`  Dummy blocker listening on port ${basePort}`);

  // 2. 启动 server.js，配置 PORT=basePort
  const serverProc = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(basePort),
      HOST: "127.0.0.1",
      MAZEBENCH_DATA_HOME: tempHome,
      MAZEBENCH_STATE_FILE: stateFilePath
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let serverOutput = "";
  serverProc.stdout.on("data", (d) => {
    serverOutput += d.toString();
  });
  serverProc.stderr.on("data", (d) => {
    serverOutput += d.toString();
  });

  try {
    // 3. 等待服务自动迁移并写入元数据
    const expectedPort = basePort + 1;
    const deadline = Date.now() + 15000;
    let success = false;

    while (Date.now() < deadline) {
      if (fs.existsSync(stateFilePath) && fs.existsSync(serverJsonPath)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
          const serverData = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
          if (stateData.port === expectedPort && serverData.port === expectedPort) {
            success = true;
            break;
          }
        } catch (_e) {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(success, `服务未能在超时内迁移到端口 ${expectedPort}。输出:\n${serverOutput}`);

    // 4. 验证元数据与实际端口完全一致
    const stateData = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    const serverData = JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));

    assert.equal(stateData.port, expectedPort, "MAZEBENCH_STATE_FILE 端口必须为迁移后的新端口");
    assert.equal(serverData.port, expectedPort, "server.json 端口必须为迁移后的新端口");
    assert.match(stateData.url, new RegExp(`:${expectedPort}$`), "MAZEBENCH_STATE_FILE url 必须包含新端口");
    assert.match(serverData.url, new RegExp(`:${expectedPort}$`), "server.json url 必须包含新端口");

    // 5. 验证实际 HTTP 连通性
    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${expectedPort}/`, (res) => {
        resolve(res);
      }).on("error", reject);
    });
    assert.equal(response.statusCode, 200, "新端口必须正常响应 HTTP 请求");

    console.log(`  Port migration to ${expectedPort} verified successfully!`);
  } finally {
    serverProc.kill("SIGTERM");
    await new Promise((r) => {
      blocker.close(() => r());
    });
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  console.log("Server port migration test PASSED!");
}

testPortMigration().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
