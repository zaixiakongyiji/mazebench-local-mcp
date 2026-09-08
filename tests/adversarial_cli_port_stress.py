import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

import mazebench_cli


class AdversarialCliPortStressTest(unittest.TestCase):
    def test_find_free_port_when_free(self):
        # Pick an OS assigned free port and immediately close it
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            free_port = s.getsockname()[1]
        
        chosen = mazebench_cli._find_free_port("127.0.0.1", free_port)
        self.assertEqual(chosen, free_port)

    def test_find_free_port_single_collision(self):
        # Occupy base port
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s1:
            s1.bind(("127.0.0.1", 0))
            base_port = s1.getsockname()[1]
            s1.listen(1)

            chosen = mazebench_cli._find_free_port("127.0.0.1", base_port)
            self.assertEqual(chosen, base_port + 1)

    def test_find_free_port_consecutive_multi_collision(self):
        # Occupy 5 consecutive ports
        sockets = []
        try:
            # Find a block of 6 free ports
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                base_port = probe.getsockname()[1]

            # Bind base_port through base_port + 4
            for i in range(5):
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    s.bind(("127.0.0.1", base_port + i))
                    s.listen(1)
                    sockets.append(s)
                except OSError:
                    # Port could not be bound consecutively, close and skip
                    for sock in sockets:
                        sock.close()
                    self.skipTest(f"Could not bind consecutive block starting at {base_port}")

            chosen = mazebench_cli._find_free_port("127.0.0.1", base_port)
            self.assertEqual(chosen, base_port + 5)
        finally:
            for s in sockets:
                s.close()

    def test_find_free_port_span_exhaustion(self):
        # When all candidates in span are unavailable, OS-assigned fallback must be used
        with mock.patch.object(mazebench_cli, "_port_is_free", return_value=False):
            fallback_port = mazebench_cli._find_free_port("127.0.0.1", 3000, span=10)
            self.assertIsInstance(fallback_port, int)
            self.assertGreater(fallback_port, 0)
            self.assertLess(fallback_port, 65536)

    def test_run_launch_passes_migrated_port(self):
        # Simulate launch where preferred 3000 is occupied and _find_free_port yields 3001
        with mock.patch.object(mazebench_cli, "_find_free_port", return_value=3001) as mock_find:
            with mock.patch.object(mazebench_cli, "_wait_for_state", return_value={"url": "http://127.0.0.1:3001", "pid": 1234}):
                with mock.patch.object(mazebench_cli, "_read_state", return_value=None):
                    with mock.patch("subprocess.Popen") as mock_popen:
                        with mock.patch("webbrowser.open"):
                            mock_proc = mock.MagicMock()
                            mock_proc.pid = 1234
                            mock_popen.return_value = mock_proc

                            ret = mazebench_cli.run_launch(Path("/dummy"), ["bg"], {"port": "3000", "open": "false"}, [])
                            self.assertEqual(ret, 0)
                            mock_find.assert_called_once_with("127.0.0.1", 3000)
                            _, kwargs = mock_popen.call_args
                            self.assertEqual(kwargs["env"]["PORT"], "3001")


if __name__ == "__main__":
    unittest.main()
