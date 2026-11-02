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
    notes: "Node writes next.request.json and next.request.lua. Lua reads the request with loadfile and publishes the response through Fusion prefs because io is unavailable. Processed ids are retained for idempotent replay, and early transport failures are published through Fusion prefs. Manual menu trigger is still required."
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
    id: "bridge.background-polling",
    name: "Continuous background command polling inside Resolve",
    status: "unsupported",
    implemented: false,
    milestone: "1",
    evidence: "Resolve executes menu Lua scripts synchronously on the UI thread; no supported idle/background callback was found in the 21.1 scripting API.",
    notes: "A loop would freeze the Resolve UI. The bridge therefore uses a manually triggered processor."
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
    status: "supported-untested",
    implemented: false,
    milestone: "4",
    evidence: "ProjectManager methods are present in DaVinciResolveScript.pyi for 21.1.",
    notes: "To be verified inside the Free app during Milestone 4."
  },
  {
    id: "resolve.media-import",
    name: "Media import and media pool inspection",
    status: "supported-untested",
    implemented: false,
    milestone: "4",
    evidence: "MediaPool.ImportMedia and Folder.GetClipList exist in the 21.1 API definition."
  },
  {
    id: "resolve.timeline-editing",
    name: "Timeline creation and clip manipulation",
    status: "supported-untested",
    implemented: false,
    milestone: "5",
    evidence: "MediaPool.CreateEmptyTimeline/CreateTimelineFromClips, Timeline.DeleteClips, TimelineItem.SetProperties and TimelineItem.AddTransition exist in the 21.1 API definition.",
    notes: "AddTransition is new in 21.1 and must be verified in Free."
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
