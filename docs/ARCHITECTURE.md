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

These constraints produce a hybrid Node.js + TypeScript + Lua + Python architecture with a **manually triggered, file-based command bridge**.

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
   |
   | atomic JSON files
   v
Lua inside Resolve (manual trigger)
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

- MCP server and OpenCode integration (Milestone 3).
- Tool input validation with Zod.
- Editing-command orchestration and serialization.
- Capability checks before commands are queued.
- File bridge client with ids, timeouts, retries, atomic writes and structured logs.
- Timeline operation planning and confirmation.
- Calling the Python worker through JSON lines (Milestone 7).

Current implementation:

- `src/bridge/file-bridge.ts`
- `src/bridge/message-protocol.ts`
- `src/bridge/bridge-manager.ts`
- `src/config/environment.ts`
- `src/config/settings.ts`
- `src/resolve/resolve-capabilities.ts`
- `src/resolve/resolve-client.ts`
- `src/resolve/mock-resolve-adapter.ts`
- `src/index.ts` CLI

### Lua inside Resolve

Responsibilities:

- Project management.
- Media pool operations.
- Timeline inspection and clip manipulation.
- Rendering where supported.
- Returning structured JSON, never free-form prose that Node must guess from.

Current implementation:

- `resolve-scripts/bridge.lua` â€” one-request processor.
- `resolve-scripts/diagnostics.lua` â€” standalone diagnostic report.
- `resolve-scripts/lib/json.lua` â€” dependency-free JSON.
- `resolve-scripts/lib/paths.lua` â€” config, atomic writes, logging.
- `resolve-scripts/lib/resolve-context.lua` â€” read-only Resolve inspection and safe calls.

The Lua side deliberately implements **no editing commands** in Milestones 1-2. The bridge response channel is in `resolve-scripts/lib/prefs.lua`.

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

### Process

The user invokes:

```
Workspace > Scripts > Utility > AI Video Editor Bridge
```

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
| `BRIDGE_TIMEOUT` | No response before the deadline; request still queued | Run the Lua bridge |
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
| 3 | MCP server and basic Resolve tools | Not started |
| 4 | Project and media management | Not started |
| 5 | Timeline inspection and editing | Not started |
| 6 | Rendering and export | Not started |
| 7 | Python media analysis | Not started |
| 8 | Natural-language editing planner | Not started |
| 9 | Instagram Reel workflow | Not started |
| 10 | Full test suite, docs, integration | Not started |

## 10. MCP mapping (future)

The future MCP server will expose only capabilities that can be implemented through this bridge. For each tool:

- input schema is validated in Node;
- capability status is checked;
- destructive actions require confirmation;
- the tool returns the structured request/response result;
- timeouts explicitly tell the user to trigger the Lua bridge.

No MCP tool will claim a Free-restricted operation succeeded. If an operation is impossible, the tool returns an `unsupported` result with the limitation and an alternative.
