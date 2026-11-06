"""Bounded, read-only media analysis adapters used by the JSON-lines worker."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"}
MAX_FRAME_SAMPLES = 120
MAX_FOLDER_FILES = 500


class MediaAnalysisError(Exception):
    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def _existing_file(value: Any) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise MediaAnalysisError("INVALID_MEDIA_PATH", "A media file path is required.")
    try:
        path = Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exception:
        raise MediaAnalysisError("MEDIA_NOT_FOUND", f"Media file was not found: {value}") from exception
    if not path.is_file():
        raise MediaAnalysisError("INVALID_MEDIA_PATH", "Analysis requires a media file, not a directory.")
    return path


def _executable(name: str, configured: Any = None) -> str:
    if isinstance(configured, str) and configured.strip():
        executable = str(Path(configured).expanduser())
        if Path(executable).is_file():
            return executable
        raise MediaAnalysisError("TOOL_NOT_FOUND", f"Configured {name} executable does not exist.")
    found = shutil.which(name)
    if found:
        return found
    raise MediaAnalysisError("TOOL_NOT_INSTALLED", f"{name} was not found on PATH; configure its executable path.")


def _rate(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        if "/" in value:
            numerator, denominator = value.split("/", 1)
            denominator_value = float(denominator)
            return float(numerator) / denominator_value if denominator_value else None
        return float(value)
    except (ValueError, ZeroDivisionError):
        return None


def probe_media(payload: dict[str, Any]) -> dict[str, Any]:
    media_path = _existing_file(payload.get("path"))
    executable = _executable("ffprobe", os.environ.get("AVE_FFPROBE_PATH"))
    try:
        completed = subprocess.run(
            [
                executable,
                "-v", "error",
                "-show_format",
                "-show_streams",
                "-of", "json",
                str(media_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        result = json.loads(completed.stdout)
    except subprocess.TimeoutExpired as exception:
        raise MediaAnalysisError("PROBE_TIMEOUT", "ffprobe did not finish within 120 seconds.") from exception
    except subprocess.CalledProcessError as exception:
        raise MediaAnalysisError(
            "PROBE_FAILED",
            "ffprobe could not read this media file.",
            {"stderr": (exception.stderr or "")[-4000:]},
        ) from exception
    except json.JSONDecodeError as exception:
        raise MediaAnalysisError("PROBE_INVALID_JSON", "ffprobe returned invalid JSON.") from exception

    streams = result.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    video = video_streams[0] if video_streams else {}
    audio = audio_streams[0] if audio_streams else {}
    format_info = result.get("format", {})
    duration = _float_or_none(format_info.get("duration") or video.get("duration"))
    return {
        "path": str(media_path),
        "filename": media_path.name,
        "sizeBytes": media_path.stat().st_size,
        "durationSeconds": duration,
        "width": _int_or_none(video.get("width")),
        "height": _int_or_none(video.get("height")),
        "frameRate": _rate(video.get("avg_frame_rate") or video.get("r_frame_rate")),
        "videoCodec": video.get("codec_name"),
        "pixelFormat": video.get("pix_fmt"),
        "hasAudio": bool(audio_streams),
        "audio": {
            "codec": audio.get("codec_name"),
            "sampleRate": _int_or_none(audio.get("sample_rate")),
            "channels": _int_or_none(audio.get("channels")),
        } if audio_streams else None,
        "container": format_info.get("format_name"),
    }


def _float_or_none(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def discover_media(payload: dict[str, Any]) -> dict[str, Any]:
    raw_path = payload.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise MediaAnalysisError("INVALID_MEDIA_PATH", "A selected folder path is required.")
    try:
        folder = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exception:
        raise MediaAnalysisError("MEDIA_NOT_FOUND", f"Selected path was not found: {raw_path}") from exception
    if not folder.is_dir():
        raise MediaAnalysisError("INVALID_MEDIA_PATH", "The selected path is not a folder.")

    recursive = payload.get("recursive", True) is True
    max_files = payload.get("maxFiles", 100)
    if not isinstance(max_files, int) or isinstance(max_files, bool) or max_files < 1 or max_files > MAX_FOLDER_FILES:
        raise MediaAnalysisError("INVALID_LIMIT", f"maxFiles must be between 1 and {MAX_FOLDER_FILES}.")
    iterator = folder.rglob("*") if recursive else folder.glob("*")
    files = sorted((entry for entry in iterator if entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS), key=lambda p: str(p).lower())
    return {
        "folder": str(folder),
        "recursive": recursive,
        "count": min(len(files), max_files),
        "truncated": len(files) > max_files,
        "files": [str(entry) for entry in files[:max_files]],
    }


def detect_scenes(payload: dict[str, Any]) -> dict[str, Any]:
    media_path = _existing_file(payload.get("path"))
    if importlib.util.find_spec("scenedetect") is None:
        raise MediaAnalysisError("DEPENDENCY_MISSING", "PySceneDetect is not installed in the configured Python environment.", {"module": "scenedetect"})
    threshold = payload.get("threshold", 27.0)
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not 1 <= threshold <= 100:
        raise MediaAnalysisError("INVALID_THRESHOLD", "Scene threshold must be between 1 and 100.")
    max_duration = payload.get("maxDurationSeconds")
    if max_duration is not None and (
        not isinstance(max_duration, (int, float))
        or isinstance(max_duration, bool)
        or not 1 <= max_duration <= 3600
    ):
        raise MediaAnalysisError("INVALID_LIMIT", "maxDurationSeconds must be between 1 and 3600.")
    try:
        from scenedetect import ContentDetector, SceneManager, open_video

        video = open_video(str(media_path))
        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector(threshold=float(threshold)))
        if max_duration is None:
            scene_manager.detect_scenes(video=video)
        else:
            scene_manager.detect_scenes(video=video, end_time=float(max_duration))
        scene_list = scene_manager.get_scene_list(start_in_scene=True)
    except Exception as exception:  # package and codec errors are surfaced at the protocol boundary
        raise MediaAnalysisError("SCENE_DETECTION_FAILED", "PySceneDetect could not process this video.", {"reason": str(exception)}) from exception

    scenes = []
    for index, (start, end) in enumerate(scene_list, start=1):
        scenes.append({
            "sceneIndex": index,
            "startSeconds": float(start.get_seconds()),
            "endSeconds": float(end.get_seconds()),
            "durationSeconds": max(0.0, float(end.get_seconds()) - float(start.get_seconds())),
            "method": "content-change",
        })
    return {
        "path": str(media_path),
        "count": len(scenes),
        "scenes": scenes,
        "partial": max_duration is not None,
        "processedThroughSeconds": float(max_duration) if max_duration is not None else None,
    }


def sample_frames(payload: dict[str, Any]) -> dict[str, Any]:
    media_path = _existing_file(payload.get("path"))
    if importlib.util.find_spec("cv2") is None:
        raise MediaAnalysisError("DEPENDENCY_MISSING", "OpenCV is not installed in the configured Python environment.", {"module": "cv2"})
    timestamps = payload.get("timestampsSeconds")
    if not isinstance(timestamps, list) or not timestamps or len(timestamps) > MAX_FRAME_SAMPLES:
        raise MediaAnalysisError("INVALID_TIMESTAMPS", f"Provide 1 to {MAX_FRAME_SAMPLES} sample timestamps.")
    normalized = []
    for timestamp in timestamps:
        value = _float_or_none(timestamp)
        if value is None:
            raise MediaAnalysisError("INVALID_TIMESTAMPS", "Frame timestamps must be finite, non-negative numbers.")
        normalized.append(value)
    max_dimension = payload.get("maxDimension", 1024)
    if not isinstance(max_dimension, int) or isinstance(max_dimension, bool) or max_dimension < 128 or max_dimension > 4096:
        raise MediaAnalysisError("INVALID_LIMIT", "maxDimension must be between 128 and 4096.")
    output_dir_value = os.environ.get("AVE_ANALYSIS_CACHE_DIR")
    if not isinstance(output_dir_value, str) or not output_dir_value.strip():
        raise MediaAnalysisError("INVALID_OUTPUT_DIR", "A project cache outputDir is required for derived thumbnails.")
    output_dir = Path(output_dir_value).expanduser().resolve()
    source_stat = media_path.stat()
    fingerprint = hashlib.sha256(
        f"{media_path}\0{source_stat.st_size}\0{source_stat.st_mtime_ns}".encode("utf-8")
    ).hexdigest()[:24]
    destination = output_dir / "frames" / fingerprint
    destination.mkdir(parents=True, exist_ok=True)

    try:
        import cv2
    except ImportError as exception:
        raise MediaAnalysisError("DEPENDENCY_MISSING", "OpenCV is not installed.", {"module": "cv2"}) from exception

    capture = cv2.VideoCapture(str(media_path))
    if not capture.isOpened():
        capture.release()
        raise MediaAnalysisError("VIDEO_DECODE_FAILED", "OpenCV could not open this video.")
    frames = []
    try:
        for index, seconds in enumerate(normalized):
            capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
            succeeded, frame = capture.read()
            if not succeeded or frame is None:
                frames.append({"requestedTimeSeconds": seconds, "ok": False, "reason": "No frame at timestamp."})
                continue
            height, width = frame.shape[:2]
            scale = min(1.0, max_dimension / max(width, height))
            if scale < 1.0:
                frame = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
            timestamp_ms = capture.get(cv2.CAP_PROP_POS_MSEC)
            observed_seconds = max(0.0, timestamp_ms / 1000.0) if timestamp_ms > 0 else seconds
            output_path = destination / f"frame-{index:04d}-{round(observed_seconds * 1000):012d}.jpg"
            encoded, image = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
            if not encoded:
                frames.append({"requestedTimeSeconds": seconds, "ok": False, "reason": "Frame could not be encoded."})
                continue
            output_path.write_bytes(image.tobytes())
            frames.append({
                "requestedTimeSeconds": seconds,
                "sourceTimeSeconds": observed_seconds,
                "ok": True,
                "width": int(frame.shape[1]),
                "height": int(frame.shape[0]),
                "thumbnailPath": str(output_path),
            })
    finally:
        capture.release()
    return {"path": str(media_path), "fingerprint": fingerprint, "frames": frames}


def detect_silence(payload: dict[str, Any]) -> dict[str, Any]:
    media_path = _existing_file(payload.get("path"))
    executable = _executable("ffmpeg", os.environ.get("AVE_FFMPEG_PATH"))
    noise_db = payload.get("noiseDb", -35.0)
    minimum_seconds = payload.get("minimumSeconds", 1.5)
    if not isinstance(noise_db, (int, float)) or isinstance(noise_db, bool) or not -90 <= noise_db <= 0:
        raise MediaAnalysisError("INVALID_AUDIO_THRESHOLD", "noiseDb must be between -90 and 0 dB.")
    if not isinstance(minimum_seconds, (int, float)) or isinstance(minimum_seconds, bool) or not 0.1 <= minimum_seconds <= 120:
        raise MediaAnalysisError("INVALID_AUDIO_THRESHOLD", "minimumSeconds must be between 0.1 and 120 seconds.")
    try:
        completed = subprocess.run(
            [
                executable, "-hide_banner", "-nostats", "-i", str(media_path),
                "-vn", "-af", f"silencedetect=noise={noise_db}dB:d={minimum_seconds}",
                "-f", "null", "-",
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3600,
        )
    except subprocess.TimeoutExpired as exception:
        raise MediaAnalysisError("AUDIO_ANALYSIS_TIMEOUT", "FFmpeg silence analysis exceeded one hour.") from exception
    if completed.returncode not in (0, 1) or "silencedetect" not in completed.stderr:
        raise MediaAnalysisError("AUDIO_ANALYSIS_FAILED", "FFmpeg could not analyze the audio track.", {"stderr": completed.stderr[-4000:]})

    starts = re.finditer(r"silence_start:\s*([0-9.]+)", completed.stderr)
    ends = re.finditer(r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)", completed.stderr)
    start_values = [float(match.group(1)) for match in starts]
    end_values = [(float(match.group(1)), float(match.group(2))) for match in ends]
    silences = []
    for index, (end, duration) in enumerate(end_values):
        start = start_values[index] if index < len(start_values) else max(0.0, end - duration)
        silences.append({"startSeconds": start, "endSeconds": end, "durationSeconds": duration, "method": "ffmpeg-silencedetect"})
    return {"path": str(media_path), "count": len(silences), "silences": silences}


def transcribe(payload: dict[str, Any]) -> dict[str, Any]:
    media_path = _existing_file(payload.get("path"))
    model_path_value = os.environ.get("AVE_WHISPER_MODEL_PATH")
    if not isinstance(model_path_value, str) or not model_path_value.strip():
        raise MediaAnalysisError("MODEL_NOT_CONFIGURED", "Set a local faster-whisper modelPath; model downloads are not started automatically.")
    model_path = Path(model_path_value).expanduser().resolve()
    if not model_path.is_dir():
        raise MediaAnalysisError("MODEL_NOT_FOUND", "The configured local faster-whisper model directory does not exist.")
    if importlib.util.find_spec("faster_whisper") is None:
        raise MediaAnalysisError("DEPENDENCY_MISSING", "faster-whisper is not installed in the configured Python environment.", {"module": "faster_whisper"})

    device = payload.get("device", "cpu")
    compute_type = payload.get("computeType", "int8" if device == "cpu" else "float16")
    if device not in ("cpu", "cuda") or compute_type not in ("int8", "int8_float16", "float16", "float32"):
        raise MediaAnalysisError("INVALID_TRANSCRIPTION_SETTINGS", "Use device cpu/cuda and computeType int8/int8_float16/float16/float32.")
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(str(model_path), device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            str(media_path),
            word_timestamps=payload.get("wordTimestamps", True) is True,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        transcript = []
        for segment in segments:
            entry: dict[str, Any] = {
                "startSeconds": float(segment.start),
                "endSeconds": float(segment.end),
                "text": segment.text.strip(),
            }
            if getattr(segment, "words", None):
                entry["words"] = [
                    {"startSeconds": float(word.start), "endSeconds": float(word.end), "text": word.word}
                    for word in segment.words
                    if word.start is not None and word.end is not None
                ]
            transcript.append(entry)
    except MediaAnalysisError:
        raise
    except Exception as exception:
        raise MediaAnalysisError("TRANSCRIPTION_FAILED", "faster-whisper could not transcribe this media.", {"reason": str(exception)}) from exception
    return {
        "path": str(media_path),
        "language": getattr(info, "language", None),
        "languageConfidence": _float_or_none(getattr(info, "language_probability", None)),
        "segments": transcript,
    }


def _env_int(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exception:
        raise MediaAnalysisError("INVALID_VISION_SETTING", f"{name} must be an integer between {low} and {high}.") from exception
    if not low <= value <= high:
        raise MediaAnalysisError("INVALID_VISION_SETTING", f"{name} must be an integer between {low} and {high}.")
    return value


def _env_float(name: str, default: float, low: float, high: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exception:
        raise MediaAnalysisError("INVALID_VISION_SETTING", f"{name} must be a number between {low} and {high}.") from exception
    if not low <= value <= high:
        raise MediaAnalysisError("INVALID_VISION_SETTING", f"{name} must be a number between {low} and {high}.")
    return value


def _vision_keep_alive() -> str:
    value = os.environ.get("AVE_VISION_KEEP_ALIVE", "45m").strip()
    if not value or len(value) > 32 or any(character in value for character in "\r\n"):
        raise MediaAnalysisError(
            "INVALID_VISION_SETTING",
            "AVE_VISION_KEEP_ALIVE must be a non-empty Ollama duration such as 45m or 0.",
        )
    return value


def _vision_request_timeout_seconds() -> int:
    # Keep the original variable as a backwards-compatible alias.
    legacy = _env_int("AVE_VISION_TIMEOUT_SECONDS", 600, 10, 900)
    return _env_int("AVE_VISION_REQUEST_TIMEOUT_SECONDS", legacy, 10, 900)


def _max_cpu_offload_percent() -> float:
    return float(_env_int("AVE_VISION_MAX_CPU_OFFLOAD_PERCENT", 20, 0, 100))


def _vision_api_style() -> str:
    api_style = os.environ.get("AVE_VISION_API_STYLE", "openai-compatible").strip().lower()
    if api_style not in ("openai-compatible", "ollama"):
        raise MediaAnalysisError("INVALID_VISION_API_STYLE", "AVE_VISION_API_STYLE must be openai-compatible or ollama.")
    return api_style


def _validate_vision_endpoint(base_url: str) -> urllib.parse.ParseResult:
    parsed_url = urllib.parse.urlparse(base_url)
    if parsed_url.scheme not in ("http", "https") or not parsed_url.hostname:
        raise MediaAnalysisError("INVALID_VISION_ENDPOINT", "Vision endpoint must be an http(s) URL.")
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    if parsed_url.hostname not in local_hosts and os.environ.get("AVE_VISION_ALLOW_REMOTE", "false").lower() not in ("1", "true", "yes"):
        raise MediaAnalysisError("REMOTE_VISION_DISABLED", "Remote vision endpoints are disabled. Set AVE_VISION_ALLOW_REMOTE=true to explicitly allow one.")
    return parsed_url


def _vision_headers(api_key: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _model_listed(configured: str, models: list[str]) -> bool:
    for name in models:
        if name == configured or name.startswith(configured + ":"):
            return True
    return False


def _vision_preflight(base_url: str, model: str, api_key: str | None) -> dict[str, Any]:
    """Verify the vision service is reachable and the configured model exists.

    Raises MediaAnalysisError VISION_MODEL_UNAVAILABLE when the service cannot be
    reached or the configured model is missing. Never selects a different model and
    never falls back to non-model interpretation.
    """
    _validate_vision_endpoint(base_url)
    api_style = _vision_api_style()
    listing_url = base_url.rstrip("/") + ("/api/tags" if api_style == "ollama" else "/models")
    connect_timeout = _env_int("AVE_VISION_CONNECT_TIMEOUT_SECONDS", 5, 1, 60)
    request = urllib.request.Request(listing_url, headers=_vision_headers(api_key), method="GET")
    try:
        with urllib.request.urlopen(request, timeout=connect_timeout) as response:
            payload = json.loads(response.read(4_000_000).decode("utf-8"))
    except (TimeoutError, urllib.error.URLError, OSError) as exception:
        raise MediaAnalysisError(
            "VISION_MODEL_UNAVAILABLE",
            f"Vision service is unreachable at {base_url}. Start the local vision server and retry.",
            {"endpoint": listing_url, "reason": str(exception)},
        ) from exception
    except (UnicodeDecodeError, json.JSONDecodeError) as exception:
        raise MediaAnalysisError("VISION_INVALID_RESPONSE", "Vision service returned invalid JSON for its model listing.") from exception

    entries = payload.get("models", []) if api_style == "ollama" else payload.get("data", [])
    models = [entry.get("name") or entry.get("id") for entry in entries if isinstance(entry, dict)]
    models = [name for name in models if isinstance(name, str) and name]
    if not _model_listed(model, models):
        raise MediaAnalysisError(
            "VISION_MODEL_UNAVAILABLE",
            f"Configured vision model '{model}' is not installed at {base_url}.",
            {"configuredModel": model, "availableModels": models[:50]},
        )
    return {"endpoint": listing_url, "apiStyle": api_style, "configuredModel": model, "availableModels": models}


def _repair_truncated_json(text: str, max_attempts: int = 48) -> Any:
    """Try to repair JSON that was cut off, typically by a token budget.
    """
    text = text.strip()
    # Some gateways wrap the JSON object in Markdown fences; prefer the fenced body.
    if text.startswith("```"):
        first_newline = text.find("\n")
        tail = text[first_newline + 1:] if first_newline >= 0 else ""
        fence_end = tail.rfind("```")
        if fence_end >= 0:
            text = tail[:fence_end].strip()
    return _repair_truncated_json_body(text, max_attempts)


_JSON_CLOSERS = {"{": "}", "[": "]"}


def _repair_truncated_json_body(text: str, max_attempts: int) -> Any:
    """Repair truncated model JSON: close open strings/brackets after trimming.

    Tolerance models with format-json sometimes loop on repeated fields and hit
    num_predict mid-string, leaving structurally incomplete output. This closes
    open strings and brackets after trimming trailing fragments; repeated chops
    remove partial keys left with dangling colons. Returns the parsed value, or
    None when the text cannot be salvaged.
    """
    working = text.strip()
    if not working or working[0] not in "{[":
        return None
    closers = {"{": "}", "[": "]"}
    for _ in range(max_attempts):
        if working.endswith((",", ":", "[", "{")):
            working = working[:-1].rstrip()
        open_stack: list[str] = []
        in_string = False
        escaped = False
        for char in working:
            if escaped:
                escaped = False
                continue
            if in_string:
                if char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char in "{[":
                open_stack.append(char)
            elif char in "}]":
                if open_stack:
                    open_stack.pop()
        candidate = working
        if in_string or escaped:
            candidate += '"'
        candidate += "".join(closers[opening] for opening in reversed(open_stack))
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            if not working:
                return None
            working = working[:-1].rstrip()
    return None



def _request_log_path() -> str | None:
    """Path of the per-run vision request log, or None when logging is disabled."""
    if os.environ.get("AVE_VISION_REQUEST_LOG", "1").strip().lower() in ("0", "false", "no"):
        return None
    configured = os.environ.get("AVE_VISION_REQUEST_LOG_PATH", "").strip()
    return configured or None


def _log_vision_request(entry: dict[str, Any]) -> None:
    """Append one JSONL line describing a vision request and its raw response.

    Deliberately write the full model content so event-analysis debugging can be
    done from the log alone. Failures to log never break analysis.
    """
    path_value = _request_log_path()
    if not path_value:
        return
    try:
        log_path = Path(path_value)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _vision_request(
    base_url: str,
    model: str,
    api_key: str | None,
    task: str,
    frames: list[dict[str, Any]],
    stats: dict[str, Any] | None = None,
    schema_hint: str | None = None,
    num_ctx_override: int | None = None,
    timeout_seconds_override: float | None = None,
    max_attempts_override: int | None = None,
) -> Any:
    _validate_vision_endpoint(base_url)
    if len(frames) > 8:
        raise MediaAnalysisError("VISION_FRAME_LIMIT", "At most 8 sampled frames are sent in one vision request.")
    api_style = _vision_api_style()
    timeout_seconds = _vision_request_timeout_seconds()
    if timeout_seconds_override is not None:
        timeout_seconds = max(1, min(timeout_seconds, float(timeout_seconds_override)))
    max_retries = _env_int("AVE_VISION_MAX_RETRIES", 2, 0, 5)
    # Measured on a 4 GB GTX 1650 with qwen3-vl:2b: 2048 output tokens are
    # enough for a few candidates, and a repetition loop is cut off sooner.
    # Retries raise the budget to 4096 only when the content came back empty.
    num_predict = _env_int("AVE_VISION_NUM_PREDICT", 2048, 128, 8192)
    # A small repeat penalty breaks the 2B model's habit of emitting the same
    # candidate over and over; Ollama 0.40 aborts that loop with HTTP 500.
    repeat_penalty = _env_float("AVE_VISION_REPEAT_PENALTY", 1.1, 1.0, 2.0)
    # Vision frames consume many context tokens each; four images exceeded 4096
    # in the live sweep. Context overflow falls back to single-image requests.
    # Live allocation is gated after warm-up and each successful request.
    num_ctx = num_ctx_override or _env_int("AVE_VISION_NUM_CTX", 5120, 2048, 131072)
    if max_attempts_override is not None and max_attempts_override < 1:
        raise MediaAnalysisError(
            "ANALYSIS_REQUEST_BUDGET",
            "The event-analysis request budget is exhausted.",
        )

    keep_alive = _vision_keep_alive()
    frame_labels = "\n".join(
        f"Image {index + 1} = {frame['sourceTimeSeconds']:.3f} seconds"
        for index, frame in enumerate(frames)
    )
    output_shape = schema_hint or (
        'Output shape: {"observations":[{"sourceTimeSeconds":<one exact timestamp from the mapping above>,'
        '"description":"...","relevance":0.0,"confidence":0.0,"reason":"..."}]}'
    )
    # Qwen3-family models ignore think=false and can spend the whole token budget
    # on hidden reasoning, leaving no JSON content. The documented soft switch keeps
    # output inside the requested budget without changing the model.
    thinking_switch = "/no_think\n" if "qwen3" in model.lower() else ""
    prompt = (
        thinking_switch
        + "Analyze these ordered frames as one video. Return one JSON object matching the schema; no prose.\n"
        "Use only the mapped timestamps. Report visible evidence only, avoid duplicates, and keep descriptions short.\n"
        "Times (seconds):\n" + frame_labels + "\n"
        + output_shape + "\n"
        f"Task: {task}"
    )

    image_payloads: list[str] = []
    openai_content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for index, frame in enumerate(frames):
        encoded = base64.b64encode(Path(frame["thumbnailPath"]).read_bytes()).decode("ascii")
        image_payloads.append(encoded)
        if api_style != "ollama":
            openai_content.append({"type": "text", "text": f"Image {index + 1} at {frame['sourceTimeSeconds']:.3f} seconds"})
            openai_content.append({
                "type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64," + encoded},
            })

    def build_body(predict: int, ctx: int, penalty: float) -> dict[str, Any]:
        if api_style == "ollama":
            return {
                "model": model,
                "messages": [{"role": "user", "content": prompt, "images": image_payloads}],
                "format": "json",
                "stream": False,
                "think": False,
                "keep_alive": keep_alive,
                "options": {
                    "temperature": 0,
                    "num_predict": predict,
                    "num_ctx": ctx,
                    "repeat_penalty": penalty,
                    "repeat_last_n": 256,
                },
            }
        return {
            "model": model,
            "messages": [{"role": "user", "content": openai_content}],
            "temperature": 0,
            "max_tokens": predict,
            "response_format": {"type": "json_object"},
        }

    request_url = base_url.rstrip("/") + ("/api/chat" if api_style == "ollama" else "/chat/completions")
    attempts = max_retries + 1
    if max_attempts_override is not None:
        attempts = min(attempts, max_attempts_override)
    last_failure: MediaAnalysisError | None = None
    # Retry output truncation with a larger generation budget. Never raise
    # num_ctx automatically: that can move a small model onto the CPU.
    effective_predict = num_predict
    effective_ctx = num_ctx
    attempt_index = 0
    while attempt_index < attempts:
        if attempt_index > 0:
            # Recovery stays output-focused; num_ctx stays at the measured value.
            if last_failure is not None and last_failure.code == "VISION_REPEAT_LIMIT":
                # The model looped: keep the budget small and penalise repeats harder.
                effective_predict = min(effective_predict, 2048)
                repeat_penalty = min(repeat_penalty + 0.1, 1.5)
            else:
                effective_predict = min(max(effective_predict * 2, 4096), 8192)
        request = urllib.request.Request(
            request_url,
            data=json.dumps(build_body(effective_predict, effective_ctx, repeat_penalty)).encode("utf-8"),
            headers=_vision_headers(api_key),
            method="POST",
        )
        retryable = attempt_index < attempts - 1
        request_started = time.time()
        if stats is not None:
            stats["requests"] = int(stats.get("requests", 0)) + 1

        def log_failure(outcome: str, detail: str, http_status: int | None = None) -> None:
            _log_vision_request({
                "attempt": attempt_index + 1,
                "jobId": stats.get("jobId") if stats is not None else None,
                "model": model,
                "apiStyle": api_style,
                "imagesRequested": len(frames),
                "frameTimestampsSeconds": [frame.get("sourceTimeSeconds") for frame in frames],
                "prompt": prompt,
                "promptChars": len(prompt),
                "numCtx": effective_ctx,
                "numPredict": effective_predict,
                "keepAlive": keep_alive if api_style == "ollama" else None,
                "requestTimeoutSeconds": timeout_seconds,
                "durationMs": int((time.time() - request_started) * 1000),
                "httpStatus": http_status,
                "outcome": outcome,
                "willRetry": retryable,
                "errorDetail": detail[:1000],
            })

        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = json.loads(response.read(8_000_000).decode("utf-8"))
        except urllib.error.HTTPError as exception:
            try:
                detail = exception.read().decode("utf-8", errors="replace")[:500]
            except OSError:
                detail = ""
            log_failure("http-error", detail, exception.code)
            lowered = detail.lower()
            if exception.code == 404 and "model" in lowered and ("not found" in lowered or "not_found" in lowered):
                raise MediaAnalysisError(
                    "VISION_MODEL_UNAVAILABLE",
                    f"Configured vision model '{model}' is not available at {base_url}.",
                    {"configuredModel": model, "httpStatus": 404, "detail": detail},
                ) from exception
            if exception.code == 400 and any(
                token in lowered for token in ("context", "too long", "exceeds", "token")
            ):
                failure = MediaAnalysisError(
                    "VISION_CONTEXT_OVERFLOW",
                    "Vision request exceeded the configured context; reduce the image batch or frame size.",
                    {"httpStatus": 400, "detail": detail, "numCtx": effective_ctx, "imagesRequested": len(frames)},
                )
                raise failure from exception
            if exception.code == 500 and "repeat" in lowered and "limit" in lowered:
                failure = MediaAnalysisError(
                    "VISION_REPEAT_LIMIT",
                    "The vision model repeated tokens until the server aborted the request.",
                    {"httpStatus": 500, "detail": detail},
                )
                if retryable:
                    last_failure = failure
                    time.sleep(0.25)
                    attempt_index += 1
                    continue
                raise failure from exception
            failure = MediaAnalysisError(
                "VISION_REQUEST_REJECTED",
                f"Vision endpoint rejected the request with HTTP {exception.code}.",
                {"detail": detail},
            )
            if 500 <= exception.code < 600 and retryable:
                last_failure = failure
                time.sleep(0.5 * (2 ** attempt_index))
                attempt_index += 1
                continue
            raise failure from exception
        except TimeoutError as exception:
            log_failure("timeout", str(exception))
            failure = MediaAnalysisError("VISION_TIMEOUT", f"Vision inference exceeded {timeout_seconds} seconds.")
            if retryable:
                last_failure = failure
                time.sleep(0.5 * (2 ** attempt_index))
                attempt_index += 1
                continue
            raise failure from exception
        except (urllib.error.URLError, OSError) as exception:
            log_failure("connection-error", str(exception))
            failure = MediaAnalysisError(
                "VISION_MODEL_UNAVAILABLE",
                f"The configured vision endpoint could not be reached at {base_url}.",
                {"reason": str(exception)},
            )
            if retryable:
                last_failure = failure
                time.sleep(0.5 * (2 ** attempt_index))
                attempt_index += 1
                continue
            raise failure from exception
        except (UnicodeDecodeError, json.JSONDecodeError) as exception:
            log_failure("invalid-endpoint-json", str(exception))
            failure = MediaAnalysisError("VISION_INVALID_RESPONSE", "Vision endpoint returned invalid JSON.")
            if retryable:
                last_failure = failure
                time.sleep(0.25)
                attempt_index += 1
                continue
            raise failure from exception

        request_meta: dict[str, Any] = {
            "attempt": attempt_index + 1,
            "jobId": stats.get("jobId") if stats is not None else None,
            "model": model,
            "apiStyle": api_style,
            "imagesRequested": len(frames),
            "frameTimestampsSeconds": [frame.get("sourceTimeSeconds") for frame in frames],
            "imageDimensions": [
                {"width": frame.get("width"), "height": frame.get("height")} for frame in frames
            ],
            "prompt": prompt,
            "promptChars": len(prompt),
            "numCtx": effective_ctx,
            "numPredict": effective_predict,
            "keepAlive": keep_alive if api_style == "ollama" else None,
            "requestTimeoutSeconds": timeout_seconds,
            "httpStatus": 200,
        }
        try:
            content_value = payload["message"]["content"] if api_style == "ollama" else payload["choices"][0]["message"]["content"]
            if isinstance(content_value, list):
                content_value = "".join(part.get("text", "") for part in content_value if isinstance(part, dict))
            if not isinstance(content_value, str):
                raise TypeError("message content must be text")
        except (KeyError, IndexError, TypeError):
            content_value = ""
        request_meta["durationMs"] = int((time.time() - request_started) * 1000)
        if api_style == "ollama":
            request_meta["doneReason"] = payload.get("done_reason")
        else:
            choices = payload.get("choices")
            request_meta["doneReason"] = choices[0].get("finish_reason") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        length_limited = request_meta["doneReason"] in ("length", "max_tokens")
        request_meta["truncated"] = length_limited
        request_meta["promptEvalTokens"] = payload.get("prompt_eval_count")
        request_meta["evalTokens"] = payload.get("eval_count")
        request_meta["contentChars"] = len(content_value)
        request_meta["contentPreview"] = content_value[:400]
        request_meta["contentSample"] = content_value[:20000]
        request_meta["responseContent"] = content_value[:100000]
        request_meta["responseContentTruncated"] = len(content_value) > 100000
        if stats is not None:
            stats["inferenceMs"] = int(stats.get("inferenceMs", 0)) + request_meta["durationMs"]
            stats["lastParse"] = None
            if length_limited:
                stats["truncatedResponses"] = int(stats.get("truncatedResponses", 0)) + 1
            actual_model = payload.get("model")
            if isinstance(actual_model, str) and actual_model:
                stats["actualModel"] = actual_model

        parsed: Any = None
        parse_recovered = False
        if not content_value.strip():
            # Thinking can consume the entire budget before any JSON starts.
            hidden_reasoning = (
                api_style == "ollama"
                and request_meta["evalTokens"]
                and request_meta["doneReason"] == "length"
            )
            request_meta["outcome"] = "empty-content"
            request_meta["truncated"] = length_limited
            _log_vision_request(request_meta)
            failure = MediaAnalysisError(
                "VISION_INVALID_RESPONSE",
                "Vision model returned empty content"
                + ("; hidden reasoning consumed the output budget" if hidden_reasoning else "")
                + "; the next attempt raises the output budget."
                if retryable else
                "Vision model returned empty content; raise AVE_VISION_NUM_PREDICT if this persists.",
            )
            if retryable:
                last_failure = failure
                attempt_index += 1
                time.sleep(0.25)
                continue
            raise failure
        repaired = _repair_truncated_json(content_value)
        if repaired is not None:
            parsed = repaired
            try:
                json.loads(content_value)
            except json.JSONDecodeError:
                parse_recovered = True
        else:
            try:
                parsed = json.loads(content_value)
            except json.JSONDecodeError:
                preview = content_value[:400].replace("\\", "\\\\")
                request_meta["outcome"] = "invalid-json"
                _log_vision_request(request_meta)
                failure = MediaAnalysisError(
                    "VISION_INVALID_RESPONSE",
                    "Vision model did not return the required JSON observations.",
                    {"contentPreview": preview},
                )
                if retryable:
                    last_failure = failure
                    attempt_index += 1
                    time.sleep(0.25)
                    continue
                raise failure
        if not isinstance(parsed, dict):
            request_meta["outcome"] = "not-an-object"
            _log_vision_request(request_meta)
            failure = MediaAnalysisError("VISION_INVALID_RESPONSE", "Vision model did not return a JSON object.")
            if retryable:
                last_failure = failure
                attempt_index += 1
                continue
            raise failure
        if parse_recovered:
            request_meta["truncated"] = True
            if stats is not None:
                stats["recoveredResponses"] = int(stats.get("recoveredResponses", 0)) + 1
                if not length_limited:
                    stats["truncatedResponses"] = int(stats.get("truncatedResponses", 0)) + 1
        is_truncated = bool(length_limited or parse_recovered)
        can_grow_output = effective_predict < 8192
        if is_truncated and retryable and can_grow_output:
            request_meta["outcome"] = "length-retry"
            request_meta["retrying"] = True
            _log_vision_request(request_meta)
            last_failure = MediaAnalysisError(
                "VISION_OUTPUT_TRUNCATED",
                "Vision output reached its token limit; retrying with a larger output budget.",
            )
            attempt_index += 1
            time.sleep(0.25)
            continue
        if is_truncated and stats is not None:
            stats["finalTruncatedResponses"] = int(stats.get("finalTruncatedResponses", 0)) + 1
        request_meta["outcome"] = (
            "truncated-final" if is_truncated else "recovered-parse" if parse_recovered else "parsed"
        )
        _log_vision_request(request_meta)
        if stats is not None:
            stats["lastParse"] = {
                "recovered": parse_recovered,
                "truncated": is_truncated,
                "lengthLimited": length_limited,
                "doneReason": request_meta["doneReason"],
                "outcome": request_meta["outcome"],
            }
        return parsed

    raise last_failure if last_failure is not None else MediaAnalysisError(
        "VISION_INVALID_RESPONSE", "Vision model did not return the required JSON observations."
    )


def analyze_media(payload: dict[str, Any]) -> dict[str, Any]:
    metadata = probe_media(payload)
    duration = metadata.get("durationSeconds")
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise MediaAnalysisError("MEDIA_DURATION_UNKNOWN", "ffprobe did not report a positive media duration.")
    max_frames = payload.get("maxFrames", 8)
    if not isinstance(max_frames, int) or isinstance(max_frames, bool) or max_frames < 1 or max_frames > MAX_FRAME_SAMPLES:
        raise MediaAnalysisError("INVALID_LIMIT", f"maxFrames must be between 1 and {MAX_FRAME_SAMPLES}.")

    base_url = os.environ.get("AVE_VISION_BASE_URL", "").strip()
    vision_model = os.environ.get("AVE_VISION_MODEL", "").strip()
    task = payload.get("task", "")
    vision_requested = bool(base_url and vision_model and isinstance(task, str) and task.strip())
    vision_preflight: dict[str, Any] | None = None
    if vision_requested:
        # Fail explicitly before any sampling when the vision service or model is unavailable.
        vision_preflight = _vision_preflight(base_url, vision_model, os.environ.get("AVE_VISION_API_KEY"))

    sample_count = min(max_frames, max(1, int(math.ceil(duration / 30.0))))
    timestamps = [duration * (index + 0.5) / sample_count for index in range(sample_count)]
    frame_error: dict[str, Any] | None = None
    try:
        frames = sample_frames({
            "path": metadata["path"],
            "timestampsSeconds": timestamps,
            "maxDimension": payload.get("maxDimension", 512),
        })
    except MediaAnalysisError as exception:
        frame_error = {"code": exception.code, "message": str(exception)}
        frames = {"frames": []}
    successful_frames = [frame for frame in frames["frames"] if frame.get("ok")]
    scene_result: dict[str, Any] | None = {"status": "not-requested"}
    scene_error: dict[str, Any] | None = None
    if payload.get("detectScenes") is True:
        try:
            scene_result = detect_scenes({
                "path": metadata["path"],
                "threshold": payload.get("sceneThreshold", 27.0),
                "maxDurationSeconds": payload.get("sceneMaxDurationSeconds", 300),
            })
        except MediaAnalysisError as exception:
            scene_error = {"code": exception.code, "message": str(exception)}
            scene_result = None

    silence_result: dict[str, Any] | None = None
    silence_error: dict[str, Any] | None = None
    if metadata.get("hasAudio") and payload.get("detectSilence") is True:
        try:
            silence_result = detect_silence({
                "path": metadata["path"],
                "noiseDb": payload.get("silenceNoiseDb", -35.0),
                "minimumSeconds": payload.get("minimumSilenceSeconds", 1.5),
            })
        except MediaAnalysisError as exception:
            silence_error = {"code": exception.code, "message": str(exception)}
    elif metadata.get("hasAudio"):
        silence_result = {"status": "not-requested"}
    else:
        silence_result = {"status": "not-applicable"}

    transcript: dict[str, Any] | None = None
    transcript_error: dict[str, Any] | None = None
    if payload.get("transcribe") is True:
        try:
            transcript = transcribe({
                "path": metadata["path"],
                "device": payload.get("transcriptionDevice", "cpu"),
                "computeType": payload.get("computeType", "int8"),
                "wordTimestamps": True,
            })
        except MediaAnalysisError as exception:
            transcript_error = {"code": exception.code, "message": str(exception)}

    semantic: dict[str, Any] = {"status": "not-configured", "observations": []}
    if vision_requested and successful_frames:
        vision_frames = successful_frames
        model_observations = []
        for offset in range(0, len(vision_frames), 2):
            response = _vision_request(
                base_url,
                vision_model,
                os.environ.get("AVE_VISION_API_KEY"),
                task,
                vision_frames[offset:offset + 2],
            )
            if isinstance(response, dict) and isinstance(response.get("observations"), list):
                model_observations.extend(response["observations"])
        valid_times = [frame["sourceTimeSeconds"] for frame in vision_frames]
        validated = []
        rejected = 0
        for observation in model_observations:
            if not isinstance(observation, dict):
                rejected += 1
                continue
            time_value = _float_or_none(observation.get("sourceTimeSeconds"))
            description = observation.get("description")
            relevance = _float_or_none(observation.get("relevance"))
            confidence = _float_or_none(observation.get("confidence"))
            if time_value is None or not any(abs(time_value - valid) <= 0.001 for valid in valid_times):
                rejected += 1
                continue
            if not isinstance(description, str) or not description.strip() or relevance is None or confidence is None:
                rejected += 1
                continue
            validated.append({
                "sourceTimeSeconds": time_value,
                "description": description.strip()[:1000],
                "relevance": min(1.0, max(0.0, relevance)),
                "confidence": min(1.0, max(0.0, confidence)),
                "reason": str(observation.get("reason", ""))[:1000],
                "evidence": "sampled-frame",
            })
        semantic = {
            "status": "complete",
            "model": vision_model,
            "preflight": vision_preflight,
            "observations": validated,
            "rejectedUnmatchedTimestamps": rejected,
            "sampledFrameCount": len(vision_frames),
        }
    elif not task:
        semantic = {"status": "not-run", "reason": "A user task is required for semantic frame analysis.", "observations": []}
    elif not successful_frames:
        semantic = {"status": "unavailable", "reason": "No frames could be sampled.", "error": frame_error, "observations": []}

    warnings = [
        "Scene cuts and silence intervals are structural evidence only; they do not identify semantic events.",
        "Sampled-frame observations are point evidence, not verified clip in/out boundaries.",
    ]
    return {
        "media": metadata,
        "sceneDetection": scene_result or {"status": "unavailable", "error": scene_error},
        "silenceDetection": silence_result or {"status": "unavailable", "error": silence_error},
        "transcription": transcript or ({"status": "unavailable", "error": transcript_error} if transcript_error else {"status": "not-requested"}),
        "sampledFrames": successful_frames,
        "frameSamplingError": frame_error,
        "visionPreflight": vision_preflight,
        "semanticAnalysis": semantic,
        "warnings": warnings,
    }


EVENT_CATEGORIES = (
    "combat", "destruction", "movement", "action", "encounter",
    "notable-moment", "scene-context", "environment-change", "other",
)
BOUNDARY_PRECISION_VALUES = ("exact", "approximate", "uncertain")
DEFAULT_EVENT_TASK = (
    "Identify meaningful, visually distinct events in this footage that would matter for automated video editing."
)
DEFAULT_VISION_BATCH_SIZE = 1
MAX_VISION_BATCH_SIZE = 8
# Batch-shaped inference failures that justify retrying frame by frame.
FALLBACK_VISION_ERRORS = ("VISION_INVALID_RESPONSE", "VISION_TIMEOUT", "VISION_REQUEST_REJECTED", "VISION_CONTEXT_OVERFLOW", "VISION_REPEAT_LIMIT")
MAX_PASS2_FRAMES = 14


def _ollama_allocation(base_url: str, api_key: str | None) -> list[dict[str, Any]]:
    """Return the loaded-model allocation reported by Ollama's ``/api/ps``."""
    try:
        parsed_url = urllib.parse.urlparse(base_url)
        if parsed_url.scheme not in ("http", "https"):
            return []
    except ValueError:
        return []
    request = urllib.request.Request(base_url.rstrip("/") + "/api/ps", headers=_vision_headers(api_key), method="GET")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read(1_000_000).decode("utf-8"))
    except (TimeoutError, urllib.error.URLError, OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return []
    rows: list[dict[str, Any]] = []
    entries = payload.get("models", [])
    if not isinstance(entries, list):
        return []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            size = max(0, int(entry.get("size") or 0))
            vram = max(0, int(entry.get("size_vram") or 0))
        except (TypeError, ValueError, OverflowError):
            continue
        gpu_percent = min(100.0, max(0.0, 100.0 * vram / size)) if size else 0.0
        rows.append({
            "model": entry.get("name"),
            "sizeBytes": size,
            "vramBytes": vram,
            "gpuPercent": round(gpu_percent, 1),
            "cpuPercent": round(100.0 - gpu_percent, 1) if size else 0.0,
            "source": "ollama-api-ps",
        })
    return rows


def _matching_allocation(allocation: list[dict[str, Any]], model: str) -> list[dict[str, Any]]:
    return [
        row for row in allocation
        if row.get("model") and (row["model"] == model or str(row["model"]).startswith(model + ":"))
    ]


def _enforce_cpu_offload_limit(
    allocation: list[dict[str, Any]], model: str, num_ctx: int,
) -> None:
    """Stop local vision inference when measured Ollama CPU offload is severe."""
    limit = _max_cpu_offload_percent()
    offenders = [row for row in _matching_allocation(allocation, model)
                 if float(row.get("cpuPercent") or 0.0) > limit]
    if not offenders:
        return
    worst = max(offenders, key=lambda row: float(row.get("cpuPercent") or 0.0))
    percent = float(worst.get("cpuPercent") or 0.0)
    raise MediaAnalysisError(
        "VISION_GPU_OFFLOAD_LIMIT",
        f"Vision inference stopped: Ollama reports {percent:.1f}% CPU offload for "
        f"{worst.get('model') or model} at num_ctx={num_ctx}; the configured limit is "
        f"{limit:.1f}%. Lower AVE_VISION_EVENT_NUM_CTX or free GPU memory, then retry.",
        {
            "model": worst.get("model") or model,
            "cpuOffloadPercent": percent,
            "gpuPercent": worst.get("gpuPercent"),
            "maxCpuOffloadPercent": limit,
            "numCtx": num_ctx,
            "allocation": worst,
            "source": "ollama-api-ps",
        },
    )


def _vision_warmup(
    base_url: str, model: str, api_key: str | None, frame: dict[str, Any], num_ctx: int,
    job_id: str | None = None, timeout_seconds: int = 900,
) -> dict[str, Any]:
    """Prime the model before timed work so load time is not counted.

    Uses the same context shape as the real requests so Ollama does not reload
    the runner when the first production request arrives. Fails softly.
    """
    started = time.time()
    prompt = "/no_think\nReply with {\"ready\": true} and nothing else. Output shape: {\"ready\":true}"
    keep_alive = _vision_keep_alive()
    def fail(reason: str, payload_row: dict[str, Any] | None = None) -> dict[str, Any]:
        _log_vision_request({
            "attempt": 0, "jobId": job_id, "model": model, "apiStyle": "ollama", "imagesRequested": 1,
            "frameTimestampsSeconds": [frame.get("sourceTimeSeconds")],
            "prompt": prompt, "promptChars": len(prompt), "numCtx": num_ctx, "numPredict": 16,
            "keepAlive": keep_alive,
            "durationMs": int((time.time() - started) * 1000),
            "httpStatus": None,
            "contentChars": 0, "contentPreview": "", "contentSample": "",
            "outcome": "warmup-failed", "reason": reason[:300],
            **(payload_row or {}),
        })
        return {"status": "failed", "durationMs": int((time.time() - started) * 1000), "reason": reason[:300]}
    try:
        image = base64.b64encode(Path(frame["thumbnailPath"]).read_bytes()).decode("ascii")
        body = {
            "model": model,
            "messages": [{"role": "user", "content": prompt, "images": [image]}],
            "format": "json",
            "stream": False,
            "think": False,
            "keep_alive": keep_alive,
            "options": {"temperature": 0, "num_predict": 16, "num_ctx": num_ctx},
        }
        request = urllib.request.Request(
            base_url.rstrip("/") + "/api/chat",
            data=json.dumps(body).encode("utf-8"),
            headers=_vision_headers(api_key),
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read(4_000_000).decode("utf-8"))
        _log_vision_request({
            "attempt": 0, "jobId": job_id, "model": model,
            "apiStyle": "ollama", "imagesRequested": 1,
            "frameTimestampsSeconds": [frame.get("sourceTimeSeconds")],
            "prompt": prompt, "promptChars": len(prompt), "numCtx": num_ctx, "numPredict": 16,
            "keepAlive": keep_alive,
            "httpStatus": 200,
            "durationMs": int((time.time() - started) * 1000),
            "doneReason": payload.get("done_reason"),
            "promptEvalTokens": payload.get("prompt_eval_count"),
            "evalTokens": payload.get("eval_count"),
            "contentChars": len(payload.get("message", {}).get("content", "") or ""),
            "contentPreview": (payload.get("message", {}).get("content") or "")[:200],
            "contentSample": (payload.get("message", {}).get("content") or "")[:2000],
            "responseContent": (payload.get("message", {}).get("content") or "")[:100000],
            "responseContentTruncated": len(payload.get("message", {}).get("content") or "") > 100000,
            "outcome": "warmup",
        })
        return {"status": "complete", "durationMs": int((time.time() - started) * 1000)}
    except (TimeoutError, urllib.error.URLError, OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exception:
        return fail(str(exception))


def _progress(message: str) -> None:
    sys.stderr.write(f"[python-worker] progress {message}\n")
    sys.stderr.flush()


def datetime_utc_now_stamp() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def _pass1_timestamps(duration: float, max_frames: int) -> list[float]:
    count = min(max_frames, max(4, int(math.ceil(duration / 10.0))), MAX_FRAME_SAMPLES)
    return [round(duration * (index + 0.5) / count, 3) for index in range(count)]


def _adaptive_timestamps(
    start: float,
    end: float,
    duration: float,
    frames_per_event: int,
    scene_cuts: list[float],
) -> list[float]:
    """Dense samples around one candidate: before, during and after the event.

    Density adapts to the candidate span (not fixed intervals), with deliberate
    boundary probes and extra samples at scene cuts inside the window.
    """
    span = max(0.5, end - start)
    margin = min(8.0, max(1.0, 0.25 * span))
    window_start = max(0.0, start - margin)
    window_end = min(duration, end + margin)
    window_span = max(0.5, window_end - window_start)
    count = max(5, min(frames_per_event, int(window_span / 0.5) + 1))
    timestamps = [window_start + window_span * index / (count - 1) for index in range(count)]
    for boundary in (start, end):
        for delta in (-0.4, 0.4):
            value = boundary + delta
            if window_start <= value <= window_end:
                timestamps.append(value)
    for cut in scene_cuts:
        if window_start < cut < window_end:
            timestamps.extend([cut - 0.3, cut + 0.3])
    normalized: list[float] = []
    for value in sorted(min(max(value, 0.0), duration) for value in timestamps):
        if not normalized or value - normalized[-1] >= 0.15:
            normalized.append(round(value, 3))
    return normalized[:MAX_PASS2_FRAMES]


def _validated_confidence(value: Any) -> float | None:
    parsed = _float_or_none(value)
    if parsed is None:
        return None
    return round(min(1.0, max(0.0, parsed)), 3)


def _validated_category(value: Any) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in EVENT_CATEGORIES:
            return normalized
    return "other"


def _validated_precision(value: Any) -> str:
    if isinstance(value, str) and value.strip().lower() in BOUNDARY_PRECISION_VALUES:
        return value.strip().lower()
    return "approximate"


def _validated_evidence(raw: Any, valid_times: list[float]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return evidence
    for item in raw:
        if not isinstance(item, dict):
            continue
        time_value = _float_or_none(item.get("sourceTimeSeconds"))
        observation = item.get("observation")
        if observation is None:
            observation = item.get("description")
        if time_value is None or not isinstance(observation, str) or not observation.strip():
            continue
        if not any(abs(time_value - valid) <= 0.001 for valid in valid_times):
            continue
        evidence.append({"sourceTimeSeconds": round(time_value, 3), "observation": observation.strip()[:1000]})
    return evidence


def _validated_candidates(raw: Any, valid_times: list[float], duration: float) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    if not isinstance(raw, dict) or not isinstance(raw.get("candidates"), list):
        return candidates
    seen: set[tuple[float, float, str]] = set()
    for index, item in enumerate(raw["candidates"]):
        if not isinstance(item, dict):
            continue
        start = _float_or_none(item.get("startTime"))
        end = _float_or_none(item.get("endTime"))
        description = item.get("description")
        if start is None or end is None or not isinstance(description, str) or not description.strip():
            continue
        start = round(min(max(start, 0.0), duration), 3)
        end = round(min(max(end, 0.0), duration), 3)
        if end < start:
            start, end = end, start
        if end - start < 0.5:
            end = round(min(duration, start + 0.5), 3)
        dedupe_key = (start, end, description.strip().lower())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        candidates.append({
            "candidateId": f"c{index + 1}",
            "startTime": start,
            "endTime": end,
            "description": description.strip()[:1000],
            "category": _validated_category(item.get("category")),
            "confidence": _validated_confidence(item.get("confidence")),
            "evidence": _validated_evidence(item.get("evidence"), valid_times),
        })
    return candidates


def _boundary_uncertainty(
    boundary: float,
    evidence_times: list[float],
    model_uncertainty: float | None,
    sample_interval: float,
    window_span: float,
) -> tuple[float, str]:
    if evidence_times:
        nearest = min(abs(boundary - time_value) for time_value in evidence_times)
    else:
        nearest = window_span
    derived = max(nearest, sample_interval / 2.0)
    if model_uncertainty is None:
        return round(derived, 3), "frame-spacing"
    if model_uncertainty >= nearest:
        return round(model_uncertainty, 3), "model"
    return round(derived, 3), "model+frame-spacing"


def _precision_after_uncertainty(precision: str, uncertainty: float, sample_interval: float) -> str:
    if precision == "exact" and uncertainty > max(1.0, sample_interval):
        return "approximate"
    if uncertainty > max(3.0, 2.0 * sample_interval):
        return "uncertain"
    return precision


def _merge_evidence(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[float] = set()
    for group in groups:
        for item in group:
            key = item["sourceTimeSeconds"]
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    merged.sort(key=lambda item: item["sourceTimeSeconds"])
    return merged


def _merge_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not events:
        return []
    ordered = sorted(events, key=lambda event: (event["start_time"], event["end_time"]))
    precision_rank = {"exact": 0, "approximate": 1, "uncertain": 2}
    merged: list[dict[str, Any]] = [ordered[0]]
    for event in ordered[1:]:
        previous = merged[-1]
        overlap = min(previous["end_time"], event["end_time"]) - max(previous["start_time"], event["start_time"])
        shorter_span = max(
            0.1,
            min(
                previous["end_time"] - previous["start_time"],
                event["end_time"] - event["start_time"],
            ),
        )
        if overlap <= 0.4 * shorter_span:
            merged.append(event)
            continue
        previous["start_time"] = min(previous["start_time"], event["start_time"])
        previous["end_time"] = max(previous["end_time"], event["end_time"])
        if len(event["description"]) > len(previous["description"]):
            previous["description"] = event["description"]
        if previous["category"] == "other" and event["category"] != "other":
            previous["category"] = event["category"]
        previous["evidence"] = _merge_evidence(previous["evidence"], event["evidence"])
        confidences = [value for value in (previous["confidence"], event["confidence"]) if value is not None]
        previous["confidence"] = max(confidences) if confidences else None
        previous["confidenceSource"] = "model" if previous["confidence"] is not None else "unavailable"
        if precision_rank[event["boundary_precision"]] > precision_rank[previous["boundary_precision"]]:
            previous["boundary_precision"] = event["boundary_precision"]
        previous["uncertainty_seconds"] = max(previous["uncertainty_seconds"], event["uncertainty_seconds"])
        previous["mergedFrom"] = sorted(set(previous.get("mergedFrom", [])) | {event["candidateId"]})
    return merged


def _rank_candidates(candidates: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    def sort_key(candidate: dict[str, Any]) -> tuple[float, float]:
        confidence = candidate["confidence"]
        # Model-reported confidence first (descending); unknown confidence ranks last.
        return (1.0 if confidence is None else 0.0, -(confidence or 0.0))

    ranked = sorted(candidates, key=lambda candidate: (sort_key(candidate), candidate["startTime"]))
    return ranked[:limit]


def _vision_response_batches(
    base_url: str,
    model: str,
    api_key: str | None,
    instruction: str,
    frames: list[dict[str, Any]],
    stats: dict[str, Any],
    schema_hint: str,
    num_ctx: int,
    batch_size: int,
    max_requests: int,
    request_fn: Callable[..., Any] | None = None,
    stop_check: Callable[[], str | None] | None = None,
    after_request: Callable[[], None] | None = None,
) -> tuple[list[tuple[Any, list[dict[str, Any]]]], list[dict[str, Any]], bool]:
    """Run bounded vision batches, retrying a failed batch frame by frame.

    Returns the successful responses paired with the exact frames each response saw,
    fallback reports, and whether the request budget stopped further work.
    """
    responses: list[tuple[Any, list[dict[str, Any]]]] = []
    fallbacks: list[dict[str, Any]] = []
    budget_hit = False
    request = request_fn or _vision_request

    def ensure_running() -> None:
        reason = stop_check() if stop_check is not None else None
        if reason:
            raise MediaAnalysisError(
                "ANALYSIS_STOPPED",
                f"Event analysis stopped between vision requests ({reason}).",
                {"reason": reason, "requestsCompleted": stats.get("requests", 0)},
            )

    for offset in range(0, len(frames), batch_size):
        ensure_running()
        if stats["requests"] >= max_requests:
            budget_hit = True
            break
        chunk = frames[offset:offset + batch_size]
        if len(chunk) == 1:
            response = request(
                base_url, model, api_key, instruction, chunk, stats, schema_hint, num_ctx,
            )
            responses.append((response, chunk))
            if after_request is not None:
                after_request()
            continue
        try:
            response = request(
                base_url, model, api_key, instruction, chunk, stats, schema_hint, num_ctx,
            )
            responses.append((response, chunk))
        except MediaAnalysisError as exception:
            if exception.code not in FALLBACK_VISION_ERRORS:
                raise
            _progress(
                f"vision batch of {len(chunk)} failed ({exception.code}); "
                "falling back to sequential single-image requests"
            )
            report: dict[str, Any] = {
                "status": "fallback-sequential",
                "requestedFrames": len(chunk),
                "errorCode": exception.code,
                "reason": str(exception),
                "singleResponses": 0,
                "failedSingles": 0,
            }
            for frame in chunk:
                ensure_running()
                if stats["requests"] >= max_requests:
                    budget_hit = True
                    break
                try:
                    single = request(
                        base_url, model, api_key, instruction, [frame], stats, schema_hint, num_ctx,
                    )
                    responses.append((single, [frame]))
                    report["singleResponses"] += 1
                    if after_request is not None:
                        after_request()
                except MediaAnalysisError as single_exception:
                    if single_exception.code not in FALLBACK_VISION_ERRORS:
                        raise
                    report["failedSingles"] += 1
                    report["singleErrorCode"] = single_exception.code
                    report["singleError"] = str(single_exception)
                    if not report["singleResponses"]:
                        # The batch failed and the first fallback failed too: surface
                        # the inference error instead of returning an empty success.
                        raise single_exception from exception
            if report["failedSingles"]:
                report["status"] = "fallback-partial"
            fallbacks.append(report)
            continue
        if after_request is not None:
            after_request()
    return responses, fallbacks, budget_hit


def analyze_events(payload: dict[str, Any]) -> dict[str, Any]:
    """Two-pass, evidence-backed event analysis driven by the configured vision model.

    Pass 1 samples representative frames across the whole video and ranks candidate
    events. Pass 2 densely re-samples around each selected candidate and refines its
    boundaries with explicit uncertainty. Vision failures raise; they never degrade
    into a successful-looking result.
    """
    metadata = probe_media(payload)
    duration = metadata.get("durationSeconds")
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise MediaAnalysisError("MEDIA_DURATION_UNKNOWN", "ffprobe did not report a positive media duration.")

    base_url = os.environ.get("AVE_VISION_BASE_URL", "").strip()
    vision_model = os.environ.get("AVE_VISION_MODEL", "").strip()
    if not base_url or not vision_model:
        raise MediaAnalysisError(
            "VISION_NOT_CONFIGURED",
            "Event analysis requires AVE_VISION_BASE_URL and AVE_VISION_MODEL.",
        )
    api_key = os.environ.get("AVE_VISION_API_KEY")

    def int_limit(name: str, value: Any, default: int, low: int, high: int) -> int:
        if value is None:
            value = default
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise MediaAnalysisError("INVALID_LIMIT", f"{name} must be between {low} and {high}.")
        return value

    pass1_max = int_limit("pass1MaxFrames", payload.get("pass1MaxFrames"), 8, 4, MAX_FRAME_SAMPLES)
    pass2_frames = int_limit("pass2FramesPerEvent", payload.get("pass2FramesPerEvent"), 6, 4, 24)
    max_events = int_limit("maxEvents", payload.get("maxEvents"), 2, 1, 50)
    max_requests = int_limit(
        "maxRequests",
        payload.get("maxRequests"),
        _env_int("AVE_VISION_MAX_REQUESTS", 24, 1, 64),
        1,
        64,
    )
    batch_size = int_limit(
        "visionBatchSize",
        payload.get("visionBatchSize"),
        _env_int("AVE_VISION_BATCH_SIZE", DEFAULT_VISION_BATCH_SIZE, 1, MAX_VISION_BATCH_SIZE),
        1,
        MAX_VISION_BATCH_SIZE,
    )
    detect_scene_cuts = payload.get("detectScenes", True) is True
    # Event batches are small by default. Measured on a 4 GB GTX 1650:
    # 5120 tokens stayed on GPU in the local sample; live allocation is checked.
    event_num_ctx = _env_int("AVE_VISION_EVENT_NUM_CTX", 5120, 2048, 131072)

    raw_task = payload.get("task")
    task = raw_task.strip() if isinstance(raw_task, str) and raw_task.strip() else DEFAULT_EVENT_TASK

    _progress("preflight: verifying vision service and configured model")
    preflight = _vision_preflight(base_url, vision_model, api_key)

    # Run-scoped setup: deadline, cancellation hook, request log.
    deadline_seconds = _env_int("AVE_ANALYSIS_DEADLINE_SECONDS", 2400, 60, 86400)
    run_started = time.time()
    cancel_path_value = os.environ.get("AVE_ANALYSIS_CANCEL_PATH", "").strip()
    run_id_value = payload.get("jobId")
    if run_id_value is not None and (
        not isinstance(run_id_value, str)
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", run_id_value)
    ):
        raise MediaAnalysisError(
            "INVALID_JOB_ID",
            "jobId must contain 1 to 128 letters, numbers, dots, underscores or hyphens.",
        )
    run_id = run_id_value or ""

    def stop_reason() -> str | None:
        """Stage-level abort check between inference requests."""
        if cancel_path_value and Path(cancel_path_value).is_file():
            return "cancelled"
        if time.time() - run_started > deadline_seconds:
            return "deadline"
        return None

    cache_dir_value = os.environ.get("AVE_ANALYSIS_CACHE_DIR", "").strip()
    request_log_path: str | None = None
    if cache_dir_value and os.environ.get("AVE_VISION_REQUEST_LOG", "1").strip().lower() not in ("0", "false", "no"):
        run_key = run_id or f"run-{datetime_utc_now_stamp()}"
        request_log_path = str(
            Path(cache_dir_value).expanduser().resolve() / "vision-requests" / f"{run_key}.jsonl"
        )
        os.environ["AVE_VISION_REQUEST_LOG_PATH"] = request_log_path
        Path(request_log_path).parent.mkdir(parents=True, exist_ok=True)

    scene_status: dict[str, Any] = {"status": "not-requested"}
    scene_cuts: list[float] = []
    if detect_scene_cuts:
        _progress("scene detection: structural boundary constraints")
        try:
            scene_result = detect_scenes({
                "path": metadata["path"],
                "threshold": payload.get("sceneThreshold", 27.0),
                "maxDurationSeconds": payload.get("sceneMaxDurationSeconds", 300),
            })
            scene_cuts = [
                scene["startSeconds"]
                for scene in scene_result["scenes"][1:]
                if scene.get("startSeconds")
            ][:50]
            scene_status = {"status": "complete", "count": scene_result["count"], "cuts": scene_cuts}
        except MediaAnalysisError as exception:
            scene_status = {"status": "error", "error": {"code": exception.code, "message": str(exception)}}

    vision_stats: dict[str, Any] = {
        "jobId": run_id or None,
        "requests": 0,
        "inferenceMs": 0,
        "actualModel": None,
        "truncatedResponses": 0,
        "recoveredResponses": 0,
        "finalTruncatedResponses": 0,
    }

    # ---------------- Pass 1: broad scan ----------------
    pass1_timestamps = _pass1_timestamps(duration, pass1_max)
    _progress(f"pass1: sampling {len(pass1_timestamps)} frames across {duration:.1f}s")
    pass1_frames_result = sample_frames({
        "path": metadata["path"],
        "timestampsSeconds": pass1_timestamps,
        "maxDimension": payload.get("maxDimensionPass1", 384),
    })
    pass1_frames = [frame for frame in pass1_frames_result["frames"] if frame.get("ok")]
    if not pass1_frames:
        raise MediaAnalysisError("FRAME_SAMPLING_FAILED", "No frames could be sampled for pass 1.")
    pass1_times = [frame["sourceTimeSeconds"] for frame in pass1_frames]

    warmup: dict[str, Any] = {"status": "not-requested"}
    if preflight["apiStyle"] == "ollama" and os.environ.get("AVE_VISION_WARMUP", "1").strip().lower() not in ("0", "false", "no"):
        abort_reason = stop_reason()
        if abort_reason:
            raise MediaAnalysisError("ANALYSIS_STOPPED", f"Event analysis stopped before warm-up ({abort_reason}).", {"reason": abort_reason})
        _progress("warmup: priming the model with the production context shape")
        remaining_seconds = max(1.0, deadline_seconds - (time.time() - run_started))
        warmup = _vision_warmup(
            base_url, vision_model, api_key, pass1_frames[0], event_num_ctx,
            run_id or None, min(900, remaining_seconds),
        )
        allocation = _ollama_allocation(base_url, api_key)
    else:
        allocation = _ollama_allocation(base_url, api_key) if preflight["apiStyle"] == "ollama" else []
    gpu_allocation = _matching_allocation(allocation, vision_model)
    if preflight["apiStyle"] == "ollama":
        _enforce_cpu_offload_limit(gpu_allocation, vision_model, event_num_ctx)

    def refresh_gpu_allocation() -> None:
        nonlocal gpu_allocation
        if preflight["apiStyle"] != "ollama":
            return
        gpu_allocation = _matching_allocation(_ollama_allocation(base_url, api_key), vision_model)
        _enforce_cpu_offload_limit(gpu_allocation, vision_model, event_num_ctx)

    def event_vision_request(*args: Any) -> Any:
        reason = stop_reason()
        if reason:
            raise MediaAnalysisError(
                "ANALYSIS_STOPPED",
                f"Event analysis stopped before a vision request ({reason}).",
                {"reason": reason, "requestsCompleted": vision_stats["requests"]},
            )
        remaining_seconds = deadline_seconds - (time.time() - run_started)
        if remaining_seconds <= 0:
            raise MediaAnalysisError(
                "ANALYSIS_STOPPED", "Event analysis reached its overall deadline.",
                {"reason": "deadline", "requestsCompleted": vision_stats["requests"]},
            )
        remaining_attempts = max_requests - vision_stats["requests"]
        if remaining_attempts <= 0:
            raise MediaAnalysisError(
                "ANALYSIS_REQUEST_BUDGET",
                "Event analysis reached its sequential vision-request limit.",
                {"maxRequests": max_requests, "requestsCompleted": vision_stats["requests"]},
            )
        return _vision_request(
            *args,
            timeout_seconds_override=remaining_seconds,
            max_attempts_override=remaining_attempts,
        )

    pass1_instruction = (
        f"{task} Scan the whole video. "
        "startTime and endTime are approximate bounds within 0 to "
        f"{duration:.3f} seconds; do not pretend to know exact boundaries from sparse frames. "
        "category must be one of: " + ", ".join(EVENT_CATEGORIES) + ". "
        "confidence is your own certainty from 0 to 1; use null if unsure. "
        "evidence must reference only timestamps from the frame mapping. "
        "If nothing notable is visible, return an empty candidates array."
    )
    pass1_schema = (
        'Output shape: {"candidates":[{"startTime":0.0,"endTime":0.0,"description":"...",'
        '"category":"other","confidence":0.0,'
        '"evidence":[{"sourceTimeSeconds":0.0,"observation":"..."}]}]}'
    )

    raw_candidates: list[Any] = []
    batch_total = (len(pass1_frames) + batch_size - 1) // batch_size
    _progress(f"pass1: {batch_total} vision batch(es) of up to {batch_size} frame(s)")
    abort_reason = stop_reason()
    if abort_reason:
        raise MediaAnalysisError(
            "ANALYSIS_STOPPED",
            f"Event analysis stopped before pass 1 ({abort_reason}); nothing was observed.",
            {"reason": abort_reason, "elapsedSeconds": round(time.time() - run_started, 1)},
        )
    pass1_responses, pass1_fallbacks, pass1_budget_hit = _vision_response_batches(
        base_url, vision_model, api_key, pass1_instruction, pass1_frames,
        vision_stats, pass1_schema, event_num_ctx, batch_size, max_requests,
        request_fn=event_vision_request,
        stop_check=stop_reason,
        after_request=refresh_gpu_allocation,
    )
    for response, _chunk in pass1_responses:
        if isinstance(response, dict) and isinstance(response.get("candidates"), list):
            raw_candidates.extend(response["candidates"])

    candidates = _validated_candidates({"candidates": raw_candidates}, pass1_times, duration)
    if not candidates:
        _progress("pass1: no candidate events reported by the model")
    ranked = _rank_candidates(candidates, max_events)

    # ---------------- Pass 2: adaptive densification ----------------
    events: list[dict[str, Any]] = []
    pass2_reports: list[dict[str, Any]] = []
    aborted: str | None = None
    for candidate in ranked:
        abort_reason = stop_reason()
        if abort_reason:
            aborted = abort_reason
            pass2_reports.append({
                "candidateId": candidate["candidateId"],
                "status": f"skipped-{abort_reason}",
                "reason": "Run stopped between inference requests; boundaries stay pass-1 estimates.",
            })
            events.append(_pass1_event(candidate))
            continue
        if vision_stats["requests"] >= max_requests:
            pass2_reports.append({
                "candidateId": candidate["candidateId"],
                "status": "skipped-request-budget",
                "requestsUsed": vision_stats["requests"],
            })
            events.append(_pass1_event(candidate))
            continue
        window_start = max(0.0, candidate["startTime"] - min(8.0, max(1.0, 0.25 * max(0.5, candidate["endTime"] - candidate["startTime"]))))
        window_end = min(duration, candidate["endTime"] + min(8.0, max(1.0, 0.25 * max(0.5, candidate["endTime"] - candidate["startTime"]))))
        timestamps = _adaptive_timestamps(
            candidate["startTime"], candidate["endTime"], duration, pass2_frames, scene_cuts,
        )
        _progress(
            f"pass2: {candidate['candidateId']} dense sampling {len(timestamps)} frames "
            f"({window_start:.1f}s..{window_end:.1f}s)"
        )
        frames_result = sample_frames({
            "path": metadata["path"],
            "timestampsSeconds": timestamps,
            "maxDimension": payload.get("maxDimensionPass2", 512),
        })
        frames = [frame for frame in frames_result["frames"] if frame.get("ok")]
        if not frames:
            pass2_reports.append({"candidateId": candidate["candidateId"], "status": "frame-sampling-failed"})
            events.append(_pass1_event(candidate))
            continue
        confidence_text = "null" if candidate["confidence"] is None else f"{candidate['confidence']}"
        pass2_instruction = (
            f"Pass 1 reported this candidate event: {candidate['description']} "
            f"(category {candidate['category']}, approximately {candidate['startTime']} to "
            f"{candidate['endTime']} seconds, pass-1 confidence {confidence_text}). "
            "Analyze what happens BEFORE, DURING and AFTER this event in the supplied frames. "
            "Refine startTime and endTime only where the frames support them; otherwise keep them "
            "approximate and say so. boundaryPrecision must be one of exact, approximate, uncertain. "
            "uncertaintySeconds is your own boundary uncertainty in seconds, or null. "
            "evidence must reference only timestamps from the frame mapping. "
            f"All times must stay within {window_start:.3f} to {window_end:.3f} seconds."
        )
        pass2_schema = (
            'Output shape: {"event":{"startTime":0.0,"endTime":0.0,"description":"...","category":"other",'
            '"confidence":0.0,"boundaryPrecision":"approximate","uncertaintySeconds":0.0,'
            '"evidence":[{"sourceTimeSeconds":0.0,"observation":"..."}],"progression":"before -> during -> after"}}'
        )
        pass2_batch_total = (len(frames) + batch_size - 1) // batch_size
        _progress(
            f"pass2: {candidate['candidateId']} {pass2_batch_total} vision batch(es) "
            f"of up to {batch_size} frame(s)"
        )
        pass2_responses, pass2_fallbacks, budget_hit = _vision_response_batches(
            base_url, vision_model, api_key, pass2_instruction, frames,
            vision_stats, pass2_schema, event_num_ctx, batch_size, max_requests,
            request_fn=event_vision_request,
            stop_check=stop_reason,
            after_request=refresh_gpu_allocation,
        )
        refined_events: list[dict[str, Any]] = []
        for response, chunk in pass2_responses:
            chunk_times = [frame["sourceTimeSeconds"] for frame in chunk]
            refined = _refine_event(
                response, candidate, chunk_times, window_start, window_end, pass2_frames,
            )
            if refined is not None:
                refined_events.append(refined)
        if not refined_events:
            report: dict[str, Any] = {
                "candidateId": candidate["candidateId"],
                "status": "skipped-request-budget" if budget_hit else "no-usable-refinement",
            }
            if pass2_fallbacks:
                report["fallbacks"] = pass2_fallbacks
            pass2_reports.append(report)
            events.append(_pass1_event(candidate))
            continue
        report = {
            "candidateId": candidate["candidateId"],
            "status": "refined-partial-budget" if budget_hit else "refined",
            "batchesRefined": len(refined_events),
        }
        if pass2_fallbacks:
            report["fallbacks"] = pass2_fallbacks
        pass2_reports.append(report)
        # All refinements target the same candidate; merging combines their evidence.
        events.append(_merge_events(refined_events)[0])

    merged = _merge_events(events)
    merged.sort(key=lambda event: event["start_time"])

    warnings = [
        "Event boundaries are model-reported and carry explicit uncertainty; they are not verified edit points.",
        "Scene cuts are structural constraints only and never prove an event occurred.",
        "Confidence values are model-reported; null means the model did not provide one.",
    ]
    if aborted:
        warnings.append(
            f"Run stopped {aborted} between inference requests; remaining candidates kept pass-1 boundaries only."
        )
    if pass1_budget_hit or any(report.get("status") == "skipped-request-budget" for report in pass2_reports):
        warnings.append(
            f"The sequential vision-request budget ({max_requests}) was reached; remaining work was skipped."
        )
    offloaded = next((row for row in gpu_allocation if row.get("cpuPercent", 0.0) > 0.0), None)
    if vision_stats["finalTruncatedResponses"]:
        warnings.append(
            "One or more final vision responses still reached the output token limit; recovered JSON may omit later observations."
        )
    if vision_stats["recoveredResponses"]:
        warnings.append(
            f"JSON recovery repaired {vision_stats['recoveredResponses']} truncated or malformed vision response(s); inspect the per-request log."
        )
    if preflight["apiStyle"] == "ollama" and not gpu_allocation:
        warnings.append("Ollama did not report a loaded-model allocation through /api/ps; GPU/CPU placement is unknown.")
    fallback_reports = pass1_fallbacks + [
        fallback
        for report in pass2_reports
        for fallback in report.get("fallbacks", [])
    ]
    partial = bool(
        aborted
        or pass1_budget_hit
        or any(report.get("status") == "skipped-request-budget" for report in pass2_reports)
        or vision_stats["finalTruncatedResponses"]
        or any(report.get("status") == "fallback-partial" for report in fallback_reports)
    )
    vision_provenance = {
        "provider": preflight["apiStyle"],
        "endpoint": preflight["endpoint"],
        "configuredModel": vision_model,
        "actualModel": vision_stats.get("actualModel"),
        "status": "partial" if partial else "complete",
        "requests": vision_stats["requests"],
        "inferenceMs": vision_stats["inferenceMs"],
        "batchSize": batch_size,
        "numCtx": event_num_ctx,
        "numPredict": _env_int("AVE_VISION_NUM_PREDICT", 2048, 128, 8192),
        "requestTimeoutSeconds": _vision_request_timeout_seconds(),
        "overallTimeoutSeconds": deadline_seconds,
        "elapsedSeconds": round(time.time() - run_started, 1),
        "keepAlive": _vision_keep_alive(),
        "maxCpuOffloadPercent": _max_cpu_offload_percent(),
        "allocationStatus": "measured" if gpu_allocation else "unavailable",
        "warmup": warmup,
        "gpuAllocation": gpu_allocation,
        "allocationSampledAfterEachRequest": preflight["apiStyle"] == "ollama",
        "sequentialRequests": True,
        "fallbackCount": len(fallback_reports),
        "truncatedResponseAttempts": vision_stats["truncatedResponses"],
        "recoveredResponseAttempts": vision_stats["recoveredResponses"],
        "finalTruncatedResponses": vision_stats["finalTruncatedResponses"],
        "requestLogPath": request_log_path,
        "lastParse": vision_stats.get("lastParse"),
    }
    if offloaded:
        warnings.append(
            f"Ollama reported {offloaded['cpuPercent']}% CPU offload, below the stop limit "
            f"of {_max_cpu_offload_percent():.1f}%; inference may be slower than all-GPU execution."
        )
    return {
        "source": "automated_vision_analysis",
        "model": vision_model,
        "actualModel": vision_stats.get("actualModel") or vision_model,
        "task": task,
        "jobId": run_id or None,
        "media": metadata,
        "events": merged,
        "eventCount": len(merged),
        "candidateCount": len(candidates),
        "passes": {
            "batchSize": batch_size,
            "pass1": {
                "sampledFrames": len(pass1_frames),
                "sampledTimestamps": pass1_times,
                "candidatesReported": len(raw_candidates),
                "candidatesValidated": len(candidates),
                "candidatesSelected": len(ranked),
                "requestBudgetExhausted": pass1_budget_hit,
                "fallbacks": pass1_fallbacks,
            },
            "pass2": {"reports": pass2_reports},
        },
        "provenance": {
            "vision": vision_provenance,
            "ffprobe": {"status": "complete"},
            "sceneDetection": scene_status,
            "audioAnalysis": {"status": "not-requested"},
            "manualObservations": [],
        },
        "warnings": warnings,
    }


def _pass1_event(candidate: dict[str, Any]) -> dict[str, Any]:
    """Event built only from Pass 1 evidence, marked honestly as uncertain."""
    span = max(0.5, candidate["endTime"] - candidate["startTime"])
    return {
        "candidateId": candidate["candidateId"],
        "mergedFrom": [candidate["candidateId"]],
        "start_time": candidate["startTime"],
        "end_time": candidate["endTime"],
        "description": candidate["description"],
        "category": candidate["category"],
        "evidence": candidate["evidence"],
        "confidence": candidate["confidence"],
        "confidenceSource": "model" if candidate["confidence"] is not None else "unavailable",
        "boundary_precision": "uncertain",
        "uncertainty_seconds": round(span / 2.0, 3),
        "uncertaintySource": "frame-spacing",
        "progression": "",
        "refinement": "pass1-only",
        "pass1": {
            "startTime": candidate["startTime"],
            "endTime": candidate["endTime"],
            "confidence": candidate["confidence"],
        },
    }


def _refine_event(
    response: Any,
    candidate: dict[str, Any],
    valid_times: list[float],
    window_start: float,
    window_end: float,
    pass2_frames: int,
) -> dict[str, Any] | None:
    if not isinstance(response, dict) or not isinstance(response.get("event"), dict):
        return None
    raw = response["event"]
    start = _float_or_none(raw.get("startTime"))
    end = _float_or_none(raw.get("endTime"))
    description = raw.get("description")
    if start is None or end is None or not isinstance(description, str) or not description.strip():
        return None
    # Clamp to the sampled window: values outside it were not observed.
    start = round(min(max(start, window_start), window_end), 3)
    end = round(min(max(end, window_start), window_end), 3)
    if end < start:
        start, end = end, start
    if end - start < 0.5:
        end = round(min(window_end, start + 0.5), 3)

    evidence = _merge_evidence(
        candidate["evidence"],
        _validated_evidence(raw.get("evidence"), valid_times),
    )
    evidence_times = [item["sourceTimeSeconds"] for item in evidence]
    window_span = max(0.5, window_end - window_start)
    sample_interval = window_span / max(1, pass2_frames - 1)

    model_uncertainty = _float_or_none(raw.get("uncertaintySeconds"))
    if model_uncertainty is not None:
        model_uncertainty = max(0.0, model_uncertainty)
    start_uncertainty, start_source = _boundary_uncertainty(
        start, evidence_times, model_uncertainty, sample_interval, window_span,
    )
    end_uncertainty, end_source = _boundary_uncertainty(
        end, evidence_times, model_uncertainty, sample_interval, window_span,
    )
    uncertainty = max(start_uncertainty, end_uncertainty)
    if start_source == "frame-spacing" and end_source == "frame-spacing":
        uncertainty_source = "frame-spacing"
    elif "frame-spacing" in (start_source, end_source):
        uncertainty_source = "model+frame-spacing"
    else:
        uncertainty_source = "model"
    precision = _precision_after_uncertainty(
        _validated_precision(raw.get("boundaryPrecision")), uncertainty, sample_interval,
    )
    confidence = _validated_confidence(raw.get("confidence"))
    category = _validated_category(raw.get("category")) if raw.get("category") else candidate["category"]
    if category == "other" and candidate["category"] != "other":
        category = candidate["category"]

    return {
        "candidateId": candidate["candidateId"],
        "mergedFrom": [candidate["candidateId"]],
        "start_time": start,
        "end_time": end,
        "description": description.strip()[:1000],
        "category": category,
        "evidence": evidence,
        "confidence": confidence,
        "confidenceSource": "model" if confidence is not None else "unavailable",
        "boundary_precision": precision,
        "uncertainty_seconds": uncertainty,
        "uncertaintySource": uncertainty_source,
        "progression": str(raw.get("progression", ""))[:1000],
        "refinement": "pass1+pass2",
        "pass1": {
            "startTime": candidate["startTime"],
            "endTime": candidate["endTime"],
            "confidence": candidate["confidence"],
        },
    }
