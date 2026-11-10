import path from "node:path";
import type { EditingPlanDraft } from "./editing-plan.js";

export interface AnalysisToPlanOptions {
  mediaId: string;
  timelineName?: string;
  projectName?: string;
  platform?: "instagram" | "youtube" | "tiktok" | "other";
  instruction?: string;
  maxEvents?: number;
}

const MAX_EVIDENCE_PER_CLIP = 50;
const MIN_EVENT_SPAN_SECONDS = 0.5;
const DEFAULT_CONFIDENCE_FOR_UNKNOWN = 0;

type PlanEvidence = EditingPlanDraft["clips"][number]["evidence"][number];

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toScore(value: unknown): number | null {
  const parsed = asFinite(value);
  return parsed === null ? null : Math.min(1, Math.max(0, parsed));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampSeconds(value: number, duration: number): number {
  return round3(Math.min(duration, Math.max(0, value)));
}

interface UsableEvent {
  start: number;
  end: number;
  event: Record<string, unknown>;
  description: string;
}

export function createPlanDraftFromAnalysis(
  analysis: unknown,
  options: AnalysisToPlanOptions
): EditingPlanDraft {
  if (typeof analysis !== "object" || analysis === null || Array.isArray(analysis)) {
    throw new Error("Analysis result must be the JSON object returned by resolve_analyze_media.");
  }
  const mediaId = typeof options.mediaId === "string" ? options.mediaId.trim() : "";
  if (!mediaId) throw new Error("A media pool mediaId is required to build the plan.");

  const media = (analysis as { media?: unknown }).media;
  if (typeof media !== "object" || media === null) {
    throw new Error("Analysis result is missing the media metadata object.");
  }
  const mediaObject = media as {
    path?: unknown;
    filename?: unknown;
    durationSeconds?: unknown;
    width?: unknown;
    height?: unknown;
    frameRate?: unknown;
    hasAudio?: unknown;
  };
  const duration = asFinite(mediaObject.durationSeconds);
  if (duration === null || duration <= 0) {
    throw new Error("Analysis media metadata is missing a positive durationSeconds.");
  }
  const filename = typeof mediaObject.filename === "string" && mediaObject.filename.trim()
    ? mediaObject.filename.trim()
    : typeof mediaObject.path === "string" && mediaObject.path.trim()
      ? path.basename(mediaObject.path.trim())
      : "";
  if (!filename) throw new Error("Analysis media metadata is missing both filename and path.");

  const rawEvents = (analysis as { events?: unknown }).events;
  if (!Array.isArray(rawEvents)) {
    throw new Error("Analysis result is missing an events array.");
  }

  if (options.maxEvents !== undefined
    && (!Number.isInteger(options.maxEvents) || options.maxEvents < 1)) {
    throw new Error("maxEvents must be a positive integer.");
  }
  const maxEvents = options.maxEvents === undefined
    ? Number.MAX_SAFE_INTEGER
    : options.maxEvents;

  const warnings: string[] = [
    "Event boundaries come from model-reported analysis and are converted to whole source frames at execution time; a moment shorter than one frame cannot be inserted, and boundary rounding can differ from the requested duration by up to one frame per segment."
  ];
  const clips: EditingPlanDraft["clips"] = [];
  let ignoredEvents = 0;
  let timelineStart = 0;

  const usable: UsableEvent[] = [];
  for (const raw of rawEvents) {
    if (typeof raw !== "object" || raw === null) { ignoredEvents += 1; continue; }
    const event = raw as Record<string, unknown>;
    const start = asFinite(event.start_time) ?? (asFinite(event.startTime));
    const end = asFinite(event.end_time) ?? (asFinite(event.endTime));
    const description = typeof event.description === "string" ? event.description.trim() : "";
    if (start === null || end === null || !description || start >= duration) {
      ignoredEvents += 1;
      continue;
    }
    usable.push({ start: Math.min(start, end), end: Math.max(start, end), event, description });
  }
  usable.sort((a, b) => a.start - b.start);

  for (const item of usable.slice(0, maxEvents)) {
    let start = clampSeconds(item.start, duration);
    let end = clampSeconds(item.end, duration);
    if (end - start < MIN_EVENT_SPAN_SECONDS) {
      end = round3(Math.min(duration, start + MIN_EVENT_SPAN_SECONDS));
      if (end - start < MIN_EVENT_SPAN_SECONDS) {
        start = round3(Math.max(0, end - MIN_EVENT_SPAN_SECONDS));
      }
      if (end - start < MIN_EVENT_SPAN_SECONDS) { ignoredEvents += 1; continue; }
    }

    const event = item.event;
    const confidence = toScore(event.confidence) ?? DEFAULT_CONFIDENCE_FOR_UNKNOWN;
    const precision = typeof event.boundary_precision === "string" ? event.boundary_precision : "approximate";
    const uncertainty = toFiniteSeconds(event.uncertainty_seconds);
    const category = typeof event.category === "string" ? event.category : "other";

    const evidence: PlanEvidence[] = [];
    if (Array.isArray(event.evidence)) {
      for (const raw of event.evidence) {
        if (evidence.length >= MAX_EVIDENCE_PER_CLIP) break;
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        const time = asFinite(entry.sourceTimeSeconds);
        const observation = typeof entry.observation === "string"
          ? entry.observation.trim()
          : typeof entry.description === "string" ? entry.description.trim() : "";
        if (time === null || time < 0 || time > duration || !observation) continue;
        evidence.push({
          kind: "frame",
          sourceTimeSeconds: round3(time),
          description: observation
        });
      }
    }

    const confidenceNote = toScore(event.confidence) === null
      ? " The model did not report a confidence value for this event (recorded as 0)."
      : "";
    clips.push({
      clipId: `event-${clips.length + 1}`,
      sourceMediaId: mediaId,
      sourceStartSeconds: start,
      sourceEndSeconds: end,
      timelineStartSeconds: round3(timelineStart),
      videoTrack: 1,
      description: item.description,
      relevance: confidence,
      confidence,
      reason:
        `Detected by two-pass vision analysis (category: ${category}, boundary: ${precision}` +
        (uncertainty !== null ? `, ±${uncertainty}s uncertainty` : "") +
        `). Source interval ${start}s..${end}s of ${filename}.` + confidenceNote,
      evidence
    });
    timelineStart += end - start;

    if (precision !== "exact") {
      warnings.push(
        `Event ${clips.length} "${item.description.slice(0, 80)}" has a ${precision} boundary` +
        (uncertainty !== null ? ` with about ±${uncertainty}s uncertainty` : "") +
        "; the planned in/out points may miss part of the real moment."
      );
    }
  }

  if (usable.length > maxEvents) {
    warnings.push(`Analysis reported ${usable.length} usable events; only the first ${maxEvents} were planned.`);
  }
  if (ignoredEvents > 0) {
    warnings.push(`${ignoredEvents} analysis events were ignored because they were malformed, empty or outside the media duration.`);
  }
  if (clips.length === 0) {
    throw new Error("No usable analysis events remain to build a plan.");
  }

  const mediaPoolItemData = {
    mediaId,
    filename,
    durationSeconds: duration,
    ...(asFinite(mediaObject.width) !== null ? { width: Math.trunc(mediaObject.width as number) } : {}),
    ...(asFinite(mediaObject.height) !== null ? { height: Math.trunc(mediaObject.height as number) } : {}),
    ...(asFinite(mediaObject.frameRate) !== null ? { frameRate: mediaObject.frameRate as number } : {}),
    ...(typeof mediaObject.hasAudio === "boolean" ? { hasAudio: mediaObject.hasAudio } : {})
  };

  return {
    request: {
      originalInstruction: options.instruction?.trim()
        || "Assemble a highlight timeline from two-pass media-analysis event boundaries.",
      purpose: options.instruction?.trim()
        || "Place analyzed events on the timeline in source order.",
      preserveOriginalOrder: true,
      excludedContent: []
    },
    project: {
      ...(options.projectName ? { projectName: options.projectName } : {}),
      timelineName: options.timelineName?.trim() || "Analysis Highlights",
      createNewTimeline: true,
      saveAfterExecution: true
    },
    sources: [mediaPoolItemData],
    clips,
    plannedDurationSeconds: round3(timelineStart),
    output: options.platform ? { platform: options.platform } : {},
    transitions: [],
    captions: [],
    audio: {},
    effects: [],
    warnings
  };
}

function toFiniteSeconds(value: unknown): number | null {
  const parsed = asFinite(value);
  return parsed === null || parsed < 0 ? null : round3(Math.min(parsed, 3600));
}
