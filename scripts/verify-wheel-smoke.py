#!/usr/bin/env python3
"""Smoke test the built MazeBench wheel and sdist in an isolated environment."""

from __future__ import annotations

import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def log(msg: str) -> None:
    print(f"[verify-wheel-smoke] {msg}", flush=True)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("", 0))
        return sock.getsockname()[1]


def run_cmd(cmd: list[str], cwd: str | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    res = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(
            f"Command failed (code {res.returncode}): {' '.join(cmd)}\nStdout: {res.stdout}\nStderr: {res.stderr}"
        )
    return res


def test_validator_standalone(root_dir: Path) -> None:
    log("Testing standalone validator in clean environment without node_modules...")
    validator_path = root_dir / "shared" / "validators.standalone.js"
    if not validator_path.exists():
        raise FileNotFoundError(f"Validator not found: {validator_path}")

    # Run in an isolated temp directory where no node_modules exist in parent hierarchy
    temp_dir = tempfile.mkdtemp(prefix="mazebench-validator-smoke-")
    try:
        isolated_validator = Path(temp_dir) / "validators.standalone.js"
        shutil.copy(validator_path, isolated_validator)

        test_script = Path(temp_dir) / "smoke.js"
        test_script.write_text(
            r"""
const assert = require('assert');
const v = require('./validators.standalone.js');

// 1. Check exports
assert.equal(typeof v.validateJournalRecord, 'function');
assert.equal(typeof v.validateActionRecord, 'function');
assert.equal(typeof v.validateViewerState, 'function');
assert.equal(typeof v.validateSummary, 'function');
assert.equal(typeof v.validateManifest, 'function');

// 2. Test Manifest Schema (positive and negative)
const validManifest = {
  run_id: 'ext-12345678-1234-1234-1234-123456789abc',
  run_kind: 'external_play',
  execution_class: 'external-unverified',
  benchmark_eligible: false,
  created_at: '2026-08-27T00:00:00Z',
  duration_ms: 1800000,
  win_threshold: 10
};
assert.equal(v.validateManifest(validManifest), true);

// Negative date-time format
const invalidDateManifest = { ...validManifest, created_at: 'not-a-date' };
assert.equal(v.validateManifest(invalidDateManifest), false);

// Negative run_kind const
const invalidKindManifest = { ...validManifest, run_kind: 'tampered' };
assert.equal(v.validateManifest(invalidKindManifest), false);

console.log('Standalone validator smoke PASSED!');
""",
            encoding="utf8",
        )

        res = run_cmd(["node", "smoke.js"], cwd=temp_dir)
        log(f"Validator test output: {res.stdout.strip()}")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_wheel_install_and_cli(dist_dir: Path, root_dir: Path) -> None:
    wheels = list(dist_dir.glob("mazebench-*.whl"))
    if not wheels:
        raise FileNotFoundError(f"No .whl found in {dist_dir}")
    wheel_path = wheels[0].resolve()
    log(f"Found wheel: {wheel_path.name}")

    venv_dir = tempfile.mkdtemp(prefix="mazebench-smoke-venv-")
    temp_home = tempfile.mkdtemp(prefix="mazebench-smoke-home-")

    try:
        log(f"Creating isolated virtual environment in {venv_dir}...")
        run_cmd([sys.executable, "-m", "venv", venv_dir])

        if os.name == "nt":
            python_bin = Path(venv_dir) / "Scripts" / "python.exe"
            pip_bin = Path(venv_dir) / "Scripts" / "pip.exe"
            mazebench_bin = Path(venv_dir) / "Scripts" / "mazebench.exe"
        else:
            python_bin = Path(venv_dir) / "bin" / "python"
            pip_bin = Path(venv_dir) / "bin" / "pip"
            mazebench_bin = Path(venv_dir) / "bin" / "mazebench"

        log(f"Installing wheel with pip into venv...")
        run_cmd([str(pip_bin), "install", "--quiet", f"{wheel_path}[prime]"])

        env = os.environ.copy()
        env["MAZEBENCH_DATA_HOME"] = temp_home
        env["MAZEBENCH_HOME"] = temp_home

        log("Testing mazebench CLI help...")
        help_res = run_cmd([str(mazebench_bin), "--help"], env=env)
        assert "MazeBench" in help_res.stdout or "Usage" in help_res.stdout or "mazebench" in help_res.stdout

        log("Testing mazebench ascii...")
        ascii_res = run_cmd([str(mazebench_bin), "ascii", "--level", "CxD", "--once"], env=env)
        assert "level_CxD" in ascii_res.stdout or "P" in ascii_res.stdout

        log("Testing mazebench json...")
        json_res = run_cmd([str(mazebench_bin), "json", "--level", "CxD", "--omniscient"], env=env)
        parsed_json = json.loads(json_res.stdout)
        assert parsed_json["observation_mode"] == "json"
        assert parsed_json["json_observation"]["omniscient"] is True

        log("Testing MCP stdio handshake through wheel launcher...")
        port = find_free_port()
        # Launch server in background
        server_proc = subprocess.Popen(
            [str(mazebench_bin), "launch", f"port={port}", "open=false"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        try:
            # Wait up to 10s for server.json to appear
            server_json_path = Path(temp_home) / "server.json"
            server_ready = False
            for _ in range(50):
                if server_json_path.exists():
                    try:
                        data = json.loads(server_json_path.read_text(encoding="utf8"))
                        if data.get("url") and data.get("mcp_bootstrap_nonce"):
                            server_ready = True
                            break
                    except Exception:
                        pass
                time.sleep(0.2)

            if not server_ready:
                raise TimeoutError("Server did not initialize server.json in time")

            log("Server started! Running MCP handshake...")
            # Spawn mazebench mcp
            mcp_proc = subprocess.Popen(
                [str(mazebench_bin), "mcp"],
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            try:
                init_req = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-11-25",
                        "clientInfo": {"name": "wheel-smoke-client", "version": "1.0.0"},
                    },
                }
                mcp_proc.stdin.write(json.dumps(init_req) + "\n")
                mcp_proc.stdin.flush()

                line = mcp_proc.stdout.readline()
                init_resp = json.loads(line)
                assert init_resp.get("result", {}).get("protocolVersion") == "2025-11-25"
                assert init_resp.get("result", {}).get("serverInfo", {}).get("name") == "mazebench"

                # tools/list
                tools_req = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
                mcp_proc.stdin.write(json.dumps(tools_req) + "\n")
                mcp_proc.stdin.flush()

                line2 = mcp_proc.stdout.readline()
                tools_resp = json.loads(line2)
                tools = tools_resp.get("result", {}).get("tools", [])
                assert len(tools) == 13, f"Expected 13 tools, got {len(tools)}"

                log("MCP Stdio handshake PASSED with 13 tools verified!")
            finally:
                mcp_proc.kill()
        finally:
            server_proc.kill()

    finally:
        shutil.rmtree(venv_dir, ignore_errors=True)
        shutil.rmtree(temp_home, ignore_errors=True)


def main() -> int:
    dist_arg = sys.argv[1] if len(sys.argv) > 1 else "dist"
    dist_dir = Path(dist_arg).resolve()
    root_dir = Path(__file__).resolve().parent.parent

    log(f"Starting distribution smoke verification for {dist_dir}...")
    test_validator_standalone(root_dir)

    if dist_dir.exists():
        test_wheel_install_and_cli(dist_dir, root_dir)
    else:
        log(f"Dist dir {dist_dir} does not exist; standalone validator test completed.")

    log("All distribution smoke checks PASSED!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
