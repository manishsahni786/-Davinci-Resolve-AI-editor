# DaVinci Resolve Setup

Target: **DaVinci Resolve 21.1 Free on Windows 11**.

## 1. What the installer does

Run from the project root:

```powershell
npm run resolve:install-scripts
```

The installer:

1. Detects the project root.
2. Ensures the bridge data directories exist under `data\` and logs under `logs\`.
3. Backs up any previous `Utility\AI Video Editor` folder to `backups\resolve-scripts\AI Video Editor <timestamp>` in the project, outside the Resolve script scan path.
4. Copies the implementation:
   - `bridge.lua`
   - `diagnostics.lua`
   - `lib\json.lua`
   - `lib\paths.lua`
   - `lib\resolve-context.lua`
5. Generates `bridge_config.lua` with absolute Windows paths.
6. Writes two launcher scripts directly under `Utility`:
   - `AI Video Editor Bridge.lua`
   - `AI Video Editor Diagnostics.lua`
7. Writes a small `README.txt` describing the menu location.

The launchers exist because Resolve enumerates scripts placed **directly** in `Utility`; the implementation stays in a subfolder. The installer does **not** modify `resolve_test.lua` or any other existing script in the Utility folder.

Default install locations:

```
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AI Video Editor Bridge.lua
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AI Video Editor Diagnostics.lua
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AI Video Editor\
```

To use a different data/log location:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\resolve-scripts\install.ps1 `
  -DataRoot "D:\AI-Video-Editor\data" `
  -LogsRoot "D:\AI-Video-Editor\logs"
```

Then set the same paths for Node with `AVE_DATA_DIR` and `AVE_LOG_DIR` in `.env`, or by creating `config/settings.json` from `config/settings.example.json`.

## 2. Restart Resolve

Resolve enumerates the Scripts folders at startup. After installing or updating scripts:

1. Save your project.
2. Restart DaVinci Resolve.
3. Open a project.

The menu should contain:

```text
Workspace
  Scripts
    Utility
      AI Video Editor Bridge
      AI Video Editor Diagnostics
```

## 3. Run diagnostics inside Resolve

Use:

**Workspace > Scripts > Utility > AI Video Editor Diagnostics**

It writes:

```
<project>\logs\resolve-diagnostics.json
```

and prints the same JSON to the Resolve Console. This file is the authoritative record of what the internal Lua context can see:

- `globals.resolve` type,
- Resolve version/product/Studio flag,
- current page,
- project manager and project,
- timeline and track counts,
- media-pool clip count,
- render formats and current format/codec,
- bridge directory write checks,
- collected errors.

If `connected` is `false`, stop and inspect `errors`. Do not proceed to timeline editing.

## 4. Run the Node connection test

With Resolve running:

```powershell
npm run resolve:test
```

Expected flow:

```text
1. Queued request <uuid>
2. ACTION REQUIRED in DaVinci Resolve:
   Workspace > Scripts > Utility > AI Video Editor Bridge
   Waiting up to 120 seconds for a response...
```

Switch to Resolve and run the bridge menu item. The bridge processes exactly one request and returns to the menu.

A real success looks like:

```json
{
  "requestId": "...",
  "status": "success",
  "meta": {
    "resolveVersion": "21.1.0.17",
    "isStudio": false,
    "projectName": "...",
    "timelineName": "...",
    "scriptContext": "predefined global 'resolve'"
  },
  "result": {
    "message": "pong",
    "resolveConnected": true
  }
}
```

The test exits non-zero if Resolve is not connected, if the Lua script cannot obtain the Resolve object, or if no response arrives before the timeout.

## 5. Read-only inspection commands

Milestone 2 adds four verified read-only commands. Queue one command at a time, trigger the Bridge menu, then read the response:

```powershell
npm run resolve:queue -- project.inspect
npm run resolve:read -- <request-id>

npm run resolve:queue -- media.inspect
npm run resolve:queue -- timeline.inspect
npm run resolve:queue -- render.inspect
```

Convenience commands queue and wait for one manual trigger:

```powershell
npm run resolve:project
npm run resolve:media
npm run resolve:timeline
npm run resolve:render
```

If no timeline is open, `timeline.inspect` returns `TIMELINE_UNAVAILABLE`. To inspect track items, open or create a timeline first. `render.inspect` reports formats, codecs, presets and current format/codec; `Project.GetRenderSettings` is absent in this Free internal context and is therefore omitted without an error.

## 6. Verification checklist

Run these before starting Milestone 3:

```powershell
npm test
npm run lua:test
npm run python:test
npm run typecheck
npm run resolve:test
```

`npm run resolve:test` is the only test that requires a human in Resolve. It must report:

```text
SUCCESS - Resolve responded through the Fusion prefs bridge.
...
"resolveConnected": true
```

and `meta.scriptContext` should indicate the predefined internal global. If it reports `RESOLVE_UNAVAILABLE`, the prefs channel works but the internal Resolve object does not; record the diagnostics and stop.

### Retry policy

Mutating commands are **not** retried automatically. A timeout leaves the request queued, and the response can be read later by id. This prevents a slow manual trigger from causing a duplicate timeline edit or render. Read-only diagnostics follow the same rule so behavior is predictable.

## 7. Late responses and pending requests

If the Node command times out, the request is **not** deleted. It remains at:

```
data\requests\next.request.json
data\requests\next.request.lua
```

Trigger the bridge in Resolve, then read the response:

```powershell
npm run resolve:read -- <request-id>
```

To inspect the queue:

```powershell
npm run status
```

To discard a pending request:

```powershell
npm run resolve:clear
```

Clearing moves the request into `data\requests\archive\`.

## 8. Why it is manual

Resolve Free does not expose external scripting on this machine:

- port `1144` is closed,
- `ResolvePython` cannot obtain the Resolve object,
- `fuscript` `Resolve()` returns nil.

Internal menu scripts can access the documented global `resolve`, but Resolve runs them synchronously on the UI thread. A background polling loop would freeze the application. The bridge therefore processes one request per manual trigger. This is a platform constraint, not an implementation shortcut.

## 9. Troubleshooting

### The AI Video Editor menu is missing

Resolve enumerates scripts **directly** under `Utility`, not scripts buried in arbitrary subfolders. The installer therefore creates two launchers directly in `Utility`.

- Restart Resolve; script folders are scanned at startup.
- Confirm these files exist under the **user** path:
  - `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AI Video Editor Bridge.lua`
  - `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AI Video Editor Diagnostics.lua`
- Confirm the implementation folder exists:
  `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\AI Video Editor`
- Confirm `bridge.lua`, `diagnostics.lua`, and `bridge_config.lua` are inside it.
- Confirm `lib\json.lua`, `lib\paths.lua`, `lib\prefs.lua`, `lib\resolve-context.lua` exist.
- Re-run `npm run resolve:install-scripts` and restart Resolve.

### "no queued request"

The bridge ran with nothing to process. Queue a command from Node first (`npm run resolve:test` or `npm run resolve:queue -- <command>`). If a request was just queued, trigger the Bridge again after the queue file is visible.

### "REQUEST_ALREADY_PROCESSED"

The request id was already handled, but its cached response is no longer available. Issue a new request instead of retrying the old id.

### The Bridge reports an early error

Check the stage and error keys:

```powershell
npm run resolve:error
```

`AIVEBridgeStage` shows where processing stopped. Common values are `no-request`, `request-loaded`, `response-published`, and `error`. Early transport errors are also written to `AIVEBridgeError` and `AIVEBridgeErrorAt`.

### "bridge_config.lua not found next to the script"

The script was copied without the generated config, or the installer failed. Re-run:

```powershell
npm run resolve:install-scripts
```

### "RESOLVE_UNAVAILABLE" / `resolveConnected: false`

The Lua script ran, but the internal Resolve object was not available. This is important diagnostic information, not a Node bug.

Check `logs\resolve-diagnostics.json` and the Console output. Also check whether the script is being run from **inside** Resolve rather than with `fuscript` from a terminal (external `fuscript` cannot connect on Free).

### "Fusion preferences are unavailable"

The Lua sandbox could not reach `fusion:SetPrefs` / `fusion:SavePrefs`. The bridge cannot publish a response without it. Re-run the installer, restart Resolve, and confirm the scripts are launched from the internal menu, not external `fuscript`.

### "Response published but Node times out"

Check that these keys exist in `Fusion.prefs`:

```
Global.AIVideoEditorBridgeResponseId
Global.AIVideoEditorBridgeResponseHex
Global.AIVideoEditorBridgeProcessedId
Global.AIVEBridgeStage
Global.AIVEBridgeError
Global.AIVEBridgeErrorAt
```

Also verify the request id matches, then run `npm run resolve:read -- <request-id>`. The read retries briefly for a prefs flush, and Node persists the response to `data\responses\<id>.response.json` when it reads it. Processed ids are retained for idempotent replay (up to 20).

### The old `resolve_test.lua` still fails

That script is preserved on purpose. It calls `Resolve()` (external entry point) and writes to `C:\rlb`, which does not exist. Use the new diagnostics script instead. If you want to fix it, change `Resolve()` to the predefined global `resolve` and write to an existing directory â€” but the project does not modify it automatically.

### External scripting still reports nil

Expected on this Free installation. See [ENVIRONMENT_DIAGNOSTICS.md](ENVIRONMENT_DIAGNOSTICS.md). Do not enable undocumented registry hacks; the supported architecture is the internal Lua bridge.

## 10. Logs

| File | Contents |
| --- | --- |
| `logs/ai-video-editor-YYYY-MM-DD.log` | Node JSONL structured logs |
| `logs/resolve-diagnostics.json` | Latest internal Resolve diagnostic report |
| `logs/resolve-bridge.log` | Lua bridge request/response one-line audit |
| `data/responses/<id>.response.json` | Last response for a request id |
| `data/requests/archive/` | Processed or cleared requests |

Include these files when reporting a bridge failure. They do not contain source media.
