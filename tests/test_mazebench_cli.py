import json
import os
import tempfile
from pathlib import Path
from unittest import TestCase, mock

import mazebench_cli


class CliCommandTests(TestCase):
    @mock.patch.object(mazebench_cli, "_pid_alive_windows", return_value=True)
    def test_pid_alive_uses_windows_process_probe(self, windows_probe):
        with mock.patch.object(mazebench_cli.os, "name", "nt"):
            self.assertTrue(mazebench_cli._pid_alive(4321))

        windows_probe.assert_called_once_with(4321)

    @mock.patch.object(mazebench_cli, "_pid_alive", return_value=True)
    def test_read_state_keeps_live_server_record(self, pid_alive):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_file = Path(temp_dir) / "server.json"
            state = {"pid": 4321, "url": "http://127.0.0.1:3000"}
            state_file.write_text(json.dumps(state), encoding="utf-8")

            with mock.patch.object(
                mazebench_cli, "_state_file", return_value=state_file
            ):
                self.assertEqual(mazebench_cli._read_state(), state)

            self.assertTrue(state_file.exists())

        pid_alive.assert_called_once_with(4321)

    @mock.patch.object(mazebench_cli, "_clear_state")
    @mock.patch.object(mazebench_cli, "_pid_alive", return_value=False)
    def test_read_state_clears_dead_server_record(self, pid_alive, clear_state):
        with tempfile.TemporaryDirectory() as temp_dir:
            state_file = Path(temp_dir) / "server.json"
            state_file.write_text(
                json.dumps({"pid": 4321, "url": "http://127.0.0.1:3000"}),
                encoding="utf-8",
            )

            with mock.patch.object(
                mazebench_cli, "_state_file", return_value=state_file
            ):
                self.assertIsNone(mazebench_cli._read_state())

        pid_alive.assert_called_once_with(4321)
        clear_state.assert_called_once_with()

    def test_windows_process_probe_detects_current_process(self):
        if os.name != "nt":
            self.skipTest("Windows-only regression test")

        self.assertTrue(mazebench_cli._pid_alive_windows(os.getpid()))

    @mock.patch("builtins.print")
    @mock.patch.object(mazebench_cli, "resolve_root")
    def test_global_help_does_not_require_a_runtime(self, resolve_root, print_output):
        result = mazebench_cli.main(["--help"])

        self.assertEqual(result, 0)
        resolve_root.assert_not_called()
        print_output.assert_called_once_with(mazebench_cli.USAGE)

    @mock.patch.object(mazebench_cli, "run_ascii", return_value=23)
    @mock.patch.object(mazebench_cli, "resolve_root", return_value=Path("/maze"))
    def test_main_routes_ascii_flags(self, _resolve_root, run_ascii):
        result = mazebench_cli.main(["ascii", "--level", "level_CxD", "--once"])

        self.assertEqual(result, 23)
        run_ascii.assert_called_once_with(
            Path("/maze"), {}, ["--level", "level_CxD", "--once"]
        )

    @mock.patch.object(mazebench_cli, "_run", return_value=0)
    @mock.patch.object(mazebench_cli, "_require")
    @mock.patch.object(mazebench_cli, "_node_bin", return_value="node")
    def test_ascii_supports_existing_key_value_style(
        self, _node_bin, _require, run_command
    ):
        root = Path("/maze")

        result = mazebench_cli.run_ascii(
            root, {"level": "CxD", "view": "top"}, ["--once"]
        )

        self.assertEqual(result, 0)
        run_command.assert_called_once_with(
            [
                "node",
                str(root / "scripts" / "maze-terminal.js"),
                "--level",
                "CxD",
                "--view",
                "top",
                "--once",
            ],
            root,
        )

    @mock.patch.object(mazebench_cli, "run_json", return_value=29)
    @mock.patch.object(mazebench_cli, "resolve_root", return_value=Path("/maze"))
    def test_main_routes_json_flags(self, _resolve_root, run_json):
        result = mazebench_cli.main(["json", "--level", "CxD", "--omniscient"])

        self.assertEqual(result, 29)
        run_json.assert_called_once_with(
            Path("/maze"), {}, ["--level", "CxD", "--omniscient"]
        )

    @mock.patch.object(mazebench_cli, "_run", return_value=0)
    @mock.patch.object(mazebench_cli, "_require")
    @mock.patch.object(mazebench_cli, "_node_bin", return_value="node")
    def test_json_supports_literal_names_and_existing_key_value_style(
        self, _node_bin, _require, run_command
    ):
        root = Path("/maze")

        result = mazebench_cli.run_json(
            root,
            {"level": "CxD", "view": "top", "omniscient": "true"},
            [],
        )

        self.assertEqual(result, 0)
        run_command.assert_called_once_with(
            [
                "node",
                str(root / "scripts" / "maze-terminal.js"),
                "--json",
                "--level",
                "CxD",
                "--view",
                "top",
                "--omniscient",
            ],
            root,
        )

    @mock.patch.object(mazebench_cli, "_run", return_value=0)
    @mock.patch.object(mazebench_cli, "_require")
    def test_prime_eval_uses_the_native_framework_harness(self, _require, run_command):
        root = Path("/maze")

        with mock.patch.dict("os.environ", {"MAZEBENCH_ENABLE_PRIME": "1"}):
            result = mazebench_cli.run_prime(
                root,
                ["eval"],
                {"model": "openai/test", "max_turns": "3"},
                [],
            )

            self.assertEqual(result, 0)
            command = run_command.call_args.args[0]
            self.assertIn("mazebench-tools", command)
            self.assertEqual(
                command[command.index("--env.agent.harness.id") + 1],
                "null",
            )
            self.assertEqual(
                command[command.index("--env.agent.runtime.type") + 1], "prime"
            )
            self.assertNotIn("--env.taskset.tools.colocated", command)
            self.assertNotIn("--env.taskset.python-tools", command)
            with self.assertRaisesRegex(mazebench_cli.CliError, "replace the approved"):
                mazebench_cli.run_prime(root, ["eval"], {}, ["--harness.id", "bash"])

    @mock.patch.object(mazebench_cli, "_require")
    def test_prime_disabled_by_default(self, require_mock):
        root = Path("/maze")
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(mazebench_cli.CliError, "Prime integration is disabled"):
                mazebench_cli.run_prime(root, ["eval"], {}, [])
        require_mock.assert_not_called()

    @mock.patch.object(mazebench_cli, "run_mcp", return_value=0)
    @mock.patch.object(mazebench_cli, "resolve_root", return_value=Path("/maze"))
    def test_main_routes_mcp_command(self, _resolve_root, run_mcp):
        result = mazebench_cli.main(["mcp"])
        self.assertEqual(result, 0)
        run_mcp.assert_called_once_with(Path("/maze"), [])

    @mock.patch("subprocess.call", return_value=0)
    @mock.patch.object(mazebench_cli, "_require")
    @mock.patch.object(mazebench_cli, "_node_bin", return_value="node")
    def test_run_mcp_invokes_adapter(self, _node_bin, _require, mock_call):
        root = Path("/maze")
        result = mazebench_cli.run_mcp(root, ["--debug"])
        self.assertEqual(result, 0)
        mock_call.assert_called_once_with(
            ["node", str(root / "scripts" / "maze-external-mcp.js"), "--debug"],
            cwd=str(root),
        )

    @mock.patch("webbrowser.open")
    @mock.patch.object(
        mazebench_cli,
        "_wait_for_state",
        return_value={"url": "http://127.0.0.1:3000", "active_run_id": "ext-123"},
    )
    def test_open_when_ready_opens_standard_external_play_url(
        self, _wait_for_state, mock_open
    ):
        mazebench_cli._open_when_ready(1234, "http://127.0.0.1:3000")
        mock_open.assert_called_once_with("http://127.0.0.1:3000/external-play")

    @mock.patch("webbrowser.open")
    @mock.patch.object(
        mazebench_cli,
        "_read_state",
        return_value={"url": "http://127.0.0.1:3000", "pid": 4321},
    )
    @mock.patch.object(mazebench_cli, "_require")
    @mock.patch.object(mazebench_cli, "_node_bin", return_value="node")
    def test_launch_already_running_opens_external_play(
        self, _node_bin, _require, _read_state, mock_open
    ):
        root = Path("/maze")
        result = mazebench_cli.run_launch(root, [], {"open": "true"}, [])
        self.assertEqual(result, 0)
        mock_open.assert_called_once_with("http://127.0.0.1:3000/external-play")
