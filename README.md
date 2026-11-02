# AI Video Editor

An AI-assisted video editing system for **DaVinci Resolve 21.1 Free** on Windows, designed to be driven from **OpenCode** through a local MCP server.

This repository is currently at **Milestone 3**, verified live: environment diagnostics, a working manual Resolve bridge using file requests and Fusion-preference responses, read-only project, media-pool, timeline and render inspection, and a local MCP server exposing those tools to OpenCode. Editing and media analysis arrive in later milestones.

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

## What is implemented in Milestones 1-3

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
  - `resolve_read_response`, `resolve_clear_pending`, `resolve_last_error`.
- MCP inspection tools queue by default and return a request id; `wait: true` blocks until the manual Resolve trigger. No editing tools are exposed.
- Mock Resolve adapter so tests do not need Resolve open.
- Python worker skeleton (`ping`, `env_info`, `shutdown`) with JSON-lines IPC and tests.
- Installer that writes menu launchers directly under `Utility`, stores the implementation in a subfolder, backs up existing bridge scripts outside the Resolve scan path, and preserves `resolve_test.lua`.
- TypeScript (35), Lua (38) and Python (5) test suites.

## What is not implemented yet

- Project/media/timeline editing commands (Milestones 4-5).
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
- The Lua scripts and MCP tools only implement read-only diagnostics and inspection in these milestones.
- A missing or failed Resolve response is reported as a timeout/failure, never as success.
