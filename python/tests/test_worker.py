#!/usr/bin/env python3
"""Protocol tests for the independent Python worker (standard library only)."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "worker.py"


class WorkerProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.process = subprocess.Popen(
            [sys.executable, str(WORKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()

    def request(self, payload: dict) -> dict:
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        self.assertNotEqual(line, "", "worker closed stdout unexpectedly")
        return json.loads(line)

    def test_ping(self) -> None:
        response = self.request({"id": "test-1", "command": "ping"})
        self.assertTrue(response["ok"])
        self.assertEqual(response["status"], "success")
        self.assertEqual(response["result"]["message"], "pong")
        self.assertEqual(response["id"], "test-1")

    def test_env_info(self) -> None:
        response = self.request({"id": "test-2", "command": "env_info"})
        self.assertTrue(response["ok"])
        self.assertIn("pythonVersion", response["result"])
        self.assertIn("modules", response["result"])

    def test_unknown_command(self) -> None:
        response = self.request({"id": "test-3", "command": "render_everything"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["status"], "unsupported")
        self.assertEqual(response["error"]["code"], "UNSUPPORTED_COMMAND")

    def test_invalid_json(self) -> None:
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.process.stdin.write("{not json}\n")
        self.process.stdin.flush()
        response = json.loads(self.process.stdout.readline())
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_REQUEST")

    def test_shutdown(self) -> None:
        response = self.request({"id": "test-4", "command": "shutdown"})
        self.assertTrue(response["ok"])
        self.assertEqual(self.process.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
