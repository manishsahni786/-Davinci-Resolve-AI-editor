#!/usr/bin/env python3
"""Independent JSON-lines worker for media discovery and bounded analysis."""

from __future__ import annotations

import importlib.util
import json
import os
import platform
import shutil
import sys
import traceback
from typing import Any

import media_analysis


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
        "visionModelConfigured": bool(os.environ.get("AVE_VISION_BASE_URL") and os.environ.get("AVE_VISION_MODEL")),
        "vision": {
            "configured": bool(os.environ.get("AVE_VISION_BASE_URL") and os.environ.get("AVE_VISION_MODEL")),
            "apiStyle": os.environ.get("AVE_VISION_API_STYLE", ""),
            "baseUrl": os.environ.get("AVE_VISION_BASE_URL", ""),
            "model": os.environ.get("AVE_VISION_MODEL", ""),
        },
        "localWhisperModelConfigured": bool(os.environ.get("AVE_WHISPER_MODEL_PATH")),
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
    payload = request.get("payload", {})
    if not isinstance(payload, dict):
        return make_response(request, "error", error={"code": "INVALID_PAYLOAD", "message": "payload must be a JSON object"}), False
    analysis_commands = {
        "probe_media": media_analysis.probe_media,
        "discover_media": media_analysis.discover_media,
        "detect_scenes": media_analysis.detect_scenes,
        "sample_frames": media_analysis.sample_frames,
        "detect_silence": media_analysis.detect_silence,
        "transcribe": media_analysis.transcribe,
        "analyze_media": media_analysis.analyze_media,
        "analyze_events": media_analysis.analyze_events,
    }
    if command in analysis_commands:
        try:
            if isinstance(request.get("id"), str) and request["id"].strip() and "jobId" not in payload:
                payload = dict(payload)
                payload["jobId"] = request["id"].strip()
            return make_response(request, "success", analysis_commands[command](payload)), False
        except media_analysis.MediaAnalysisError as exception:
            error: dict[str, Any] = {"code": exception.code, "message": str(exception)}
            if exception.details is not None:
                error["details"] = exception.details
            return make_response(request, "error", error=error), False
    return make_response(
        request,
        "unsupported",
        error={
            "code": "UNSUPPORTED_COMMAND",
            "message": f"Command is not implemented: {command}",
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
