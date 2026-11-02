# AI Video Editor

An AI-assisted video editing system for **DaVinci Resolve 21.1 Free** on Windows, designed to be driven from **OpenCode** through a local MCP server.

This repository is at **Milestone 4, verified live**: Milestones 1-3 (environment diagnostics, the manual file/Fusion-preferences Resolve bridge, read-only project, media-pool, timeline and render inspection, and a local MCP server) plus Milestone 4 (project management: create/open/save; media management: bins and import) are all verified live in Resolve Free `21.1.0.17`. The mock Resolve adapter covers the full command set for offline tests.

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
    -> manually triggered Resolve Lua script
    -> Resolve API
    -> hex-encoded JSON in Fusion preferences
    -> Node.js
```

The Lua processor is deliberately **manual**: `Workspace > Scripts > Utility > AI Video Editor Bridge`. Resolve has no supported background scripting callback, and a polling loop would freeze the UI. Node waits with a timeout instead of pretending the command succeeded.

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

When `resolve:test` prints the action prompt, switch to Resolve and run:

**Workspace > Scripts > Utility > AI Video Editor Bridge**

The test prints a real success only when Resolve returns a response with `resolveConnected: true`.

If the request times out, it stays queued:

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
| `npm run resolve:test` | Queue `diagnostics.ping` and wait for the manual Lua trigger |
| `npm run resolve:queue -- <command>` | Queue a command without waiting |
| `npm run resolve:read -- <id>` | Read a response by request id, with a short prefs-flush retry |
| `npm run resolve:project` | Inspect the current project and project list |
| `npm run resolve:media` | Inspect media-pool bins and clips |
| `npm run resolve:timeline` | Inspect the current or indexed timeline, tracks, items and markers |
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

## What is implemented in Milestones 1-4

- Environment detection (Node, Python, Git, Resolve process/install, script folders, FFmpeg).
- Resolve install/version/API discovery.
- Capability matrix that distinguishes **verified**, **supported but untested**, **restricted in Free**, **unsupported**, and **requires manual interaction**.
- Node.js file bridge with:
  - unique request ids,
  - atomic writes,
  - fixed single-command queue slot,
  - request/response schema validation,
  - timeouts,
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
- 21.1 finding: `MediaPool.ImportMedia([{clipInfo}])` returns `nil` in the internal Lua context; the fallback chain uses the deprecated `ImportMedia([paths])` form, which succeeds. The successful method is reported in the response.
- Project-name, bin-name and bin-path validation on both the Node (Zod) and Lua sides, including Windows-reserved characters.
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
  - `resolve_read_response`, `resolve_clear_pending`, `resolve_last_error`.
- MCP inspection and management tools queue by default and return a request id; `wait: true` blocks until the manual Resolve trigger.
- Mock Resolve adapter implementing the full bridge command set with in-memory project/bin/clip state.
- Python worker skeleton (`ping`, `env_info`, `shutdown`) with JSON-lines IPC and tests.
- Installer that writes menu launchers directly under `Utility`, stores the implementation in a subfolder, backs up existing bridge scripts outside the Resolve scan path, and preserves `resolve_test.lua`.
- TypeScript (50), Lua (38) and Python (5) test suites.

## What is not implemented yet

- Timeline editing commands (Milestone 5).
- Rendering (Milestone 6).
- FFmpeg/OpenCV/Whisper/PySceneDetect media analysis (Milestone 7).
- Natural-language planner and Reels workflow (Milestones 8-9).

No editing tool claims to work before it has been verified inside Resolve Free.

## Project structure

```
src/
  mcp/          MCP tool registration
  mcp-server.ts MCP stdio entry point
  bridge/       file bridge, protocol, serial command manager
  config/       settings and Windows environment detection
  resolve/      Resolve client, capability matrix, mock adapter
  types/        bridge and Resolve types
  utils/        errors, logging, atomic file helpers, validation
  index.ts      CLI entry point
resolve-scripts/
  bridge.lua            manual request processor
  diagnostics.lua       runtime diagnostic report
  install.ps1           installer/backup helper
  test.ps1              Lua test runner (locates fuscript.exe)
  tests/                Lua JSON/protocol tests
  lib/                  JSON, paths, Resolve context
python/
  worker.py             independent JSON-lines media worker (skeleton)
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
- The Lua scripts and MCP tools implement read-only diagnostics, inspection, and project/media management only; timeline editing arrives in Milestone 5.
- A missing or failed Resolve response is reported as a timeout/failure, never as success.

## Milestone 4 verification (completed 2026-11-02)

All five management commands were verified live inside Resolve Free 21.1.0.17 with the bridge menu trigger. During verification, one Lua bug was found and fixed (`recordCall` calls in `importMedia` were missing the session argument) and the ImportMedia calling-convention fallback was added. Request ids recorded above and in `data/responses/` are the live evidence. The capability matrix entries `resolve.project-management` and `resolve.media-management` are now `verified`.
