import type { Capability, CapabilityStatus } from "../types/resolve.types.js";

const CAPABILITIES: Capability[] = [
  {
    id: "resolve.internal-script-menu",
    name: "Workspace > Scripts menu Lua execution",
    status: "verified",
    implemented: true,
    milestone: "1",
    evidence: "Manual Bridge invocation returned resolveConnected: true and Resolve version 21.1.0.17."
  },
  {
    id: "resolve.internal-lua-context",
    name: "Internal Lua globals (resolve, bmd, fusion)",
    status: "verified",
    implemented: true,
    milestone: "1",
    evidence: "Live diagnostics found resolve, bmd, fusion, fu and Resolve available; resolve:GetVersionString() returned 21.1.0.17.",
    notes: "The internal sandbox has io = nil and cannot write files. Responses are published through Fusion preferences. The pre-existing resolve_test.lua calls Resolve(), which is the external-script entry point."
  },
  {
    id: "resolve.external-scripting",
    name: "External scripting from Node/Python/Lua processes",
    status: "restricted-free",
    implemented: false,
    milestone: "1",
    evidence: "Measured on 2026-10-30: TCP port 1144 is not listening; ResolvePython DaVinciResolveScript.scriptapp('Resolve') returned None; fuscript Resolve() returned nil while Resolve was running.",
    notes: "Official README documents external scripting configuration under DaVinci Resolve Studio. Node cannot establish a direct API connection to this Free installation."
  },
  {
    id: "bridge.file-request-response",
    name: "File request + Fusion prefs response bridge",
    status: "verified",
    implemented: true,
    milestone: "1",
    evidence: "Live request eb8dbb32-2abf-4881-ba3a-e0ea608900e5 was processed by the Bridge menu and returned ok: true, resolveConnected: true, version 21.1.0.17.",
    notes: "Node writes next.request.json and next.request.lua. Lua reads the request with loadfile and publishes the response through Fusion prefs because io is unavailable. Processed ids are retained for idempotent replay, and early transport failures are published through Fusion prefs. The user launches the menu item manually for each request; optional UI Automation is disabled by default."
  },
  {
    id: "bridge.auto-trigger",
    name: "Automatic Scripts-menu bridge trigger (no manual click)",
    status: "verified",
    implemented: true,
    milestone: "5",
    evidence: "Verified live on 2026-11-03 with Resolve Free 21.1.0.17: resolve-scripts/invoke-bridge.ps1 invokes Workspace > Scripts > AI Video Editor Bridge through UI Automation; npm run resolve:test returned SUCCESS and all four Milestone 5 timeline commands ran without a click.",
    notes: "UI Automation is a Windows-only transport shim, not external Resolve scripting. It works while the Resolve UI is running. If Resolve is closed, the trigger reports RESOLVE_NOT_RUNNING and the request stays queued."
  },
  {
    id: "resolve.inspection-readonly",
    name: "Read-only project, media pool, timeline and render inspection",
    status: "verified",
    implemented: true,
    milestone: "2",
    evidence: "Live Resolve Free 21.1.0.17: project.inspect b3efe48d-d048-4fd3-b947-25a9019eefa7, media.inspect e9b7ff20-e505-4fad-b9d7-914b05b0edd4, timeline.inspect b7859be9-c74b-4d19-a306-1770ef467c72 and render.inspect 44ce72ee-6287-41d5-b286-87deef8bc9ca all returned ok: true.",
    notes: "Timeline inspection returned TIMELINE_UNAVAILABLE when no timeline was open, then succeeded after a timeline was created. Project.GetRenderSettings is absent from this Free internal context; render settings are optional and omission is not treated as an error."
  },
  {
    id: "mcp.server",
    name: "MCP stdio server with read-only Resolve tools",
    status: "verified",
    implemented: true,
    milestone: "3",
    evidence: "A real MCP SDK client completed a stdio handshake with dist/mcp-server.js; MCP tests cover discovery, capability output, queueing, waiting, response reading, clearing, management and timeline-editing tools (19 tools total).",
    notes: "Tools queue and return request ids by default. The user launches the Bridge menu in Resolve, then reads each response by id."
  },
  {
    id: "bridge.background-polling",
    name: "Continuous background command polling inside Resolve",
    status: "unsupported",
    implemented: false,
    milestone: "1",
    evidence: "Resolve executes menu Lua scripts synchronously on the UI thread; no supported idle/background callback was found in the 21.1 scripting API.",
    notes: "A loop would freeze the Resolve UI. The bridge therefore runs one request per invocation, launched manually from Resolve's Workspace > Scripts menu."
  },
  {
    id: "bridge.mock-adapter",
    name: "Mock Resolve adapter for tests",
    status: "verified",
    implemented: true,
    milestone: "1",
    evidence: "src/resolve/mock-resolve-adapter.ts implements the same file protocol without Resolve."
  },
  {
    id: "resolve.project-management",
    name: "Project create/open/save/list",
    status: "verified",
    implemented: true,
    milestone: "4",
    evidence: "Live Resolve Free 21.1.0.17: project.save b4870b9a-89dd-4296-b8a4-73157a24676f, project.create 5169f38b-f0a8-4796-b7df-c599243fe19f and project.open db857303-2ed0-41cb-8145-135884264977 (with saveCurrent) all returned ok: true.",
    notes: "CreateProject, LoadProject and SaveProject work in the internal Lua context; OpenProject round-trips include the project list from GetProjectListInCurrentFolder."
  },
  {
    id: "resolve.media-management",
    name: "Media import, bins and media pool inspection",
    status: "verified",
    implemented: true,
    milestone: "4",
    evidence: "Live Resolve Free 21.1.0.17: media.createBin 1b52b4e0-3901-4ac5-b755-1641df01d2f5 (root) and 76224ddb-3bfb-4511-87c0-e08b53be0871 (nested Footage/Angle A), media.import c3c21b33-2e20-4b7a-a633-34b749b08d2f (1 clip, 60 fps, folder selection restored) all returned ok: true.",
    notes: "In this 21.1 Free internal Lua context MediaPool.ImportMedia([{clipInfo}]) returned nil; the deprecated ImportMedia([paths]) form succeeded and is used as fallback. AddSubFolder with a nested parent path works. Source files are only linked, never modified."
  },
  {
    id: "mock.management-commands",
    name: "Mock adapter execution of inspection and management commands",
    status: "verified",
    implemented: true,
    milestone: "4",
    evidence: "MockResolveAdapter implements the full bridge command set with in-memory project/bin/clip state and unit tests cover success and failure paths.",
    notes: "No Resolve required; results are simulated and never presented as live evidence. Covers the mock execution of inspection, management and timeline editing commands with in-memory project/bin/clip/timeline state."
  },
  {
    id: "resolve.timeline-editing",
    name: "Timeline creation and clip manipulation",
    status: "verified",
    implemented: true,
    milestone: "5",
    evidence: "All four commands verified live in Resolve Free 21.1.0.17 on 2026-11-03 with automatic menu triggering: timeline.create, timeline.appendClips (1 item), timeline.setItemProperty (Clip Color = Blue, applied: true) and timeline.deleteClips (1 item removed) each returned ok: true.",
    notes: "timeline.setItemProperty maps Clip Color/Clip Name to SetClipColor/SetName and batches other keys through TimelineItem.SetProperties; TimelineItem has no SetProperty method. Whole-clip create/append/delete/set-property only. Trimmed in/out append (startFrame/endFrame clipInfo) and transitions are not yet exposed."
  },
  {
    id: "resolve.editing-workflow",
    name: "High-level reel assembly workflow",
    status: "verified",
    implemented: true,
    milestone: "5",
    evidence: "npm run reel created AIVE Reel Workflow Test from the existing media pool on 2026-11-03: project reuse, media inspection, topic clip selection, timeline.create and project.save all returned ok: true.",
    notes: "Assembles a rough cut from whole clips selected by topic token or clip ids. It does not trim clips, add transitions, mix audio, render, or enforce Instagram 9:16 / YouTube 16:9 project settings yet; those remain later milestones."
  },
  {
    id: "resolve.render-h264-mp4",
    name: "MP4/H.264 render queue",
    status: "supported-untested",
    implemented: false,
    milestone: "6",
    evidence: "Project.AddRenderJob, SetRenderSettings, StartRendering and GetRenderJobStatus exist in the 21.1 API definition.",
    notes: "Codec availability must be queried at runtime with GetRenderFormats/GetRenderCodecs; do not hard-code codec names."
  },
  {
    id: "resolve.scene-detection",
    name: "Resolve-native scene cut detection",
    status: "supported-untested",
    implemented: false,
    milestone: "7",
    evidence: "Timeline.DetectSceneCuts is present in the 21.1 API definition.",
    notes: "A Python/PySceneDetect path will also be evaluated for media-pool analysis before editing."
  },
  {
    id: "resolve.transcription",
    name: "Resolve-native audio transcription",
    status: "supported-untested",
    implemented: false,
    milestone: "7",
    evidence: "MediaPoolItem.TranscribeAudio and GetTranscription are present in 21.1.",
    notes: "Studio/extras availability is not assumed. Local Whisper is the primary planned fallback."
  },
  {
    id: "resolve.ai-intellisearch",
    name: "AI IntelliSearch / Slate / Speech Generator",
    status: "restricted-free",
    implemented: false,
    milestone: "7",
    evidence: "Official README classifies these as Studio and AI scripting APIs that can return failure in Free and may require Extras downloads."
  },
  {
    id: "resolve.headless",
    name: "Headless Resolve (-nogui) driven from Node",
    status: "restricted-free",
    implemented: false,
    milestone: "6",
    evidence: "Headless external control depends on external scripting, which is unavailable in this Free installation."
  },
  {
    id: "media.ffmpeg",
    name: "FFmpeg/FFprobe metadata and thumbnails",
    status: "supported-untested",
    implemented: false,
    milestone: "7",
    evidence: "FFmpeg is not currently installed on PATH. A Python worker with imageio-ffmpeg or a documented FFmpeg install is planned."
  },
  {
    id: "media.opencv",
    name: "OpenCV frame analysis",
    status: "supported-untested",
    implemented: false,
    milestone: "7",
    evidence: "Python 3.12.10 is installed, but pip and OpenCV are missing; the worker dependencies have not been installed yet."
  },
  {
    id: "media.whisper",
    name: "Local Whisper transcription",
    status: "supported-untested",
    implemented: false,
    milestone: "7",
    evidence: "Python 3.12.10 is installed, but pip, faster-whisper and Whisper are missing."
  }
];

export function listCapabilities(): Capability[] {
  return CAPABILITIES.map((capability) => ({ ...capability }));
}

export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id);
}

export function summarizeCapabilities(): Record<CapabilityStatus, number> {
  const summary: Record<CapabilityStatus, number> = {
    verified: 0,
    "supported-untested": 0,
    "restricted-free": 0,
    unsupported: 0,
    "requires-manual-interaction": 0
  };
  for (const capability of CAPABILITIES) {
    summary[capability.status] += 1;
  }
  return summary;
}
