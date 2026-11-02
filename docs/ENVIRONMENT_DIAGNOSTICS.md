# Environment Diagnostics

Date: 2026-10-30  
Updated: 2026-11-02
Project: AI Video Editor (OpenCode + DaVinci Resolve Free 21.1)
Milestones: 1-3 - environment inspection, bridge, read-only inspection, and MCP server

This report separates measured facts from assumptions. Anything not yet exercised inside Resolve is marked **supported but not yet tested**, not "working".

## 1. Machine

| Item | Value |
| --- | --- |
| OS | Windows 11 Home Single Language |
| Version / build | 10.0.26300 / 26300 |
| Architecture | 64-bit |
| CPU | Intel Core i5-10300H, 4 cores / 8 logical processors |
| RAM | 15.8 GB |
| GPU 1 | Intel UHD Graphics |
| GPU 2 | NVIDIA GeForce GTX 1650 with Max-Q Design, 4 GB |
| Shell | Windows PowerShell 5.1 |

## 2. Development toolchain

| Tool | Result | Notes |
| --- | --- | --- |
| Node.js | v22.22.0 | Meets project requirement (`>=20.11`) |
| npm | 10.9.4 | `npm install` succeeded |
| Git | 2.40.0.windows.1 | Repository present; initial commit `0274cdb` pushed to `main` |
| Python | 3.12.10 at `D:\Softwares\python.exe` | Runs; **pip is not installed** |
| FFmpeg | Not found on PATH | `ffmpeg -version` / `where ffmpeg` fail |
| FFprobe | Not found on PATH | `ffprobe -version` / `where ffprobe` fail |
| OpenCode | 1.19.5 | MCP configuration is a later milestone |

Python package probe:

```
pip              False
numpy            False
cv2              False
scipy            False
PIL              False
scenedetect      False
faster_whisper   False
whisper          False
imageio_ffmpeg   False
torch            False
```

The base Python worker needs only the standard library, so Milestone 1 does not require these packages. They must be installed in a virtual environment before Milestone 7 (media analysis).

## 3. DaVinci Resolve installation

| Item | Value |
| --- | --- |
| Product | DaVinci Resolve |
| Version | 21.1.0.17 |
| Install directory | `D:\Softwares\New Folder` |
| Executable | `D:\Softwares\New Folder\Resolve.exe` |
| Running during inspection | Yes (PID 18420) |
| `fusionscript.dll` | Present |
| `fuscript.exe` | Present |
| `ResolvePython\ResolvePython.exe` | Present |
| Scripting API docs | `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting` |
| README last updated | 31 Aug 2026 (`21.1`) |
| CHANGELOG last updated | 1 Sep 2026 |

The install directory was discovered from the running process path and cross-checked with the Start Menu shortcut. The registry only exposes the version string, not an install path.

### Script folders

| Folder | Path | Status |
| --- | --- | --- |
| User Fusion scripts | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts` | Exists |
| User Utility | `...\Scripts\Utility` | Exists |
| All-users Fusion scripts | `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Fusion\Scripts` | Exists |
| All-users Utility | `...\Scripts\Utility` | Exists |

The pre-existing script is:

```
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\resolve_test.lua
```

It is 1,238 bytes and was preserved unchanged. Two problems were found in it:

1. It calls `Resolve()`, which is the **external** scripting entry point. Internal menu scripts receive a predefined global `resolve` object instead.
2. It writes to `C:\rlb\resolve.log`; `C:\rlb` does not exist, so the script returns before doing any Resolve work.

The new scripts are installed in a separate folder and do not overwrite it:

```
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AI Video Editor\
```

Resolve only scans the Scripts folders at startup. **Restart Resolve after installing the scripts** if the new folder is not visible.

## 4. Internal vs external scripting

### Official documentation

The installed `Developer/Scripting/README.md` says:

- Scripts can run internally from `Workspace > Scripts`, the Console, render callbacks, or composition logic.
- Internal scripts already have `bmd`, `resolve`, and `fusion` defined as globals.
- External scripting is configured in **DaVinci Resolve Studio** under Preferences > System > General.
- External network/headless access depends on that external scripting configuration.

### Measured behaviour on this Free install

| Probe | Result |
| --- | --- |
| TCP listener on port 1144 | **No listener** |
| `ResolvePython.exe` + `import DaVinciResolveScript` | Module imports successfully |
| `DaVinciResolveScript.scriptapp("Resolve")` | `None` |
| `fuscript.exe -l lua` + `Resolve()` | `nil` |
| Same probes while Resolve was running with a project open | Same results |

Conclusion: **external scripting is restricted in this Free installation.** Node, an external Python process, or an external Lua process cannot obtain the Resolve object. This is the central architecture constraint.

### Implication

The system cannot use a direct Node â†’ Resolve API connection, a TCP bridge, or headless `-nogui` control on this installation. The only verified path to the Resolve API is a Lua script launched **inside** Resolve from the Workspace > Scripts menu.

## 5. Chosen bridge design

```
Node.js
  writes data/requests/next.request.json + next.request.lua
  (unique id, atomic rename)
        |
        v
User triggers:
Workspace > Scripts > Utility > AI Video Editor Bridge
        |
        v
bridge.lua
  loads one request with loadfile (io is sandboxed),
  calls the internal resolve global,
  publishes hex JSON via fusion:SetPrefs/SavePrefs
        |
        v
Node.js reads Fusion.prefs, persists data/responses/<id>.response.json,
  validates the envelope, logs, and reports success/failure
```

Design choices:

- **Single queue slot** (`next.request.json` + `next.request.lua`) prevents two timeline-modifying commands from being processed concurrently.
- **Unique request id** inside the envelope provides correlation and auditability.
- **Atomic temp-file + rename** avoids partially written JSON.
- **No background polling loop** because Resolve runs menu Lua synchronously on the UI thread. A loop would freeze the UI. The processor is intentionally a manual action.
- **Timeout is a failure**, not a success. The queued request remains available for a later manual trigger.
- **Fusion prefs response channel** because Resolve Free's internal Lua has `io = nil` and cannot write response files.
- **Response schema validation** rejects malformed or mismatched replies.
- **Logs** are JSONL in `logs/`; Node persists the received response for audit.

### Verified parts of the bridge

Verified by automated tests and by manual menu invocation inside the running Resolve application:

- Request creation, unique ids, JSON serialization, schema validation.
- Atomic request writes and local response persistence.
- Single-pending-request enforcement.
- Timeout behaviour with the request left pending.
- Malformed-response rejection.
- Pending-request clearing/archiving.
- Mock Resolve adapter end-to-end.
- Lua JSON encoder/decoder.
- Fusion prefs response channel (live and unit-tested).
- Internal Resolve object: `resolveConnected: true`, version `21.1.0.17`.
- Internal Lua sandbox: `io = nil`, `bmd.readfile = nil`, `loadfile` available.

### Sandbox findings

| Probe | Result |
| --- | --- |
| `io` | `nil` |
| `ffi`, `package`, `require` | `nil` |
| `loadfile`, `dofile`, `loadstring` | available |
| `bmd.readstring`, `bmd.writestring`, `bmd.fileexists` | available |
| `bmd.readfile`, `bmd.writefile`, `bmd.createdir`, `bmd.readdir` | `nil` |
| `fusion:GetPrefs` / `SetPrefs` / `SavePrefs` | available |
| `resolve:GetVersionString()` | `21.1.0.17` |

`print()` output is muted in the Resolve UI, so the bridge uses Fusion prefs for diagnostics and errors.

## 6. Capability classification

### Supported and verified

| Capability | Evidence |
| --- | --- |
| Workspace > Scripts menu Lua execution | Verified by manual Bridge invocation |
| Internal Resolve object | `resolveConnected: true`, version `21.1.0.17` |
| Node/TypeScript project toolchain | typecheck + 35 unit tests passed |
| File bridge mechanics | Unit tests, prefs test, and mock adapter |
| Fusion prefs response channel | Live Resolve round-trip + unit test |
| Read-only inspection commands | Live `project.inspect`, `media.inspect`, `timeline.inspect` and `render.inspect` all returned `ok: true` |
| MCP stdio server | Real SDK client handshake listed 9 tools; MCP queue, read, wait and clear tests pass |
| Lua JSON and protocol | 38 Lua tests passed |
| Python stdlib worker protocol | 5 Python tests passed |
| Internal script installation without overwriting old scripts | Installer backup + separate folder |

### Supported but not yet tested (inside Resolve Free)

| Capability | Why it is plausible | What must happen |
| --- | --- | --- |
| Project create/open/save/list | `ProjectManager` methods in `DaVinciResolveScript.pyi` | Milestone 4 |
| Media import | `MediaPool.ImportMedia` | Milestone 4 |
| Timeline creation and editing | `CreateEmptyTimeline`, `DeleteClips`, `SetProperties`, `AddTransition` | Milestone 5 |
| MP4/H.264 render queue | `AddRenderJob`, `SetRenderSettings`, `StartRendering` | Milestone 6; query codecs at runtime |
| Resolve-native scene cuts | `Timeline.DetectSceneCuts` | Milestone 7 |
| Resolve-native transcription | `MediaPoolItem.TranscribeAudio` | Milestone 7; Studio/Extras status not assumed |
| FFmpeg thumbnails/metadata | FFmpeg is the standard tool | Install FFmpeg or `imageio-ffmpeg` |
| OpenCV scene analysis | Python 3.12 is installed | Install packages in a venv |
| Whisper transcription | Local model is feasible | Install `faster-whisper` and model weights |

### Restricted in the Free version

| Capability | Evidence |
| --- | --- |
| External scripting (Node/Python/Lua â†’ Resolve) | No port 1144 listener; `scriptapp` / `Resolve()` return nil |
| Headless control (`Resolve -nogui` from Node) | Depends on external scripting |
| AI IntelliSearch / Slate ID / Speech Generator | Official README lists these as Studio and AI APIs that can fail in Free and may require Extras |

### Unsupported

| Capability | Reason |
| --- | --- |
| Continuous background polling inside Resolve | No supported idle/background callback; a blocking loop freezes the UI |
| Direct TCP bridge into Resolve Free | Same external-scripting restriction |

### Requires manual user interaction

| Capability | Reason |
| --- | --- |
| Processing a queued bridge request | Resolve must run the Lua menu script |
| Making new scripts appear in the menu | Restart Resolve after installation |
| Confirming a destructive edit | Required by the planned safety workflow |

## 7. Blockers and risks

1. **Manual trigger latency.** Every Resolve command needs a user action until/unless a supported asynchronous mechanism is found. The MCP server must surface this clearly rather than hanging silently.
2. **Optional API availability differs in Free.** `Project.GetRenderSettings` is absent from the verified internal context; optional methods are guarded and omitted rather than treated as failures.
3. **No pip and no FFmpeg.** Media analysis cannot start until both are addressed.
4. **Free/Studio API differences.** Codec lists, transcription, AI features and some render options must be queried at runtime. No codec or Studio-only method will be hard-coded as available.
5. **Sandbox and prefs limits.** Internal Lua has no `io`, so response delivery depends on Fusion preferences. `fusion:SavePrefs` is a best-effort UI-thread write; Node validates the response and still treats timeouts as failures. Local response persistence and request archiving are handled by Node.

## 8. Exact verification commands

```powershell
# Environment and bridge status
npm run status

# Full machine-readable diagnostics
npm run diagnostics

# TypeScript tests
npm test
npm run typecheck

# Python worker tests
npm run python:test
npm run python:check

# Install/update Lua scripts (backs up the previous install)
npm run resolve:install-scripts

# Queue a real Resolve ping and wait
npm run resolve:test

# Read-only inspection
npm run resolve:project
npm run resolve:media
npm run resolve:timeline
npm run resolve:render

# If it times out, trigger the bridge in Resolve, then read the response
npm run resolve:read -- <request-id>

# If the request must be discarded
npm run resolve:clear
```

## 9. Milestone 1 exit criteria

Milestone 1 is complete when all of the following are true:

- [x] Environment inspected and recorded.
- [x] Resolve install, version and scripting paths identified.
- [x] External scripting restriction measured and documented.
- [x] File bridge implemented with ids, atomic writes, timeouts, validation, logging and recovery.
- [x] Lua bridge and diagnostics scripts implemented.
- [x] Tests and mock adapter pass without Resolve.
- [x] **Manual:** `npm run resolve:test` returns `resolveConnected: true` after the Scripts-menu trigger.

## 10. Milestone 2 exit criteria

- [x] Project, media pool, timeline and render inspection implemented.
- [x] Transport idempotency, early error/stage reporting, and stale response recovery.
- [x] All four inspection commands verified live in Resolve Free `21.1.0.17`.
- [x] TypeScript, Lua and Python tests pass.

## 11. Milestone 3 exit criteria

- [x] MCP stdio server implemented and registered in `opencode.json`.
- [x] Nine read-only tools for status, capabilities, inspection, response reading, clearing and errors.
- [x] Queue-by-default workflow avoids MCP timeouts while waiting for a manual Bridge click.
- [x] SDK stdio handshake and MCP tests pass.
