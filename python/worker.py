#!/usr/bin/env python3
"""Independent Python media worker.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
This Milestone 1 worker only implements ping, env_info and shutdown. Media
analysis commands will be added in later milestones without changing the pipe
protocol.
"""

from __future__ import annotations

import importlib.util
import json
import platform
import shutil
import sys
import traceback
from typing import Any


PROTOCOL_VERSION = "1.0"


def log(message: str) -> None:
    sys.stderr.write(f"[python-worker] {message}\n")
    sys.stderr.flush()


def installed(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def env_info() -> dict[str, Any]:
    return {
        "pythonExecutable": sys.executable,
        "pythonVersion": sys.version,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "ffmpeg": shutil.which("ffmpeg"),
        "ffprobe": shutil.which("ffprobe"),
        "modules": {
            "numpy": installed("numpy"),
            "cv2": installed("cv2"),
            "scipy": installed("scipy"),
            "PIL": installed("PIL"),
            "scenedetect": installed("scenedetect"),
            "faster_whisper": installed("faster_whisper"),
            "whisper": installed("whisper"),
            "imageio_ffmpeg": installed("imageio_ffmpeg"),
        },
    }


def make_response(request: dict[str, Any], status: str, result: Any = None, error: Any = None) -> dict[str, Any]:
    response: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "id": request.get("id"),
        "command": request.get("command"),
        "ok": status == "success",
        "status": status,
        "source": "python-worker",
        "result": result,
    }
    if error is not None:
        response["error"] = error
    return response


def handle(request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    command = request.get("command")
    if command == "ping":
        return make_response(request, "success", {"message": "pong", "pythonVersion": platform.python_version()}), False
    if command == "env_info":
        return make_response(request, "success", env_info()), False
    if command == "shutdown":
        return make_response(request, "success", {"message": "shutting down"}), True
    return make_response(
        request,
        "unsupported",
        error={
            "code": "UNSUPPORTED_COMMAND",
            "message": f"Command is not implemented in Milestone 1: {command}",
        },
    ), False


def main() -> int:
    log("worker started")
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            response, should_stop = handle(request)
        except Exception as exception:  # noqa: BLE001 - protocol boundary
            response = {
                "protocolVersion": PROTOCOL_VERSION,
                "id": None,
                "command": None,
                "ok": False,
                "status": "error",
                "source": "python-worker",
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": str(exception),
                    "details": traceback.format_exc(limit=3),
                },
            }
            should_stop = False

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
        if should_stop:
            log("shutdown requested")
            return 0

    log("stdin closed; worker exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
