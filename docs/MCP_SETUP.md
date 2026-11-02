# MCP Setup

The project now exposes a local **Model Context Protocol** server over stdio. It provides read-only Resolve status and inspection tools to OpenCode or any other MCP client.

The server does not bypass the bridge: every Resolve inspection still requires the manual Scripts-menu trigger because DaVinci Resolve Free does not allow external scripting.

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

## 2. OpenCode configuration

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
        "AVE_LOG_LEVEL": "info"
      }
    }
  }
}
```

Restart OpenCode after changing MCP configuration. Config is loaded only at startup.

The server also writes its logs to the normal project log directory, so stdout remains reserved for MCP JSON-RPC.

## 3. Tools

| Tool | Purpose |
| --- | --- |
| `resolve_status` | Environment, Resolve process, bridge health and capability summary |
| `resolve_capabilities` | Full capability matrix |
| `resolve_inspect_project` | Current project and project list |
| `resolve_inspect_media` | Media-pool bins and clips |
| `resolve_inspect_timeline` | Timeline, tracks, items and markers |
| `resolve_inspect_render` | Render formats, codecs, presets and current format/codec |
| `resolve_read_response` | Read the response for a queued request id |
| `resolve_clear_pending` | Archive an unprocessed request |
| `resolve_last_error` | Last early bridge error and stage from Fusion prefs |

All inspection tools are read-only with respect to the Resolve project. They do not cut, trim, move, delete, import, or render anything.

## 4. Queue and read workflow

Inspection tools default to `wait: false`, which avoids blocking an MCP call while waiting for a human:

1. Call `resolve_inspect_timeline`.
2. The result contains `requestId` and `nextStep`.
3. In Resolve, run:

   ```text
   Workspace > Scripts > Utility > AI Video Editor Bridge
   ```

4. Call `resolve_read_response` with that `requestId`.

Example result after queueing:

```json
{
  "queued": true,
  "command": "timeline.inspect",
  "requestId": "fbe54c06-97a0-458c-a56f-46ac80e1a8a7",
  "nextStep": "In Resolve: Workspace > Scripts > Utility > AI Video Editor Bridge",
  "then": "Call resolve_read_response with requestId fbe54c06-97a0-458c-a56f-46ac80e1a8a7."
}
```

If you prefer one blocking call, pass `wait: true` and click the Bridge menu while the tool is waiting. The default bridge timeout is 120 seconds.

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

## 6. Verification

Automated tests cover the MCP handshake, tool discovery, queueing, response reading, waiting, and clearing:

```powershell
npm test
npm run typecheck
npm run build
```

Current MCP server tools: **9**. The tests use the official MCP SDK over an in-memory transport, and the stdio server has also been smoke-tested with a real SDK client process.

## 7. Troubleshooting

### The tools do not appear in OpenCode

1. Run `npm run build`.
2. Confirm `dist\mcp-server.js` exists.
3. Confirm `opencode.json` is in the project root.
4. Quit and restart OpenCode.
5. Check `logs\ai-video-editor-YYYY-MM-DD.log` for `MCP server started over stdio`.

### A tool returns `BRIDGE_BUSY`

A previous request is still pending. Either trigger the Bridge in Resolve, read it with `resolve_read_response`, or clear it with `resolve_clear_pending` and `confirm: true`.

### A tool returns `BRIDGE_TIMEOUT`

Resolve did not process the request before the timeout. The request is still pending. Trigger the Bridge, then call `resolve_read_response`.

### The server starts but Resolve commands fail

The MCP server is working, but the Resolve side is separate. Verify the Lua scripts are installed and Resolve was restarted after installation:

```powershell
npm run resolve:install-scripts
```

Then run `resolve_last_error` or `resolve_status`.
