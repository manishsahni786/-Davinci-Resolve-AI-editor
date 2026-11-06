# Local vision analysis

`analyze_events` is a read-only, two-pass workflow. It samples representative frames, asks the configured vision model for candidate events, then samples around selected candidates to refine their boundaries. It validates evidence against the timestamps actually sampled. A draft editing plan can be made from the result, but Resolve changes remain behind the separate plan approval workflow.

## Local Ollama and GPU allocation

The current local setup uses `qwen3-vl:2b` with Ollama. The runtime reads the loaded model's `size` and `size_vram` from Ollama's `GET /api/ps` response and records the split in the event provenance. CPU percentage is `100 × (size - size_vram) / size`.

The worker samples allocation after warm-up and after each successful vision request. By default, it stops with `VISION_GPU_OFFLOAD_LIMIT` when measured CPU offload exceeds 20%. Set `AVE_VISION_MAX_CPU_OFFLOAD_PERCENT` to change that limit. If `/api/ps` does not return the configured model, placement is reported as unknown; the worker does not pretend it measured GPU placement.

`AVE_VISION_EVENT_NUM_CTX` controls event-analysis context. Requests are sequential, and `AVE_VISION_BATCH_SIZE` defaults to one image. Larger batches are opt-in and fall back to sequential single-image calls after a batch failure. `AVE_VISION_MAX_REQUESTS` limits actual HTTP attempts, including retries.

Ollama server variables must be set before the Ollama server starts; they are not read from this project's `.env`. Flash Attention and KV cache quantization can reduce context memory use. On a supported server, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, and `OLLAMA_MAX_LOADED_MODELS=1` are useful 4 GB GPU settings. Restart Ollama after changing them. `AVE_VISION_KEEP_ALIVE` controls the per-request `keep_alive` value; the example is 45 minutes. See the [Ollama memory FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx) for current server options.

## Prompts and JSON recovery

Vision prompts are kept short and list the exact timestamp for each image. The response must be one JSON object and use only those times. Pass 1 caps candidates and requests concise descriptions.

If Ollama reports `done_reason: "length"`, or the response needs structural JSON repair, the worker retries with a larger `num_predict` budget, doubling it up to 8192 tokens. A repaired response is marked in `provenance.vision.lastParse`. If the final attempt still ends at the token limit, the result is marked `partial` and includes a warning that later observations may be missing. Multi-image failures trigger serial single-image fallback; failed vision requests never turn into a successful-looking empty result.

Each event run writes one JSONL file at `data/analysis-cache/vision-requests/<jobId>.jsonl`. Each line includes request duration, model, context and output budgets, finish reason, token counts, parse outcome, and up to 100,000 characters of model response text. The log excludes the base64 image data. These logs can still contain sensitive descriptions from the footage; keep them local and review before sharing.

## Timeouts, jobs, and orchestration

Each run receives a UUID job ID, echoed in the result and included in its response-log path. MCP cancellation terminates the Python worker. The Python workflow also checks its cancellation marker between inference requests. Vision jobs are limited to one active job at a time, and requests within a job are sequential.

`AVE_VISION_REQUEST_TIMEOUT_SECONDS` bounds one Ollama request (default 600 seconds). `AVE_ANALYSIS_DEADLINE_SECONDS` bounds the Python event workflow (default 2400 seconds); `AVE_ANALYSIS_TIMEOUT_MS` is the outer Node worker timeout (default 45 minutes). The outer timeout leaves time to return a clear Python deadline error first.

Event analysis only reads the source media and derived thumbnails. The plan-drafting tool also only writes a local draft. Resolve execution remains a separate operation and requires an explicitly approved plan.

## Limits

- `qwen3-vl:2b` is a small model; event descriptions and boundaries can be incomplete or wrong.
- Event times are model estimates. The result carries evidence and uncertainty, but they are not verified edit points.
- At most eight images are sent per request. Event requests default to one image.
- The worker does not trim media, mix audio, render, or edit a Resolve timeline during analysis.
- FFmpeg and FFprobe are required for video probing and frame extraction. OpenCV and PySceneDetect are optional Python dependencies; transcription requires a separately installed local faster-whisper model.
- GPU placement varies with other apps and current VRAM pressure. Use `/api/ps` measurements from the current run rather than assuming a fixed context fits every time.

## Troubleshooting

| Symptom | Check | Action |
| --- | --- | --- |
| `VISION_GPU_OFFLOAD_LIMIT` | Read `cpuOffloadPercent`, `numCtx`, and `gpuAllocation` in the error details. | Lower `AVE_VISION_EVENT_NUM_CTX`, close other GPU-heavy apps, or restart Ollama with one parallel request and a quantized KV cache. |
| GPU placement is `unavailable` | The model is missing from `/api/ps`, or that endpoint is not available. | Confirm Ollama is running locally and the model remains loaded after warm-up. |
| `VISION_INVALID_RESPONSE` or a partial result | Inspect the job's JSONL response log for `doneReason`, `numPredict`, and parse outcome. | Increase `AVE_VISION_NUM_PREDICT` only when logs show a length limit; otherwise keep descriptions concise or use one image per request. |
| Batch request fails | The result's pass report includes a fallback entry. | Leave batch size at one for the 4 GB GPU; single-image fallback is automatic. |
| Python worker will not start | `python --version` may point to an incomplete system install. | The project scripts now prefer `.venv`; set `AVE_PYTHON_PATH` to a working interpreter if using another environment. |
| Video cannot be probed or sampled | `python:check` reports `ffmpeg` / `ffprobe` missing. | Install FFmpeg or set `AVE_FFMPEG_PATH` and `AVE_FFPROBE_PATH` to the executables. |

## Benchmark procedure

### Live measurements on 2026-11-05

The direct Ollama sweep used `qwen3-vl:2b`, Ollama 0.40.14, a 45-minute request `keep_alive`, a warm-up, and four sampled frames from one local video. Each diagnostic inference was capped at 64 output tokens, so successful HTTP responses ended with `done_reason: length` and did not produce usable JSON. These results establish context fit and model placement, not event-analysis quality.

Request durations are end-to-end wall-clock measurements. Switching `num_ctx` can reload the Ollama runner, so those rows are not steady-state latency comparisons. The separate 4096-context quality run warmed at that same context before timing inference.

| `num_ctx` | Images | Request result | `/api/ps` allocation after request |
| ---: | ---: | --- | --- |
| 2048 | 1 | HTTP 200; output reached 64-token limit | 0% CPU / 100% GPU; 1.65 GB model allocation |
| 2048 | 2 | HTTP 400; 2,113 short-prompt tokens and 2,217 production-prompt tokens exceeded context | 0% CPU / 100% GPU |
| 2048 | 4 | HTTP 400; 4,181 short-prompt tokens and 4,309 production-prompt tokens exceeded context | 0% CPU / 100% GPU |
| 4096 | 1 or 2 | HTTP 200; output reached 64-token limit | 0% CPU / 100% GPU; 1.78 GB model allocation |
| 4096 | 4 | HTTP 400; requests used 4,181 or 4,309 tokens | 0% CPU / 100% GPU |
| 8192 | 1, 2, or 4 | HTTP 200; output reached 64-token limit | 20.2% CPU / 79.8% GPU; 2.39 GB total, 1.91 GB in VRAM |

The default 20% CPU-offload gate therefore rejects the measured 8192 allocation. A 4096 context fits up to two images for these prompts while remaining fully in VRAM; four-image requests exceed its context. Keep event batching at one image on this machine unless another live run supports a higher batch size. The model's pre-existing 5120-context `/api/ps` snapshot was fully in VRAM, but the benchmark did not run the prompt matrix at 5120.

The production gate was also exercised against live Ollama at 8192: after warm-up, `/api/ps` reported 20.2% CPU and the run stopped with `VISION_GPU_OFFLOAD_LIMIT` before the first inference request. The video probe, scene detector and frame sampler were stubbed for this check because FFmpeg/FFprobe are absent; the Ollama warm-up, allocation query and threshold enforcement were live. Its per-run log is `data/analysis-cache/vision-requests/live-gpu-gate-check.jsonl`.

A follow-up single-image request at 4096 with the normal 768-token output budget returned valid JSON (`{"candidates":[]}`) in 3.6 seconds after warm-up, generated 113 tokens, and remained at 0% CPU / 100% GPU. This confirms the prompt can complete within budget; it does not validate event recall because the tested image produced no candidate. The response is in `data/analysis-cache/results/vision-benchmark-json-quality-2026-11-05.json`.

The benchmark process had no `OLLAMA_*` variables set. Its supplied Ollama startup log lists Flash Attention, `q8_0` KV cache, one parallel request, one loaded model and a five-minute server keep-alive, but that log reports Ollama 0.35.0 while the live service reports 0.40.14. Treat those logged settings as historical; the current daemon environment is unverified. The 45-minute `keep_alive` above was sent with each benchmark request and does not establish the server's startup environment.

Artifacts: `data/analysis-cache/results/vision-benchmark-live-full-2026-11-05.json` contains the exact-timestamp 2048/4096/8192 context and 1/2/4-image sweeps; `data/analysis-cache/results/vision-benchmark-json-quality-2026-11-05.json` contains the 768-token single-image quality check.

Run the stdlib-only benchmark with four representative sampled frames. It warms the model, keeps it loaded, tests one-image production prompts at contexts 2048/4096/8192, then tests 1/2/4-image short and production prompts at the requested image-sweep contexts. It reads exact timestamps from `frame-<index>-<milliseconds>.jpg` names or accepts them through `--timestamps`. It records `/api/ps` after each request and captures the benchmark process environment. If an Ollama startup log is supplied, it also records its tracked server variables and marks whether its server version matches the live API.

```powershell
npm run python:check
.\.venv\Scripts\python.exe python/vision_bench.py `
  --frames <frame-1.jpg> <frame-2.jpg> <frame-3.jpg> <frame-4.jpg> `
  --timestamps <seconds-1> <seconds-2> <seconds-3> <seconds-4> `
  --contexts 2048 4096 8192 `
  --image-sweep-contexts 2048 4096 8192 `
  --warmup-context 2048 `
  --keep-alive 45m `
  --server-log data/analysis-cache/results/ollama-serve.log `
  --output data/analysis-cache/results/vision-benchmark-live.json
```

Use `--num-predict 64 --short-num-predict 64` for a quick allocation and truncation diagnostic. Raise those budgets for a quality-focused run; expect it to take longer. `vision_bench.py` records severe offload so the context sweep can complete; actual event analysis enforces the 20% stop limit. The direct Ollama benchmark does not require FFmpeg, but running `analyze_events` against a video does require FFmpeg and FFprobe for sampling.

### Next test against a real video

1. Install FFmpeg and FFprobe, then run `npm run python:check` and confirm both paths are found.
2. Set Ollama server variables in the Ollama process environment, restart that server, and capture a fresh startup log. Confirm its version matches `GET /api/version`; the existing 0.35.0 log is stale for the live 0.40.14 service.
3. Set `AVE_VISION_API_STYLE=ollama`, `AVE_VISION_BASE_URL=http://127.0.0.1:11434`, `AVE_VISION_MODEL=qwen3-vl:2b`, `AVE_VISION_EVENT_NUM_CTX=4096`, `AVE_VISION_BATCH_SIZE=1`, `AVE_VISION_MAX_CPU_OFFLOAD_PERCENT=20`, and `AVE_VISION_KEEP_ALIVE=45m` in the worker environment.
4. Call MCP tool `resolve_analyze_media` with `operation: "analyze_events"`, a representative video path, `pass1MaxFrames: 4`, `maxEvents: 1`, `maxRequests: 4`, and `visionBatchSize: 1`.
5. Confirm the result contains a job id, request-log path, measured `/api/ps` allocation, pass statuses and evidence timestamps. Check the JSONL log if any request was truncated or recovered; use a separate benchmark run before increasing context or batch size.
