# MCP Setup

The project now exposes a local **Model Context Protocol** server over stdio. It provides Resolve status, inspection, project/media management, timeline-editing and reel-assembly tools to OpenCode or any other MCP client.

The server does not bypass the bridge: every Resolve request goes through the file bridge because DaVinci Resolve Free does not allow external scripting. Each request must be launched manually from Resolve's Workspace > Scripts menu. The optional Windows UI Automation trigger is disabled by default.

## 1. Build

```powershell
npm run build
```

The server entry point is:

```text
dist\mcp-server.js
```

For development without building:

```powershell
npm run mcp
```

Run the server directly only with an MCP client. It communicates over stdin/stdout, so starting it in a normal terminal will appear to hang.

## 2. Cursor configuration

Project-level MCP config lives at `.cursor/mcp.json` so Cursor Agent can use the same tools:

```json
{
  "mcpServers": {
    "ai-video-editor": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/AI_Projects/Divinci+ Opencode/dist/mcp-server.js"],
      "env": {
        "AVE_AUTO_TRIGGER": "false",
        "AVE_LOG_LEVEL": "info"
      }
    }
  }
}
```

Build first (`npm run build`), then restart Cursor (or toggle the server under **Customize → MCPs**) so `resolve_*` tools appear. Bridge launches remain manual.

## 3. OpenCode configuration

This repository includes an `opencode.json` that registers the server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai-video-editor": {
      "type": "local",
      "command": ["node", "dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "AVE_LOG_LEVEL": "info",
        "AVE_AUTO_TRIGGER": "false"
      }
    }
  }
}
```

Restart OpenCode after changing MCP configuration. Config is loaded only at startup.

The server also writes its logs to the normal project log directory, so stdout remains reserved for MCP JSON-RPC.

## 4. Tools

| Tool | Purpose |
| --- | --- |
| `resolve_status` | Environment, Resolve process, bridge health and capability summary |
| `resolve_capabilities` | Full capability matrix |
| `resolve_inspect_project` | Current project and project list |
| `resolve_inspect_media` | Media-pool bins and clips |
| `resolve_inspect_timeline` | Timeline, tracks, items and markers |
| `resolve_inspect_render` | Render formats, codecs, presets and current format/codec |
| `resolve_create_project` | Create and open a new project |
| `resolve_open_project` | Open an existing project (optionally saving the current one) |
| `resolve_save_project` | Save the current project |
| `resolve_create_bin` | Create a media-pool bin |
| `resolve_import_media` | Import media files into the current or a target bin |
| `resolve_create_timeline` | Create a timeline, optionally from media pool clip ids |
| `resolve_append_clips` | Append media pool clips to the current timeline |
| `resolve_delete_clips` | Delete timeline items by track/item indices (destructive) |
| `resolve_set_item_property` | Set properties on a timeline item |
| `resolve_make_reel` | Reuse/create a project, import media, select clips by topic or ids, and assemble a rough-cut timeline |
| `resolve_read_response` | Read the response for a queued request id |
| `resolve_clear_pending` | Archive an unprocessed request |
| `resolve_last_error` | Last early bridge error and stage from Fusion prefs |
| `resolve_create_editing_plan` | Validate and persist an editing-plan draft; does not access Resolve |
| `resolve_get_editing_plan` | Read a plan and its current revision/approval state |
| `resolve_revise_editing_plan` | Revise the plan; increments revision and clears approval |
| `resolve_approve_editing_plan` | Record explicit approval for a specific revision |
| `resolve_reject_editing_plan` | Record rejection of a draft revision |
| `resolve_execute_editing_plan` | Queue a timeline from an approved plan; currently whole clips on a new timeline only |
| `resolve_mark_editing_plan_executed` | Mark a plan complete after verifying the Resolve timeline |

The inspection tools are read-only with respect to the Resolve project. The five Milestone 4 management tools modify the project (project list, media pool bins, media links) but never modify or delete source media files; they are verified live in Resolve Free 21.1.0.17. All four Milestone 5 timeline-editing tools (`timeline.create`, `timeline.appendClips`, `timeline.deleteClips`, `timeline.setItemProperty`) were verified live in Free 21.1.0.17, and `resolve_make_reel` completed a live rough-cut assembly. Source media files are never modified or deleted.

## 5. Queue and read workflow

Tools queue and return a request id by default. After launching the Bridge in Resolve, read the response by id:

1. Call `resolve_inspect_timeline`.
2. Node queues the request and returns its id.
3. Launch Workspace > Scripts > Utility > AI Video Editor Bridge in Resolve.
4. Read the result with `resolve_read_response` and the request id.

To queue without waiting, pass `wait: false`. The result then contains `requestId` and `nextStep`:

```json
{
  "queued": true,
  "command": "timeline.inspect",
  "requestId": "fbe54c06-97a0-458c-a56f-46ac80e1a8a7",
  "nextStep": "In Resolve, launch Workspace > Scripts > Utility > AI Video Editor Bridge, then call resolve_read_response with this requestId.",
  "autoTrigger": false
}
```

Call `resolve_read_response` with that `requestId` after the bridge runs. Reading a response never launches the Bridge. The default bridge timeout is 120 seconds.

## 5. Example tool arguments

```json
{
  "name": "resolve_inspect_timeline",
  "arguments": {
    "wait": false,
    "timelineIndex": 1,
    "includeClips": true,
    "maxClips": 100
  }
}
```

`timelineIndex` is optional; omit it to inspect the current timeline. If no timeline is open, the response is `TIMELINE_UNAVAILABLE`.

Render inspection:

```json
{
  "name": "resolve_inspect_render",
  "arguments": {
    "wait": false,
    "includeJobs": true
  }
}
```

Milestone 4 management examples:

```json
{
  "name": "resolve_create_bin",
  "arguments": { "wait": false, "name": "Angle A", "parentPath": "Footage" }
}
```

```json
{
  "name": "resolve_import_media",
  "arguments": { "wait": false, "filePaths": ["C:\\Media\\clip1.mp4"], "binPath": "Footage/Angle A" }
}
```

```json
{
  "name": "resolve_open_project",
  "arguments": { "wait": true, "name": "Dying_Light_8", "saveCurrent": true }
}
```

Milestone 5 timeline editing examples:

```json
{
  "name": "resolve_create_timeline",
  "arguments": { "wait": false, "name": "Reel A", "mediaIds": ["0ba5eaab-262c-4ce2-b975-91576a26e10b"] }
}
```

```json
{
  "name": "resolve_append_clips",
  "arguments": { "wait": false, "mediaIds": ["0ba5eaab-262c-4ce2-b975-91576a26e10b"] }
}
```

```json
{
  "name": "resolve_delete_clips",
  "arguments": {
    "wait": false,
    "targets": [{ "trackType": "video", "trackIndex": 1, "itemIndices": [1] }]
  }
}
```

```json
{
  "name": "resolve_set_item_property",
  "arguments": {
    "wait": false,
    "target": { "trackType": "video", "trackIndex": 1, "itemIndex": 1 },
    "properties": { "Clip Color": "Blue" }
  }
}
```

Rough-cut reel assembly:

```json
{
  "name": "resolve_make_reel",
  "arguments": {
    "projectName": "AIVE Milestone 4 Test",
    "topic": "frost",
    "timelineName": "AIVE Reel Workflow Test",
    "platform": "instagram"
  }
}
```

Pass `mediaPaths` to import first, `clipIds` to select exact clips, and `maxClips` to bound the result. The tool selects whole clips only; trimming, transitions, audio mixing and rendering are later milestones.

## 6. Verification

Automated tests cover the MCP handshake, tool discovery, queueing, response reading, waiting, clearing, Milestone 4 management tools, Milestone 5 timeline-editing tools and the reel workflow (queueing, waiting, input rejection, and full flows over the mock adapter):

```powershell
npm test
npm run typecheck
npm run build
```

Editing plans are stored under `data/plans/`; revising a plan creates a new revision and clears its approval. `resolve_execute_editing_plan` refuses unapproved plans, partial source intervals, timeline gaps/overlaps, unsupported treatments, unsupported output settings, and duration mismatches. It queues one `timeline.create` request and requires a manual Bridge launch. Afterward, inspect the new timeline and save the project if the approved plan requests it before marking the plan complete.

Current MCP server tools: **28**, including `resolve_analyze_media` for bounded local file/folder analysis and `resolve_create_plan_from_analysis` to convert an `analyze_events` result into a validated editing-plan draft (media pool `mediaId` required; boundaries are kept model-reported and the draft warns that execution currently enforces whole clips). FFmpeg, Python packages, local model weights and any vision endpoint must be supplied by the user; the tool never installs or downloads them. The tests use the official MCP SDK over an in-memory transport, and the stdio server has also been smoke-tested with a real SDK client process.

`resolve_analyze_media` takes a selected `path` and an `operation` (`analyze_media`, `analyze_events`, `probe_media`, `discover_media`, `detect_scenes`, `detect_silence`, or `transcribe`). Configure `AVE_PYTHON_PATH` if the worker should use a specific Python environment. For Ollama set `AVE_VISION_API_STYLE=ollama`, `AVE_VISION_BASE_URL=http://127.0.0.1:11434`, and `AVE_VISION_MODEL` to the local model name. `AVE_WHISPER_MODEL_PATH` must point to existing local faster-whisper model files. Vision analysis samples a bounded number of frames, validates returned observation timestamps against those samples, and never treats a sampled point as a verified clip boundary.

`analyze_events` runs two passes: a broad pass-1 scan that ranks candidate events, then an adaptive pass-2 re-sampling that refines boundaries with explicit uncertainty. Use `pass1MaxFrames`, `pass2FramesPerEvent`, `maxEvents`, `maxRequests` and `visionBatchSize` to bound cost. Event analysis defaults to one frame per vision request; `visionBatchSize` above 1 opts into multi-image requests and falls back to single-image requests if a batch fails. `AVE_VISION_EVENT_NUM_CTX` (default 5120), `AVE_VISION_BATCH_SIZE` and `AVE_VISION_MAX_REQUESTS` set the defaults. Event boundaries are model-reported and are never treated as verified edit points.

## 7. Troubleshooting

### The tools do not appear in OpenCode

1. Run `npm run build`.
2. Confirm `dist\mcp-server.js` exists.
3. Confirm `opencode.json` is in the project root.
4. Quit and restart OpenCode.
5. Check `logs\ai-video-editor-YYYY-MM-DD.log` for `MCP server started over stdio`.

### A tool returns `BRIDGE_BUSY`

A previous request is still pending. Run the Bridge menu for that request, read it with `resolve_read_response`, or clear it with `resolve_clear_pending` and `confirm: true`.

### A tool returns `BRIDGE_TIMEOUT`

Resolve did not process the request before the timeout. The request is still pending. Run `Workspace > Scripts > Utility > AI Video Editor Bridge`, then call `resolve_read_response` with the request id.

### Auto-trigger does not run

Check `resolve_status` for `autoTriggerEnabled` and `autoTriggerScriptPath`. The trigger requires the Resolve main window to be running and not minimized. Common codes are `RESOLVE_NOT_RUNNING`, `WINDOW_NOT_FOUND`, `MENU_NOT_FOUND` and `TRIGGER_TIMEOUT`. Re-run `npm run resolve:install-scripts` and restart Resolve if the menu item is missing.

### The server starts but Resolve commands fail

The MCP server is working, but the Resolve side is separate. Verify the Lua scripts are installed and Resolve was restarted after installation:

```powershell
npm run resolve:install-scripts
```

Then run `resolve_last_error` or `resolve_status`.
