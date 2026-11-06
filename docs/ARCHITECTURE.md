# Architecture

## 1. Constraints that drive the design

1. **DaVinci Resolve Free 21.1 does not allow external scripting on this machine.**
   - Port 1144 is closed.
   - External Python (`ResolvePython` + `DaVinciResolveScript`) gets `None`.
   - External Lua (`fuscript`) gets `nil` from `Resolve()`.
2. Internal menu scripts are documented to receive `bmd`, `resolve`, and `fusion` as globals.
3. Resolve runs menu scripts synchronously on the UI thread. There is no supported background callback or timer for scripting.
4. The free version does not guarantee Studio-only APIs. Every capability must be checked at runtime and classified honestly.
5. Source media must never be modified or deleted.
6. Natural-language text must never become shell commands or executable Lua.

These constraints produce a hybrid Node.js + TypeScript + Lua + Python architecture with a **serial file-based command bridge that the user launches from Resolve's Workspace > Scripts menu for every request**. Optional Windows UI Automation remains disabled by default.

## 2. Components

```
OpenCode
   |
   | MCP (later milestone)
   v
Node.js + TypeScript
   |- MCP server
   |- tool input validation
   |- editing-plan orchestration
   |- capability checks
   |- file bridge client
   |- request/response logs
   |- UI Automation trigger (invoke-bridge.ps1)
   |
   | atomic JSON files
   v
Lua inside Resolve (one request per menu invocation)
   |- request validation
   |- project / media pool / timeline / render operations
   |- structured JSON responses
   |
   v
DaVinci Resolve 21.1 Free

Python worker (independent process)
   |- FFmpeg / FFprobe
   |- OpenCV
   |- PySceneDetect
   |- faster-whisper
   |- thumbnails / metadata / highlights
   |
   | JSON lines over stdin/stdout
   v
Node.js media tools (later milestone)
```

### Node.js + TypeScript

Responsibilities:

- MCP server and OpenCode integration (Milestones 3-4).
- Tool input validation with Zod.
- Editing-command orchestration and serialization.
- Capability checks before commands are queued.
- File bridge client with ids, timeouts, retries, atomic writes and structured logs.
- Automatic bridge trigger through Windows UI Automation, with throttling and a manual fallback.
- Timeline operation planning and confirmation.
- High-level reel assembly (`src/resolve/editing-workflow.ts`): project/bin/import/media/timeline orchestration with per-step results.
- Calling the Python worker through JSON lines (Milestone 7).

Current implementation:

- `src/bridge/file-bridge.ts`
- `src/bridge/resolve-trigger.ts`
- `src/bridge/message-protocol.ts`
- `src/bridge/bridge-manager.ts`
- `src/config/environment.ts`
- `src/config/settings.ts`
- `src/resolve/resolve-capabilities.ts`
- `src/resolve/resolve-client.ts`
- `src/resolve/editing-workflow.ts`
- `src/resolve/mock-resolve-adapter.ts`
- `src/mcp/server.ts` MCP tool registration
- `src/mcp-server.ts` MCP stdio entry point
- `src/index.ts` CLI

The mock adapter implements the full current command set (inspection, management and timeline editing) with in-memory project/bin/clip/timeline state, so unit tests never require Resolve.

### Lua inside Resolve

Responsibilities:

- Project management.
- Media pool operations.
- Timeline inspection and clip manipulation.
- Rendering where supported.
- Returning structured JSON, never free-form prose that Node must guess from.

Current implementation:

- `resolve-scripts/bridge.lua` â€” one-request processor.
- `resolve-scripts/invoke-bridge.ps1` â€” Windows UI Automation menu trigger.
- `resolve-scripts/diagnostics.lua` â€” standalone diagnostic report.
- `resolve-scripts/lib/json.lua` â€” dependency-free JSON.
- `resolve-scripts/lib/paths.lua` â€” config, atomic writes, logging.
- `resolve-scripts/lib/resolve-context.lua` — inspection, Milestone 4 management (`project.create`/`open`/`save`, `media.createBin`/`import`) and Milestone 5 timeline editing (`timeline.create`/`appendClips`/`deleteClips`/`setItemProperty`), all dispatched from `bridge.lua`.

The Lua side implements whole-clip timeline editing for Milestone 5. The bridge response channel is in `resolve-scripts/lib/prefs.lua`.

### Python worker

Responsibilities:

- Video/audio metadata.
- FFmpeg frame extraction and thumbnails.
- OpenCV analysis.
- Scene detection.
- Whisper transcription.
- Silence/highlight detection.
- Media summaries.

Current implementation:

- `python/worker.py` â€” JSON-lines protocol skeleton (`ping`, `env_info`, `shutdown`).
- `python/check_environment.py` â€” environment report.
- `python/tests/test_worker.py` â€” protocol tests.

Python never talks to Resolve directly. It receives file paths and returns analysis data to Node. This avoids duplicating Resolve logic and respects the Free-version external-scripting restriction.

## 3. Bridge lifecycle

### Queue

Node creates a request envelope:

```json
{
  "protocolVersion": "1.0",
  "id": "2f0c...",
  "command": "diagnostics.ping",
  "createdAt": "2026-10-30T13:44:29.555Z",
  "source": "node",
  "payload": {}
}
```

It is written atomically to:

```
data/requests/next.request.json
data/requests/next.request.lua
```

`next.request.lua` contains the same envelope as a Lua chunk that returns a JSON string. The internal Resolve sandbox has no `io`, so Lua reads this chunk with `loadfile` instead of reading the JSON file.

Only one request may occupy this slot. A second command gets `BRIDGE_BUSY` instead of risking concurrent timeline edits.

### Trigger

After queueing, `FileBridge.waitForResponse` starts `resolve-scripts/invoke-bridge.ps1` through `src/bridge/resolve-trigger.ts`. The PowerShell script:

1. Finds the running Resolve main window with Windows UI Automation.
2. Opens the `Workspace` menu, then `Scripts`, then invokes `AI Video Editor Bridge`.
3. Exits with a JSON result (`{ "ok": true, ... }` or an error code such as `RESOLVE_NOT_RUNNING`).

This is input automation of Resolve's own menu, not external Resolve scripting. Triggers are throttled (`AVE_AUTO_TRIGGER_INTERVAL_MS`, default 1500 ms) and stop after the first successful invocation. Set `AVE_AUTO_TRIGGER=false` to disable automation and use the manual menu item:

```
Workspace > Scripts > Utility > AI Video Editor Bridge
```

### Process

`bridge.lua`:

1. Loads `bridge_config.lua` and the Lua libraries.
2. Loads `next.request.lua` with `loadfile` (no `io` access).
3. Validates the id, command and protocol version.
4. Dispatches to a whitelisted command.
5. Publishes the response as hex-encoded JSON through `fusion:SetPrefs` + `fusion:SavePrefs`.
6. Node persists the response locally and archives the request.

The response preferences are:

```
Global.AIVideoEditorBridgeResponseId    -> hex(request id)
Global.AIVideoEditorBridgeResponseHex   -> hex(response JSON)
Global.AIVideoEditorBridgeProcessedId   -> comma-separated recent request ids (max 20)
Global.AIVEBridgeStage                  -> request-loaded | response-published | no-request | error
Global.AIVEBridgeError                  -> last early transport error
Global.AIVEBridgeErrorAt                -> last early error timestamp
```

Request ids are retained for idempotent replay. If the same id is triggered again, the bridge republishes the cached response instead of re-running the command. If the id is known but no cached response remains, it returns `REQUEST_ALREADY_PROCESSED`.

Resolve Free's internal Lua sandbox has `io = nil`; it cannot write files. The Lua side therefore never writes responses directly.

### Read

Node polls for the response at `pollIntervalMs`, first checking the local response folder and then the Fusion preferences file. It validates the response against the Zod schema, checks that the id and command match, persists a local copy, logs it, and returns it. On timeout, it throws `BRIDGE_TIMEOUT` and leaves the request queued. `resolve:read` retries briefly so a response published during the read is not missed while Fusion flushes its preferences file.

Late responses can be read with:

```powershell
npm run resolve:read -- <id>
```

## 4. Response envelope

```json
{
  "protocolVersion": "1.0",
  "id": "2f0c...",
  "command": "diagnostics.ping",
  "ok": true,
  "status": "success",
  "startedAt": "2026-10-30T13:44:59Z",
  "completedAt": "2026-10-30T13:45:00Z",
  "durationMs": 1000,
  "source": "resolve",
  "result": {},
  "error": null,
  "meta": {
    "resolveVersion": "21.1.0.17",
    "isStudio": false,
    "projectName": "Dying_Light_8",
    "timelineName": "Timeline 1",
    "scriptContext": "predefined global 'resolve'"
  }
}
```

Statuses:

- `success` â€” Resolve confirmed the operation.
- `error` â€” the script ran, but the operation failed or the Resolve object was unavailable.
- `unsupported` â€” the command is not implemented or is restricted.

`ok` is true only for `success`. The Node client never converts a timeout or an `error` into success.

## 5. Error model

| Code | Meaning | Manual action |
| --- | --- | --- |
| `BRIDGE_TIMEOUT` | No response before the deadline; request still queued | Launch the Lua bridge manually, then read the response by request id |
| `BRIDGE_BUSY` | Another request is pending | Process or clear it |
| `BRIDGE_PROTOCOL_ERROR` | Malformed/mismatched JSON | Inspect logs |
| `REQUEST_ALREADY_PROCESSED` | Request id was processed, but no replayable response remains | Issue a new request |
| `UNSUPPORTED_COMMAND` | Command is not in the bridge whitelist | Use a supported command |
| `RESOLVE_UNAVAILABLE` | Lua could not obtain the Resolve object | Inspect diagnostics |
| `TIMELINE_UNAVAILABLE` | No current timeline is open or the requested index does not exist | Open or create a timeline |
| `VALIDATION_ERROR` | Bad tool input or path | Correct input |
| `UNSUPPORTED_FEATURE` | Capability is not available | Use an alternative |
| `INTERNAL_ERROR` | Unexpected failure | Inspect logs |

## 6. Capability checks

`src/resolve/resolve-capabilities.ts` is the single source of truth for what is known. Each entry records:

- status: `verified`, `supported-untested`, `restricted-free`, `unsupported`, `requires-manual-interaction`;
- whether it is implemented;
- milestone;
- evidence;
- notes.

Before a future editing command is queued, the orchestrator must:

1. Resolve the requested capability.
2. Refuse if `restricted-free` or `unsupported`.
3. Warn and require confirmation if `supported-untested`.
4. Record the actual runtime result.

The Lua side will also perform runtime checks (for example, querying `GetRenderFormats`/`GetRenderCodecs`) instead of trusting a hard-coded list.

## 7. Safety boundaries

- No source-media writes or deletes.
- No arbitrary shell execution from natural language.
- No `loadstring`, `dofile`, or `eval` of request payloads.
- Lua only parses JSON data.
- Request ids are restricted to `[A-Za-z0-9._-]` to prevent path traversal.
- Responses are schema-validated before use.
- Destructive commands will require explicit confirmation in the later planner.
- Project/timeline backups will be created before destructive edits where the API allows it.

## 8. Why not the alternatives?

| Alternative | Why rejected |
| --- | --- |
| Direct Node â†’ Resolve API | External scripting returns `None` on this Free install |
| TCP bridge into Resolve | No listener on port 1144 |
| Headless `Resolve -nogui` | Depends on external scripting |
| Lua background polling loop | Blocks the Resolve UI; no supported idle callback |
| Python talking to Resolve | Same external-scripting restriction |
| Porting all media analysis to Node | Duplicates FFmpeg/OpenCV/Whisper ecosystems and bloats the MCP process |
| Porting all editing logic to Python | Python cannot reach Resolve Free externally |

## 9. Milestone plan

| Milestone | Scope | Status |
| --- | --- | --- |
| 1 | Diagnostics, Resolve connection, Fusion prefs bridge | Verified live (`resolveConnected: true`) |
| 2 | Lua bridge command expansion and transport hardening | Verified live (project, media, timeline and render inspection) |
| 3 | MCP server and basic Resolve tools | Verified over stdio (9 read-only tools) |
| 4 | Project and media management | Verified live (project create/open/save, bins, media import) |
| 5 | Timeline creation and editing (whole-clip) | Verified live (create/append/delete/set-property; reel rough cut); manual launch is now required per request |
| 6 | Rendering and export | Not started |
| 7 | Python media analysis | Read-only worker and MCP tool implemented, including two-pass `analyze_events` with evidence-backed boundaries; optional dependencies/models are not bundled and end-to-end analysis is not live-verified |
| 8 | Structured editing plan, revision and approval lifecycle | Validation, local state and analysis-driven draft generation are implemented; execution is approval-gated and still whole-clips-only |
| 9 | Polished Instagram Reel workflow (trim, transitions, audio) | Rough-cut assembly live; polishing not started |
| 10 | Full test suite, docs, integration | Not started |

## 10. MCP mapping

The MCP server (`dist/mcp-server.js`) exposes twenty-eight tools, including `resolve_analyze_media` for read-only media probing, scene cuts, silence, transcription, frame sampling, optional vision analysis, and two-pass `analyze_events` with explicit boundary uncertainty. `resolve_create_plan_from_analysis` converts analysis events into editing-plan draft clips (one clip per event, evidence preserved as frame items, unknown confidence recorded as 0 with a reason note, boundary uncertainty surfaced in clip reasons and plan warnings). Seven remaining editing-plan tools persist and validate proposal state locally. Execution requires approval and currently supports contiguous whole clips on a new timeline only. By default Resolve tools queue and return a request id; the user launches the Bridge in Resolve, then reads the response by id.

For each tool:

- input schema is validated in Node with Zod;
- the command payload is re-validated against the protocol schema before queueing;
- capability status is checked;
- destructive actions require confirmation;
- the tool returns the structured request/response result;
- timeouts keep the request queued and report its id so the user can launch the Lua bridge manually and read the late response.

No MCP tool will claim a Free-restricted operation succeeded. If an operation is impossible, the tool returns an `unsupported` result with the limitation and an alternative.
