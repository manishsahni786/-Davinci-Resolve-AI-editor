# AI Video Editor — Project Handoff

An AI-assisted video editing system for **DaVinci Resolve 21.1 Free on Windows**, driven from
**OpenCode** through a local MCP server.

Give this file to anyone who needs to understand, run, or evaluate the project.

---

## 1. The one-paragraph version

This is an AI video editing assistant that drives DaVinci Resolve 21.1 Free on Windows. You talk to
it in plain English inside OpenCode; it inspects your Resolve project, proposes an edit plan, waits
for your approval, then builds the timeline through Resolve's own scripting API. It never guesses
clip IDs, never touches your source files, and never claims an edit worked until it has re-inspected
the timeline and confirmed it.

It is a **planner + executor with a human approval gate**, not an "AI that magically edits."

---

## 2. The core problem, and why the design looks unusual

DaVinci Resolve **Free** does not allow external scripting. This was measured on the reference
machine:

- TCP port `1144` (Resolve's scripting listener) is closed
- `ResolvePython` `scriptapp("Resolve")` returns `None`
- `fuscript` `Resolve()` returns `nil` even while Resolve is running

Node therefore cannot call Resolve directly. The workaround is a **file bridge**:

```
OpenCode
  -> Node.js / TypeScript MCP server
  -> atomic JSON + Lua request files on disk
  -> user launches Workspace > Scripts > Utility > AI Video Editor Bridge
  -> Resolve executes one Lua request inside its own process
  -> response published as hex JSON in Fusion preferences
  -> Node reads it back and archives it under data/responses/
```

Two consequences worth saying out loud:

1. **Every request needs one manual menu click in Resolve.** That is a constraint of the Free
   edition, not a bug. An optional Windows UI Automation trigger exists and was verified live, but
   it is disabled by default (`AVE_AUTO_TRIGGER=false`).
2. **One request at a time.** Resolve runs menu scripts synchronously on the UI thread; a background
   polling loop would freeze the application. The bridge processes exactly one request per click.

Additional constraint: Resolve Free sandboxes internal Lua, so `io` is unavailable. The Lua side
cannot write response files and publishes results through `fusion:SetPrefs` / `fusion:SavePrefs`.

---

## 3. What it can actually do

### A. Look, read-only

- Read the open project and the project list
- Read media pool bins and clips
- Read timeline tracks, clip items and markers
- Read available render formats, codecs and presets
- Analyse a video file on disk: duration, resolution, frame rate, sampled frames, and optionally
  scene cuts, silence and transcription (dependency-dependent)

### B. Set up

- Create, open (with save-current), and save projects
- Create bins, including nested paths such as `Footage/Angle A`
- Import files and folders — **links only**; source media is never modified or deleted

### C. Plan, then edit

- Build a validated editing plan: which files, exact in/out points, timeline positions, video
  tracks, ordering, target duration, output settings and warnings
- The plan is a file on disk with revisions; **any revision clears prior approval**
- On execution it can:
  - create a new timeline from whole clips, or
  - place **frame-accurate source ranges** — live-verified for single track, a second video track
    (V1/V2), multiple distinct source files, and linked source audio on A1
  - append clips, rename or recolour clips, and delete clips

### D. Verify

- Re-inspect the timeline after every edit and report what is actually there
- A timeout is reported as a timeout, never as success

---

## 4. What it deliberately cannot do

State these plainly — they build credibility rather than lose it.

- No transitions, effects or captions
- No audio mixing, gain or ducking (it does place the linked source audio that belongs to a clip)
- No aspect-ratio enforcement (Instagram 9:16 / YouTube 16:9 is warned about, not applied)
- No rendering or export to MP4 yet
- No headless control; no AI IntelliSearch / Slate / Speech Generator (Studio-only)
- Adding ranges to an *existing* timeline (`appendRanges`) is implemented and tested but **not yet
  proven in a live Resolve run** — treat it as provisional
- Only 60 fps sources have been exercised with frame-accurate ranges

The project keeps a **capability matrix** that labels every feature `verified`,
`supported-untested`, `restricted-free` or `unsupported`, with the live request ID as evidence.
That matrix is the honest answer to "how do you know it works?"

Check the current state with:

```powershell
npm run capabilities
npm run status
```

---

## 5. Setting it up on a fresh machine

### Prerequisites

- Windows 10/11
- DaVinci Resolve **21.1 Free** (verified on `21.1.0.17`)
- Node.js **20.11 or newer**
- OpenCode installed
- Optional: Python 3.12 + FFmpeg/FFprobe (media analysis only, not required for editing)

### Step by step

1. **Install dependencies**

   ```powershell
   npm install
   ```

2. **Build the MCP server** — this produces `dist\mcp-server.js`, which `opencode.json` launches

   ```powershell
   npm run build
   ```

3. **Configure the environment**

   - Copy `.env.example` to `.env`
   - Set `AVE_RESOLVE_INSTALL_DIR` to *their* Resolve install folder. This value is
     machine-specific — do not reuse someone else's path
   - Leave `AVE_AUTO_TRIGGER=false` so requests stay manual

4. **Install the Resolve-side scripts**

   ```powershell
   npm run resolve:install-scripts
   ```

   This writes two launcher scripts directly into:

   ```
   %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\
   ```

   and keeps the implementation in a subfolder. Any previous install is backed up under
   `backups\`.

5. **Restart Resolve**

   Script folders are scanned only at startup. Afterwards open a project.

6. **Confirm the menu exists**

   ```
   Workspace > Scripts > Utility > AI Video Editor Bridge
   Workspace > Scripts > Utility > AI Video Editor Diagnostics
   ```

7. **Verify the connection**

   ```powershell
   npm run status
   npm run resolve:test
   ```

   `resolve:test` queues a ping and waits. When it prints the prompt, switch to Resolve and click
   the Bridge. Success looks like:

   ```json
   {
     "status": "success",
     "meta": { "resolveVersion": "21.1.0.17", "isStudio": false },
     "result": { "message": "pong", "resolveConnected": true }
   }
   ```

8. **Restart OpenCode** so it loads the MCP server, then confirm the `ai-video-editor` tools appear.

### Files that matter

| Path | Purpose |
| --- | --- |
| `opencode.json` | Registers the MCP server; sets `default_agent: opencode-davinci` |
| `AGENTS.md` | The operating rules the assistant follows |
| `.opencode/agents/opencode-davinci.md` | The agent definition — keep it in the repo |
| `.env` | Machine-specific configuration (not committed) |
| `docs/RESOLVE_SETUP.md` | Full install and troubleshooting reference |
| `docs/ARCHITECTURE.md` | Component layout |
| `docs/MCP_SETUP.md` | MCP tool reference |

### Recommended verification suite

```powershell
npm run typecheck
npm test
npm run lua:test
npm run python:test
npm run resolve:test
```

Only `resolve:test` requires Resolve to be running.

---

## 6. What a first editing session looks like

1. Open Resolve, open or create a project, and stay on the Edit page.
2. In OpenCode, ask: *"Import this folder and build me a 45-second rough cut for Instagram."*
3. The assistant checks status, inspects the project and media pool, and analyses the footage.
4. It returns a **plan**: files, timestamps, ordering, duration, warnings.
5. You read it and reply `yes`, or ask for changes. If it changes, you approve the new revision.
6. It queues execution and gives you a **request ID**. You click the Bridge in Resolve.
7. It inspects the new timeline, reports exactly what landed, and saves the project.

Example of the CLI path instead of the agent:

```powershell
npm run reel -- --topic="frost" --timeline="Rough Cut 01" --platform=instagram
```

Topic selection in the reel workflow matches **filenames only** — it is not visual understanding.

---

## 7. Quick troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Menu item missing | Resolve was not restarted, or scripts are not installed — re-run `npm run resolve:install-scripts` |
| `no queued request` | Nothing was queued in Node before the Bridge was clicked |
| `RESOLVE_UNAVAILABLE` | The script ran but could not reach Resolve's internal object — check `logs\resolve-diagnostics.json` |
| Node times out | The request is **still queued**, not lost: click the Bridge again, then `npm run resolve:read -- <id>` |
| `REQUEST_ALREADY_PROCESSED` | Issue a new request instead of retrying an old id |
| `bridge_config.lua not found` | The installer did not complete — re-run `npm run resolve:install-scripts` |
| Old `resolve_test.lua` fails | Expected; it uses the external entry point. Use the Diagnostics menu item instead |
| Auto-trigger failures | `RESOLVE_NOT_RUNNING`, `WINDOW_NOT_FOUND`, `MENU_NOT_FOUND`, `TRIGGER_TIMEOUT` — see `docs/RESOLVE_SETUP.md` |

Diagnostic files:

- `logs/ai-video-editor-YYYY-MM-DD.log` — Node JSONL logs
- `logs/resolve-diagnostics.json` — latest internal Resolve report
- `logs/resolve-bridge.log` — one-line Lua audit
- `data/responses/<id>.response.json` — archived responses

These contain no source media.

---

## 8. Two framing notes when presenting this

- **Sell the discipline, not the magic.** The interesting engineering is the evidence trail: a
  capability matrix, approval-gated plans, verification after every mutation, and "timeout means
  failure." That is what makes an AI editor safe on real projects.
- **Be upfront about the Free-edition ceiling.** No render and no transitions means it produces a
  rough cut inside Resolve, not a finished deliverable. Anyone expecting one-click finished Reels
  will be disappointed; anyone expecting a fast, safe assembly they finish by hand will be pleased.

---

## 9. Safety rules built into the system

- Source media is never modified, moved or deleted
- No timeline mutation without an explicitly approved, validated plan revision
- Destructive operations require explicit user confirmation
- No arbitrary shell commands derived from user instructions
- A missing or failed Resolve response is reported as a failure, never as success
- Capabilities are never claimed as verified until exercised live in Resolve Free
