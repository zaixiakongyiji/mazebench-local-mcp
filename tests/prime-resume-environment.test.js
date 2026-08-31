const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

try {
  const output = execFileSync(
    "uv",
    [
      "run",
      "--project",
      path.join(__dirname, "..", "environments", "mazebench"),
      "python",
      path.join(__dirname, "..", "scripts", "maze-verify-prime-resume.py"),
      "--self-test"
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.match(output, /deterministic replay ready/);
  console.log("prime resume environment tests passed");
} catch (error) {
  if (process.platform === "win32" && (error.stderr || "").includes("No module named 'fcntl'")) {
    console.log("prime resume environment tests skipped: verifiers requires POSIX fcntl");
  } else {
    throw error;
  }
}
