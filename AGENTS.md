# AI Video Editor - Agent Guide

## What this project is

A Node.js/TypeScript MCP server and CLI that controls **DaVinci Resolve 21.1 Free** on Windows through a file-based bridge and an internal Lua script. Resolve Free blocks external scripting, so commands are written to `data/requests/` and executed by `resolve-scripts/bridge.lua` after the user launches the Bridge from Resolve's Workspace > Scripts menu. The optional Windows UI Automation trigger is disabled by default.

## Setup and verification

```powershell
npm install
npm run build
npm run resolve:install-scripts
npm run resolve:test
```

Restart Resolve after installing scripts. Restart opencode after changing `opencode.json`, agent files, or the MCP server build.

## Commands

- `npm run typecheck` - strict TypeScript check.
- `npm test` - Vitest unit tests.
- `npm run lua:test` - Lua protocol tests through `fuscript`.
- `npm run python:test` - Python worker tests.
- `npm run build` - compile `dist/mcp-server.js`.
- `npm run resolve:test` - live Resolve bridge round-trip.
- `npm run reel -- --topic="<text>" --timeline="<name>" --platform=instagram|youtube` - rough-cut reel assembly.
- `npm run resolve:install-scripts` - reinstall Lua scripts (backs up the previous install).

Run `npm run typecheck` and `npm test` after TypeScript changes. Run `npm run lua:test` after Lua changes.

## Key files

- `src/bridge/file-bridge.ts` - request queue, polling, auto-trigger scheduling, health.
- `src/bridge/resolve-trigger.ts` - wraps `resolve-scripts/invoke-bridge.ps1`.
- `src/config/settings.ts` - settings and env (`AVE_AUTO_TRIGGER`, `AVE_AUTO_TRIGGER_INTERVAL_MS`, `AVE_AUTO_TRIGGER_SCRIPT`).
- `src/mcp/server.ts` - MCP tool registration.
- `src/resolve/resolve-client.ts` - bridge command wrappers.
- `src/resolve/editing-workflow.ts` - project/media/reel orchestration.
- `src/resolve/resolve-capabilities.ts` - single source of truth for verified vs restricted capabilities.
- `src/planning/editing-plan.ts` and `src/planning/plan-store.ts` - validated plan contract, revisions, approval state and local persistence.
- `resolve-scripts/lib/resolve-context.lua` - all Resolve API calls and command handlers.
- `resolve-scripts/tests/run.lua` - Lua mocks and protocol tests.

## Conventions

- TypeScript ESM with `.js` extensions in relative imports.
- Zod validation for tool inputs; re-validate payloads before queueing.
- Never claim a capability is verified unless it has run live in Resolve Free.
- Keep the bridge single-request. Do not add concurrent queue slots.
- The user manually launches the Bridge for each queued request. A timeout is a failure; leave the request queued and report its id.
- Never mutate a Resolve timeline until the user has reviewed and explicitly approved a concrete editing plan. If the planning/approval workflow is unavailable, explain that and do not edit.
- Do not modify or delete source media.
- Do not commit or push unless the user explicitly asks.

## Known limits

- Whole-clip timeline editing only; no trimming, transitions, audio mixing, or render/export yet.
- `timeline.setItemProperty` uses `TimelineItem.SetClipColor` / `SetName` / `SetProperties`; there is no `SetProperty`.
- Media analysis packages (FFmpeg/OpenCV/Whisper) are not installed.
