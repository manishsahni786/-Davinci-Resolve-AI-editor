# AI Video Editor

An AI-assisted video editing system for **DaVinci Resolve 21.1 Free** on Windows, designed to be driven from **OpenCode** through a local MCP server.

This repository currently has verified Milestone 5 capabilities: project/media management, whole-clip timeline editing, and rough-cut assembly in Resolve Free `21.1.0.17`. Per the current workflow requirement, the Bridge script must now be launched manually for every request. The previously verified Windows UI Automation trigger remains optional but is disabled by default.

## The important constraint

DaVinci Resolve **Free** does not allow external scripting. This was verified on this machine:

- TCP port `1144` (Resolve's external scripting listener) is closed.
- `ResolvePython` `scriptapp("Resolve")` returns `None`.
- `fuscript` `Resolve()` returns `nil` while Resolve is running.

Therefore Node cannot call Resolve directly. The bridge works like this:

```
OpenCode
    -> Node.js / TypeScript MCP server
    -> atomic JSON + Lua request files
    -> user launches Workspace > Scripts > Utility > AI Video Editor Bridge for each request
    -> Resolve Lua script executes one request
    -> Resolve API
    -> hex-encoded JSON in Fusion preferences
    -> Node.js
```

Resolve has no supported background scripting callback, and a polling loop would freeze the UI. The user launches the menu item for each request. An optional `resolve-scripts/invoke-bridge.ps1` Windows UI Automation shim remains available, but it is disabled by default. Node reports timeouts and keeps the request queued rather than pretending the command succeeded.

Resolve Free also sandboxes internal Lua: `io` is unavailable, so the Lua side cannot write response files. It publishes the response through `fusion:SetPrefs` / `fusion:SavePrefs`; Node reads the Fusion preferences file and persists a local response copy for history.

## Quick start (PowerShell)

```powershell
# From the project root
npm install
npm run build
npm run resolve:install-scripts
npm run status
npm run resolve:test
```

`npm run build` creates `dist\mcp-server.js`, which `opencode.json` launches. Restart OpenCode after installing or updating the MCP server.

With Resolve running and a project open, run `resolve:test`, then launch **Workspace > Scripts > Utility > AI Video Editor Bridge** in Resolve. The test prints success only after Resolve returns a response with `resolveConnected: true`.

If the request times out, it stays queued and can be read later:

```powershell
npm run resolve:read -- <request-id>
npm run resolve:clear
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run status` | Environment, bridge, and capability status |
| `npm run diagnostics` | Full environment snapshot and capability matrix |
| `npm run capabilities` | Machine-readable capability classifications |
| `npm run resolve:test` | Queue `diagnostics.ping`, prompt for a manual Bridge launch and wait for the response |
| `npm run resolve:queue -- <command>` | Queue a command without waiting |
| `npm run resolve:read -- <id>` | Read a response by request id, with a short prefs-flush retry |
| `npm run resolve:project` | Inspect the current project and project list |
| `npm run resolve:media` | Inspect media-pool bins and clips |
| `npm run resolve:timeline` | Inspect the current or indexed timeline, tracks, items and markers |
| `npm run resolve:timeline-create -- "<name>" [--media-ids=<id,id>]` | Create a timeline, optionally from media pool clip ids |
| `npm run resolve:timeline-append -- <mediaId> [<mediaId>...]` | Append media pool clips to the current timeline |
| `npm run resolve:timeline-delete -- <trackType> <trackIndex> <itemIndex>...` | Delete timeline items by track coordinates |
| `npm run resolve:timeline-set-property -- <trackType> <trackIndex> <itemIndex> --key=<key> [--value=<value>]` | Set a property on a timeline item |
| `npm run reel -- [--project=<name>] [--media=<path,...>] [--topic=<text>] [--platform=instagram|youtube] [--clip-ids=<id,...>] [--timeline=<name>] [--bin=<bin/path>] [--max-clips=<n>] [--no-save]` | Assemble a rough-cut reel from whole clips |
| `npm run resolve:render` | Inspect render formats, codecs, presets and current settings |
| `npm run resolve:project-create -- "<name>" [--media-path=<path>]` | Create and open a new project |
| `npm run resolve:project-open -- "<name>" [--save-current]` | Open an existing project |
| `npm run resolve:project-save` | Save the current project |
| `npm run resolve:bin-create -- "<name>" [--parent=<bin/path>]` | Create a media pool bin |
| `npm run resolve:media-import -- <path> [<path>...] [--bin=<bin/path>]` | Import media into a bin |
| `npm run resolve:error` | Read the last bridge error and stage from Fusion prefs |
| `npm run resolve:diagnostics` | Read the Diagnostics menu report from Fusion prefs |
| `npm run resolve:clear` | Archive a pending request |
| `npm run resolve:install-scripts` | Install/update the Resolve Lua scripts |
| `npm run resolve:mock` | Run a mock Resolve adapter without Resolve |
| `npm run mcp` | Run the MCP server over stdio for development |
| `npm run lua:test` | Run the Lua JSON/protocol tests with `fuscript` |
| `npm run python:check` | Inspect the Python media-analysis environment |
| `npm run python:test` | Run Python worker protocol tests |
| `npm test` | Run TypeScript unit tests |
| `npm run typecheck` | TypeScript strict type check |
| `npm run build` | Compile to `dist/` |

## What is implemented

- Environment detection (Node, Python, Git, Resolve process/install, script folders, FFmpeg).
- Resolve install/version/API discovery.
- Capability matrix that distinguishes **verified**, **supported but untested**, **restricted in Free**, **unsupported**, and **requires manual interaction**.
- Node.js file bridge with:
  - unique request ids,
  - atomic writes,
  - fixed single-command queue slot,
  - request/response schema validation,
  - timeouts,
  - optional Windows UI Automation trigger (disabled by default); manual Bridge launch is the normal workflow,
  - no automatic resend of mutating commands; late responses can be read by id,
  - structured JSONL logs,
  - pending-request recovery/clearing.
- Lua scripts:
  - `diagnostics.lua` (writes a full diagnostic JSON report),
  - `bridge.lua` (processes one queued request),
  - dependency-free JSON encoder/decoder with explicit empty-array encoding,
  - read-only Resolve context inspection.
- Read-only bridge commands, all verified live in Resolve Free `21.1.0.17`:
  - `project.inspect`,
  - `media.inspect`,
  - `timeline.inspect`,
  - `render.inspect`.
- Milestone 4 management commands, all verified live in Resolve Free `21.1.0.17`:
  - `project.create` (5169f38b), `project.open` with `saveCurrent` (db857303), `project.save` (b4870b9a),
  - `media.createBin` (1b52b4e0 root; 76224ddb nested `Footage/Angle A`),
  - `media.import` (c3c21b33: 1 clip imported with metadata, folder selection restored).
- Milestone 5 timeline editing commands, all verified live (whole-clip create/append/delete/set-property):
  - `timeline.create` (empty or from media pool clip ids; live `AIVE Milestone 5 Reel`),
  - `timeline.appendClips` (1 item appended live),
  - `timeline.deleteClips` (1 item removed live),
  - `timeline.setItemProperty` (Clip Color = Blue live, `applied: true`; requires a current timeline open).
- Optional auto-trigger was verified live previously; it is disabled by default so each Resolve request is manually launched.
- High-level reel workflow (`npm run reel` / MCP `resolve_make_reel`): inspect or reuse a project, optionally import media, select whole clips by topic tokens or clip ids, create a timeline, append clips, and save. It warns about target aspect ratios but does not trim, add transitions, mix audio or render yet.
- Structured editing-plan lifecycle: validated source intervals, timeline positions, evidence, confidence, output requests and treatments; drafts persist under `data/plans/`, revisions clear approval, and approval is recorded before the agent edits.
- 21.1 finding: `MediaPool.ImportMedia([{clipInfo}])` returns `nil` in the internal Lua context; the fallback chain uses the deprecated `ImportMedia([paths])` form, which succeeds. The successful method is reported in the response.
- Project-name, bin-name, bin-path and timeline-edit validation on both the Node (Zod) and Lua sides, including Windows-reserved characters.
- Transport hardening:
  - processed-request idempotency with response replay,
  - early error and stage publication through Fusion prefs,
  - stale response recovery and request archiving,
  - short prefs-flush retry when reading a late response,
  - optional Resolve APIs omitted without being reported as errors.
- Local MCP server over stdio, registered in `opencode.json`:
  - `resolve_status`,
  - `resolve_capabilities`,
  - `resolve_inspect_project`, `resolve_inspect_media`, `resolve_inspect_timeline`, `resolve_inspect_render`,
  - `resolve_create_project`, `resolve_open_project`, `resolve_save_project`, `resolve_create_bin`, `resolve_import_media`,
  - `resolve_create_timeline`, `resolve_append_clips`, `resolve_delete_clips`, `resolve_set_item_property`,
  - `resolve_make_reel`,
  - `resolve_read_response`, `resolve_clear_pending`, `resolve_last_error`,
  - plan lifecycle tools (`resolve_create_editing_plan`, `resolve_create_plan_from_analysis`, `resolve_get_editing_plan`, `resolve_revise_editing_plan`, `resolve_approve_editing_plan`, `resolve_reject_editing_plan`, `resolve_execute_editing_plan`, `resolve_mark_editing_plan_executed`).
- MCP tools queue and return a request id by default. Launch the Bridge in Resolve, then call `resolve_read_response` with that id.
- Mock Resolve adapter implementing the full bridge command set with in-memory project/bin/clip/timeline state.
- Python worker (`ping`, `env_info`, `shutdown` plus media analysis commands) with JSON-lines IPC and tests.
- Two-pass event analysis (`analyze_events`): broad pass-1 scan, adaptive pass-2 re-sampling, evidence timestamps validated against sampled frames, explicit boundary uncertainty, bounded request budgets and automatic single-image fallback when a multi-image vision batch fails.
- Analysis-driven plan drafting (`resolve_create_plan_from_analysis`): converts an `analyze_events` result (events, evidence, categories, confidence, boundary uncertainty) into a validated editing-plan draft stored under `data/plans/`. It keeps model-reported in/out points, records unknown confidence as 0 with a reason note, drops malformed or out-of-range events with a warning, and carries an explicit whole-clips-only execution warning.
- Installer that writes menu launchers directly under `Utility`, stores the implementation in a subfolder, backs up existing bridge scripts outside the Resolve scan path, and preserves `resolve_test.lua`.
- TypeScript (108 passed, 1 live Resolve integration skipped), Lua (68) and Python (49) tests.

## What is not implemented yet

- Trimmed in/out timeline append (`startFrame`/`endFrame` clipInfo), transitions and audio mixing for polished highlight reels.
- Project aspect-ratio enforcement (Instagram 9:16, YouTube 16:9); the reel workflow currently warns only.
- Rendering (Milestone 6).
- End-to-end video analysis is not live-verified in this environment: the local Ollama model is reachable and vision requests can be benchmarked, but FFmpeg/FFprobe are not available to probe and sample source video here. Faster-whisper and its local model weights are also user-managed.
- Execution of timestamped segments and fully analysis-driven editing workflows (Milestones 7-9). Analysis observations, including two-pass event boundaries, are not yet converted automatically into trimmed Resolve clip intervals.

No editing tool claims to be live-verified before it has been exercised inside Resolve Free.

## Optional media analysis

`resolve_analyze_media` is read-only and runs the Python worker locally. The runner prefers `.venv` when present; set `AVE_PYTHON_PATH` to select another Python environment. Install FFmpeg/FFprobe for video probing and frame extraction. For local Ollama, set `AVE_VISION_API_STYLE=ollama`, `AVE_VISION_BASE_URL=http://127.0.0.1:11434`, and `AVE_VISION_MODEL` to a locally pulled vision model. OpenAI-compatible endpoints use the default `openai-compatible` style and a `/v1` base URL. Whisper uses an existing local model directory configured with `AVE_WHISPER_MODEL_PATH`; it does not download model weights. Remote vision endpoints require `AVE_VISION_ALLOW_REMOTE=true` and may transmit sampled frames off-device. See [Local vision analysis](docs/VISION_ANALYSIS.md) for GPU placement, JSON recovery, request logs, timeouts, troubleshooting and live benchmark steps.

Use `operation: "analyze_events"` for two-pass event detection. Pass 1 samples representative frames across the whole file and ranks candidate events; pass 2 re-samples densely around each candidate and reports explicit boundary uncertainty. Tune it with `pass1MaxFrames`, `pass2FramesPerEvent`, `maxEvents`, `maxRequests` and `visionBatchSize`. Event analysis defaults to one frame per vision request; setting `visionBatchSize` above 1 opts into multi-image requests and automatically falls back to single-image requests if a batch fails. `AVE_VISION_EVENT_NUM_CTX` (default 5120), `AVE_VISION_BATCH_SIZE`, `AVE_VISION_MAX_REQUESTS`, and `AVE_VISION_MAX_CPU_OFFLOAD_PERCENT` set the defaults. The worker stops when measured CPU offload exceeds the configured threshold. Event boundaries are model-reported evidence, not verified edit points. Successful results are cached under `data/analysis-cache/results/` (TTL 7 days, `AVE_ANALYSIS_TTL_MS` to override); per-request model response logs are stored by job id under `data/analysis-cache/vision-requests/`.

## Project structure

```
src/
  mcp/          MCP tool registration
  mcp-server.ts MCP stdio entry point
  bridge/       file bridge, protocol, serial command manager
  config/       settings and Windows environment detection
  resolve/      Resolve client, capability matrix, mock adapter, reel workflow
  planning/     editing-plan schema, validation, revision/approval state and store
  types/        bridge and Resolve types
  utils/        errors, logging, atomic file helpers, validation
  index.ts      CLI entry point
resolve-scripts/
  bridge.lua            single-request processor
  invoke-bridge.ps1     UI Automation menu trigger (Windows)
  diagnostics.lua       runtime diagnostic report
  install.ps1           installer/backup helper
  test.ps1              Lua test runner (locates fuscript.exe)
  tests/                Lua JSON/protocol tests
  lib/                  JSON, paths, Resolve context
python/
  worker.py             independent JSON-lines media worker and analysis dispatcher
  media_analysis.py     media probing, frame sampling, vision and event orchestration
  vision_bench.py       local Ollama GPU/context and prompt benchmark
  check_environment.py  Python/FFmpeg/package report
  tests/
tests/                  TypeScript unit and integration tests
docs/                   environment report, Resolve setup, architecture
data/                   bridge request/response/archive data
logs/                   structured logs
backups/                installer backups (gitignored)
config/                 settings example
```

## Documentation

- [Environment diagnostics](docs/ENVIRONMENT_DIAGNOSTICS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Resolve setup and bridge usage](docs/RESOLVE_SETUP.md)
- [MCP setup and tools](docs/MCP_SETUP.md)

## Safety rules

- Source media is never modified or deleted.
- Commands are not executed from natural language without capability validation and confirmation.
- Arbitrary shell commands are never generated from user instructions.
- The Lua scripts and MCP tools implement diagnostics, inspection, project/media management, and whole-clip timeline editing.
- A missing or failed Resolve response is reported as a timeout/failure, never as success.

## Milestone 4 verification (completed 2026-11-02)

All five management commands were verified live inside Resolve Free 21.1.0.17 with the bridge menu trigger. During verification, one Lua bug was found and fixed (`recordCall` calls in `importMedia` were missing the session argument) and the ImportMedia calling-convention fallback was added. Request ids recorded above and in `data/responses/` are the live evidence. The capability matrix entries `resolve.project-management` and `resolve.media-management` are now `verified`.

## Milestone 5 verification (completed 2026-11-03)

Timeline editing is wired through protocol validation, the Lua bridge, mock adapter, CLI and MCP tools. Live Resolve Free 21.1.0.17 evidence: `timeline.create` (`AIVE Milestone 5 Live Test`), `timeline.appendClips` (3 items), `timeline.setItemProperty` (Clip Color = Blue, `applied: true`) and `timeline.deleteClips` (1 item removed). During verification, `timeline.setItemProperty` was fixed to use `TimelineItem.SetClipColor` / `SetName` / `SetProperties`; `SetProperty` does not exist. The capability matrix entry `resolve.timeline-editing` is `verified`.

The optional `resolve-scripts/invoke-bridge.ps1` trigger was verified live previously. It remains disabled by default; each request now requires a manual Bridge launch. The `bridge.auto-trigger` capability records the optional implementation, not the default workflow.

Milestone 5 still uses whole clips only. Trimming, transitions, audio mixing and polished highlight-reel pacing remain future work.
