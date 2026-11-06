# Environment Diagnostics

Date: 2026-10-30  
Updated: 2026-11-05
Project: AI Video Editor (OpenCode + DaVinci Resolve Free 21.1)
Milestones: 1-5 - environment inspection, bridge, read-only inspection, MCP server, project/media management, and timeline editing

This report separates measured facts from assumptions. Anything not yet exercised inside Resolve is marked **supported but not yet tested**, not "working".

The original Python, pip and FFmpeg rows below are a dated 2026-10-30 snapshot. The 2026-11-05 media-analysis environment and Ollama measurements are in section 14.

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
Node invokes (Windows UI Automation, default):
Workspace > Scripts > Utility > AI Video Editor Bridge
(manual fallback when AVE_AUTO_TRIGGER=false)
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
- **No background polling loop** because Resolve runs menu Lua synchronously on the UI thread. A loop would freeze the UI. Each request is instead invoked from outside Resolve with Windows UI Automation (`resolve-scripts/invoke-bridge.ps1`).
- **Optional auto-trigger is throttled and stops after one success.** It is disabled by default; manual menu launch is the required workflow.
- **Timeout is a failure**, not a success. The queued request remains available for a later read or manual trigger.
- **Fusion prefs response channel** because Resolve Free's internal Lua has `io = nil` and cannot write response files.
- **Response schema validation** rejects malformed or mismatched replies.
- **Logs** are JSONL in `logs/`; Node persists the received response for audit.

### Verified parts of the bridge

Verified by automated tests and by live invocation inside the running Resolve application:

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
- Windows UI Automation menu invocation: `resolve:test`, all four timeline commands and `reel` ran with no manual click.

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
| Workspace > Scripts menu Lua execution | Verified live, including automatic UI Automation invocation |
| Internal Resolve object | `resolveConnected: true`, version `21.1.0.17` |
| Node/TypeScript project toolchain | typecheck + 108 unit tests passed; 1 live Resolve integration test skipped |
| File bridge mechanics | Unit tests, prefs test, and mock adapter |
| Fusion prefs response channel | Live Resolve round-trip + unit test |
| Optional auto-trigger | Previously verified live; disabled by default |
| Read-only inspection commands | Live `project.inspect`, `media.inspect`, `timeline.inspect` and `render.inspect` all returned `ok: true` |
| Project and media management | Live project create/open/save, bin create, media import |
| Timeline editing | Live create/append/delete/set-property (`Clip Color` = Blue) |
| Reel rough-cut workflow | Live project reuse, media inspect, clip selection, timeline create and save |
| MCP stdio server | Real SDK client handshake; 25 tools; MCP queue/read/wait/clear and plan lifecycle tests pass |
| Lua JSON and protocol | 68 Lua tests passed |
| Python media-analysis worker | 49 Python tests passed |
| Internal script installation without overwriting old scripts | Installer backup + separate folder |

### Supported but not yet tested (inside Resolve Free)

| Capability | Why it is plausible | What must happen |
| --- | --- | --- |
| Trimmed timeline append | `startFrame`/`endFrame` clip info in `AppendToTimeline` | Not started; needed for highlight cuts |
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

### Automatic but UI-dependent

| Capability | Status |
| --- | --- |
| Processing a queued bridge request | Automated through Windows UI Automation; Resolve must be running with its main window available |
| Making new scripts appear in the menu | Requires a Resolve restart after installation |
| Confirming a destructive edit | Still required by the safety workflow |

### Requires manual user interaction

| Capability | Reason |
| --- | --- |
| Manual Bridge launch | Required for each request by the current workflow |

## 7. Blockers and risks

1. **UI-automation fragility.** The bridge no longer needs a click, but UI Automation depends on Resolve's main window being visible and responsive. Minimized windows, focus changes, or UI changes can break the trigger. The manual menu fallback and explicit trigger error codes keep failures diagnosable.
2. **Optional API availability differs in Free.** `Project.GetRenderSettings` is absent from the verified internal context; optional methods are guarded and omitted rather than treated as failures.
3. **FFmpeg/FFprobe are still missing in the current virtual environment.** Video probing and frame sampling cannot run until paths are configured; current Python package and Ollama status is recorded in section 14.
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

# Timeline editing and rough-cut reel
npm run resolve:timeline-create -- "Reel Test"
npm run resolve:timeline-append -- <uniqueId>
npm run resolve:timeline-set-property -- video 1 1 --key="Clip Color" --value=Blue
npm run resolve:timeline-delete -- video 1 1
npm run reel -- --topic="frost" --timeline="Reel Workflow Test" --platform=instagram

# If it times out, read the response (or trigger the bridge manually)
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
- [x] `npm run resolve:test` returns `resolveConnected: true` after the automatic UI Automation trigger (manual fallback also works).

## 10. Milestone 2 exit criteria

- [x] Project, media pool, timeline and render inspection implemented.
- [x] Transport idempotency, early error/stage reporting, and stale response recovery.
- [x] All four inspection commands verified live in Resolve Free `21.1.0.17`.
- [x] TypeScript, Lua and Python tests pass.

## 14. Media-analysis update (2026-11-05)

| Item | Measured current state |
| --- | --- |
| Python used by project scripts | `.venv\Scripts\python.exe`, Python 3.12.13, pip 25.0.1 |
| Installed media modules | NumPy 2.5.4, OpenCV 5.0.0.93, PySceneDetect 0.7.2 |
| Missing media tools/modules | FFmpeg, FFprobe, SciPy, Pillow, faster-whisper, Whisper, imageio-ffmpeg |
| Default system `python.exe` | Broken install under `D:\Softwares`; fails importing `encodings` |
| Python script resolution | `AVE_PYTHON_PATH`, then project `.venv`, then `python` on PATH |
| Ollama API | Version 0.40.14, local `qwen3-vl:2b` model reachable |
| GPU | NVIDIA GeForce GTX 1650 Max-Q, 4 GB |

The exact-timestamp live vision prompt benchmark is `data/analysis-cache/results/vision-benchmark-live-full-2026-11-05.json`; the 768-token JSON-quality check is `vision-benchmark-json-quality-2026-11-05.json`. A live 8192-context warm-up and allocation check stopped at the configured CPU-offload limit; its per-run record is `data/analysis-cache/vision-requests/live-gpu-gate-check.jsonl`. The benchmarks test Ollama directly from sampled images; they do not verify source-video probing because FFmpeg/FFprobe are missing. See [Local vision analysis](VISION_ANALYSIS.md) for measured context allocation, inference settings, JSON recovery, and the next-test procedure.

## 11. Milestone 3 exit criteria

- [x] MCP stdio server implemented and registered in `opencode.json`.
- [x] Nine read-only tools for status, capabilities, inspection, response reading, clearing and errors.
- [x] MCP calls queue requests and expose ids for manual Bridge launch and response reading.
- [x] SDK stdio handshake and MCP tests pass.

## 12. Milestone 4 exit criteria

- [x] Project create/open/save and media bin/import commands implemented.
- [x] All five management commands verified live in Resolve Free `21.1.0.17`.
- [x] Capability matrix entries `resolve.project-management` and `resolve.media-management` marked `verified`.
- [x] TypeScript, Lua and MCP tests cover management success and failure paths.

## 13. Milestone 5 exit criteria

- [x] Timeline create/append/delete/set-property commands implemented in Lua, mock, CLI and MCP.
- [x] Offline TypeScript, Lua and MCP tests cover timeline editing success and failure paths.
- [x] All four timeline commands verified live in Resolve Free `21.1.0.17` (`timeline.create`, `timeline.appendClips`, `timeline.deleteClips`, `timeline.setItemProperty` with `Clip Color` = Blue).
- [x] Windows UI Automation auto-trigger verified live as an optional path; manual launch is the current default requirement.
- [x] `npm run reel` rough-cut workflow verified live (project reuse, media inspection, clip selection, timeline create, save).
- [x] Capability matrix entries `resolve.timeline-editing`, `bridge.auto-trigger` and `resolve.editing-workflow` marked `verified`.
- [x] Trimmed append, transitions, audio mixing and render are explicitly out of scope for Milestone 5.
