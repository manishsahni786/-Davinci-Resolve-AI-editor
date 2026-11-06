#!/usr/bin/env python3
"""Benchmark local vision inference against measured GPU/CPU allocation.

Order:
1. Warm-up request (model load recorded, excluded from steady-state rows).
2. Context sweep with one image and the production-style prompt.
3. Image-count sweep (1, 2 and 4 images) with short and production prompts at
   each requested context.

Each steady row records duration, done_reason, token counts, content length,
JSON validity, and the loaded model's GPU/CPU split from /api/ps. Std-lib only;
local endpoints only; no media leaves the machine.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PRODUCTION_PROMPT = (
    "/no_think\n"
    "You are analyzing sampled video frames from one video.\n"
    "Frame mapping (image index to exact source timestamp):\n{labels}\n\n"
    "Identify notable activity in these frames. Return JSON only, no prose outside the JSON.\n"
    'Output shape: {{"candidates":[{{"startTime":0.0,"endTime":0.0,"description":"...",'
    '"category":"other","confidence":0.0,"evidence":[{{"sourceTimeSeconds":0.0,"observation":"..."}}]}}]}}\n'
    "Use only timestamps from the mapping above; do not invent boundaries. "
    "If nothing notable is visible, return an empty candidates array."
)
SHORT_PROMPT = (
    "/no_think\nDescribe each image in one short phrase. Return one JSON object only, "
    "with an images array containing one description per image."
)
SHORT_SCHEMA = '{"images":[{"description":"..."}]}'
OLLAMA_ENV_NAMES = (
    "OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_NUM_PARALLEL",
    "OLLAMA_CONTEXT_LENGTH", "OLLAMA_KEEP_ALIVE", "OLLAMA_GPU_OVERHEAD",
    "OLLAMA_MAX_LOADED_MODELS", "OLLAMA_DEBUG", "CUDA_VISIBLE_DEVICES",
)


def server_environment_from_log(log_path: str | None, live_version: str | None) -> dict | None:
    """Read tracked OLLAMA settings and flag logs from a different server version."""
    if not log_path:
        return None
    try:
        lines = Path(log_path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    server_version = None
    for line in reversed(lines):
        match = re.search(r"Listening on .* \(version[= ]([^)]+)\)", line)
        if match:
            server_version = match.group(1)
            break
    for line in reversed(lines):
        if 'msg="server config"' not in line:
            continue
        match = re.search(r'env="map\[(.*?)\]"', line)
        if not match:
            continue
        pairs = dict(re.findall(r"([A-Z][A-Z0-9_]*):([^\s]+)", match.group(1)))
        return {
            "version": server_version,
            "matchesLiveVersion": bool(live_version and server_version == live_version),
            "environment": {name: pairs.get(name, "") for name in OLLAMA_ENV_NAMES},
        }
    return None


def http_bytes(url: str, body: dict | None, timeout: int, method: str = "POST") -> tuple[int, bytes]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read(64_000_000)


def model_state(base_url: str) -> list[dict]:
    try:
        _status, body = http_bytes(base_url.rstrip("/") + "/api/ps", None, 5, "GET")
        payload = json.loads(body.decode("utf-8"))
        rows = []
        for model in payload.get("models", []):
            size = int(model.get("size") or 0)
            vram = int(model.get("size_vram") or 0)
            cpu_percent = min(100.0, max(0.0, 100.0 * (1.0 - vram / size))) if size else 0.0
            rows.append({
                "model": model.get("name"),
                "sizeBytes": size,
                "vramBytes": vram,
                "gpuPercent": round(100.0 - cpu_percent, 1),
                "cpuPercent": round(cpu_percent, 1),
                "contextLength": model.get("context_length"),
                "source": "ollama-api-ps",
            })
        return rows
    except (OSError, ValueError, json.JSONDecodeError):
        return []


def run_one(base_url: str, model: str, prompt: str, images: list[str], num_ctx: int,
            num_predict: int, label: str, keep_alive: str) -> dict:
    print(
        f"[vision-bench] {label}: {len(images)} image(s), num_ctx={num_ctx}, num_predict={num_predict}",
        file=sys.stderr,
        flush=True,
    )
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt, "images": images}],
        "format": "json",
        "stream": False,
        "think": False,
        "keep_alive": keep_alive,
        "options": {"temperature": 0, "num_predict": num_predict, "num_ctx": num_ctx},
    }
    row = {
        "label": label,
        "imageCount": len(images),
        "numCtx": num_ctx,
        "numPredict": num_predict,
        "promptChars": len(prompt),
    }
    started = time.time()
    try:
        status, payload_bytes = http_bytes(base_url.rstrip("/") + "/api/chat", body, 900)
        row["durationMs"] = int((time.time() - started) * 1000)
        row["httpStatus"] = status
        payload = json.loads(payload_bytes.decode("utf-8"))
        message = payload.get("message") or {}
        raw = message.get("content", "")
        content = "".join(
            part.get("text", "") for part in raw if isinstance(part, dict)
        ) if isinstance(raw, list) else str(raw)
        row.update({
            "doneReason": payload.get("done_reason"),
            "promptEvalTokens": payload.get("prompt_eval_count"),
            "evalTokens": payload.get("eval_count"),
            "durationMsModelReported": round(payload["total_duration"] / 1_000_000, 1)
            if isinstance(payload.get("total_duration"), (int, float)) else None,
            "reasoningChars": len((message.get("thinking") or "")) if isinstance(message.get("thinking"), str) else 0,
        })
    except (OSError, ValueError, json.JSONDecodeError) as exception:
        detail = ""
        if isinstance(exception, urllib.error.HTTPError):
            try:
                detail = exception.read().decode("utf-8", errors="replace")[:200]
            except OSError:
                detail = ""
        row["durationMs"] = int((time.time() - started) * 1000)
        row["failure"] = f"{exception}"[:300]
        row["failureDetail"] = detail
        row["contentChars"] = 0
        row["jsonValid"] = False
        return row
    row["contentChars"] = len(content)
    row["contentPreview"] = content[:160].replace("\n", " ")
    try:
        parsed = json.loads(content)
        row["jsonValid"] = isinstance(parsed, dict)
    except json.JSONDecodeError:
        row["jsonValid"] = False
    row["truncated"] = row.get("doneReason") in ("length", "max_tokens")
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark the local vision model.")
    parser.add_argument("--base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--model", default="qwen3-vl:2b")
    parser.add_argument("--frames", nargs="+", required=True)
    parser.add_argument("--timestamps", nargs="+", type=float,
                        help="Exact source timestamps, one per frame; otherwise parsed from frame-<index>-<milliseconds>.jpg names.")
    parser.add_argument("--contexts", nargs="+", type=int, default=[2048, 4096, 8192])
    parser.add_argument("--num-predict", type=int, default=768,
                        help="Output token limit for production-style rows.")
    parser.add_argument("--short-num-predict", type=int, default=128)
    parser.add_argument("--warmup-context", type=int, default=2048)
    parser.add_argument("--keep-alive", default=os.environ.get("AVE_VISION_KEEP_ALIVE", "45m"))
    parser.add_argument("--server-log", help="Ollama server startup log; records its tracked OLLAMA_* settings.")
    parser.add_argument("--max-cpu-offload", type=float, default=20.0,
                        help="Mark rows above this /api/ps CPU allocation as severe.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--image-sweep-contexts", nargs="+", type=int, default=[2048])
    parser.add_argument("--no-image-sweep", action="store_true")
    args = parser.parse_args()

    frame_paths = [Path(p).resolve(strict=True) for p in args.frames]
    if args.timestamps is not None:
        if len(args.timestamps) != len(frame_paths) or any(value < 0 for value in args.timestamps):
            parser.error("--timestamps must contain one non-negative value per --frames entry")
        timestamps = [round(value, 3) for value in args.timestamps]
        timestamp_source = "arguments"
    else:
        timestamps = []
        for frame_path in frame_paths:
            match = re.fullmatch(r"frame-\d+-(\d+)", frame_path.stem)
            if not match:
                parser.error(
                    f"Cannot infer source time from {frame_path.name}; pass --timestamps with one exact time per frame"
                )
            timestamps.append(round(int(match.group(1)) / 1000.0, 3))
        timestamp_source = "frame-filename-milliseconds"
    service_version = None
    try:
        _status, body = http_bytes(args.base_url.rstrip("/") + "/api/tags", None, 10, "GET")
        names = [entry.get("name") for entry in json.loads(body.decode("utf-8")).get("models", [])
                 if isinstance(entry, dict)]
        if not any(name == args.model or str(name).startswith(args.model + ":") for name in names):
            print(f"model missing at {args.base_url}: {names}", file=sys.stderr)
            return 2
        try:
            _status, version_body = http_bytes(args.base_url.rstrip("/") + "/api/version", None, 5, "GET")
            service_version = json.loads(version_body.decode("utf-8")).get("version")
        except (OSError, ValueError, json.JSONDecodeError):
            service_version = None
    except OSError as exception:
        print(f"service unreachable: {exception}", file=sys.stderr)
        return 2

    images = [base64.b64encode(path.read_bytes()).decode("ascii") for path in frame_paths]
    run_started = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    gpu_samples: list[dict] = []

    warmup_body = {
        "model": args.model,
        "messages": [{"role": "user", "content": "/no_think\nReply with {\"ready\":true} and nothing else.",
                      "images": images[:1]}],
        "format": "json", "stream": False, "think": False, "keep_alive": args.keep_alive,
        "options": {"temperature": 0, "num_predict": 16, "num_ctx": args.warmup_context},
    }
    print(
        f"[vision-bench] warm-up: 1 image, num_ctx={args.warmup_context}, keep_alive={args.keep_alive}",
        file=sys.stderr,
        flush=True,
    )
    started = time.time()
    try:
        status, _payload = http_bytes(args.base_url.rstrip("/") + "/api/chat", warmup_body, 900)
        rows.append({"label": "warmup", "numCtx": args.warmup_context, "numPredict": 16,
                     "keepAlive": args.keep_alive, "httpStatus": status,
                     "durationMs": int((time.time() - started) * 1000), "steadyState": False})
    except (OSError, ValueError) as exception:
        print(f"warmup failed: {exception}", file=sys.stderr)
        return 2
    warmup_allocation = model_state(args.base_url)
    gpu_samples.append({"phase": "after-warmup", "numCtx": args.warmup_context, "ps": warmup_allocation})

    labels = "\n".join(f"Image {index + 1} = {ts} seconds" for index, ts in enumerate(timestamps))
    production = PRODUCTION_PROMPT.format(labels=labels)

    for num_ctx in args.contexts:
        row = run_one(args.base_url, args.model, production, images[:1], num_ctx,
                      args.num_predict, f"production-ctx{num_ctx}-x1", args.keep_alive)
        row["steadyState"] = True
        row["keepAlive"] = args.keep_alive
        rows.append(row)
        split = model_state(args.base_url)
        row["gpuAllocation"] = split
        row["cpuOffloadExceededThreshold"] = any(
            item.get("cpuPercent", 0.0) > args.max_cpu_offload for item in split
        )
        gpu_samples.append({"phase": "after-ctx-sweep", "numCtx": num_ctx, "ps": split})

    if not args.no_image_sweep:
        # Compare short and event-analysis prompts at the safe, measured context.
        for count in (1, 2, 4):
            if count > len(frame_paths):
                continue
            sweep_labels = "\n".join(f"Image {index + 1} = {ts} seconds" for index, ts in enumerate(timestamps[:count]))
            sweep_prompt = PRODUCTION_PROMPT.format(labels=sweep_labels)
            for sweep_ctx in args.image_sweep_contexts:
                for prompt_kind, prompt, predict in (
                    ("short", SHORT_PROMPT + "\n" + SHORT_SCHEMA, args.short_num_predict),
                    ("production", sweep_prompt, args.num_predict),
                ):
                    row = run_one(
                        args.base_url, args.model, prompt, images[:count], sweep_ctx,
                        predict, f"{prompt_kind}-ctx{sweep_ctx}-x{count}", args.keep_alive,
                    )
                    row["steadyState"] = True
                    row["promptKind"] = prompt_kind
                    row["keepAlive"] = args.keep_alive
                    split = model_state(args.base_url)
                    row["gpuAllocation"] = split
                    row["cpuOffloadExceededThreshold"] = any(
                        item.get("cpuPercent", 0.0) > args.max_cpu_offload for item in split
                    )
                    rows.append(row)
                    gpu_samples.append({"phase": "image-sweep", "images": count,
                                        "promptKind": prompt_kind, "ctx": sweep_ctx, "ps": split})

    result = {
        "runStartedAt": run_started,
        "base_url": args.base_url,
        "model": args.model,
        "ollamaVersion": service_version,
        "keepAlive": args.keep_alive,
        "maxCpuOffloadPercent": args.max_cpu_offload,
        "runtimeEnvironment": {name: os.environ.get(name) for name in OLLAMA_ENV_NAMES},
        "serverEnvironmentFromLog": server_environment_from_log(args.server_log, service_version),
        "serverLogPath": str(Path(args.server_log).resolve()) if args.server_log else None,
        "clientVisionEnvironment": {
            name: os.environ.get(name)
            for name in ("AVE_VISION_API_STYLE", "AVE_VISION_NUM_CTX", "AVE_VISION_NUM_PREDICT",
                         "AVE_VISION_EVENT_NUM_CTX", "AVE_VISION_KEEP_ALIVE", "AVE_VISION_BATCH_SIZE")
        },
        "frames": [str(path) for path in frame_paths],
        "frameTimestampsSeconds": timestamps,
        "frameTimestampSource": timestamp_source,
        "imageDimensions": [{"path": path.name} for path in frame_paths],
        "rows": rows,
        "gpuSamples": gpu_samples,
        "notes": [
            "Warm-up request duration includes model loading when required.",
            "Inference request duration is wall-clock and may include a runner reload when num_ctx changes.",
            "cpuPercent from /api/ps size_vram vs size sampled after each inference request.",
            "runtimeEnvironment records only this benchmark process; set Ollama service variables before starting the Ollama service.",
            "Treat serverEnvironmentFromLog as current only when matchesLiveVersion is true; startup logs can be stale.",
            "The benchmark records severe allocation but does not stop the sweep; production analysis enforces the configured threshold.",
        ],
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
