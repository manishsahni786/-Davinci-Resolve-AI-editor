import type { EditingPlan } from "./editing-plan.js";
import type { ExecutionPreparation, PreparedSegment } from "./execution-plan.js";

export interface InspectedTimelineItem {
  name?: unknown;
  start?: unknown;
  finish?: unknown;
  duration?: unknown;
  sourceStartFrame?: unknown;
  sourceEndFrame?: unknown;
  trackType?: unknown;
  trackIndex?: unknown;
}

export interface InspectedTimelineTrack {
  index?: unknown;
  name?: unknown;
  itemCount?: unknown;
  items?: unknown;
}

export interface InspectedTimeline {
  timeline?: {
    name?: unknown;
    startFrame?: unknown;
    endFrame?: unknown;
  };
  tracks?: {
    video?: unknown;
    audio?: unknown;
    subtitle?: unknown;
  };
}

export interface VerificationResult {
  ok: boolean;
  issues: string[];
  checkedItems: number;
}

const FRAME_TOLERANCE = 1;

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asItems(value: unknown): InspectedTimelineItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value as InspectedTimelineItem[];
}

function asTrackList(value: unknown): InspectedTimelineTrack[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value as InspectedTimelineTrack[];
}

/**
 * Verifies a timeline.inspect response against the approved plan and its
 * prepared frame segments. Timeline start offsets (for example a project
 * starting at 01:00:00:00) are tolerated by comparing positions relative to
 * the first item on each track; source in/out frames, per-track item counts,
 * contiguity and total duration are checked exactly within one frame.
 */
export function verifyTimelineInspection(
  plan: EditingPlan,
  preparation: ExecutionPreparation,
  inspection: InspectedTimeline | null | undefined
): VerificationResult {
  const issues: string[] = [];
  let checkedItems = 0;

  if (!inspection) {
    return { ok: false, issues: ["No timeline inspection result is available."], checkedItems };
  }
  if (inspection.timeline?.name !== plan.project.timelineName) {
    issues.push(`Inspected timeline name is ${String(inspection.timeline?.name)}, expected ${plan.project.timelineName}.`);
  }

  const videoTracks = asTrackList(inspection.tracks?.video);
  if (videoTracks === null) {
    return { ok: false, issues: [...issues, "The inspection did not include video tracks."], checkedItems };
  }

  const expectedByTrack = new Map<number, PreparedSegment[]>();
  for (const segment of preparation.segments) {
    const list = expectedByTrack.get(segment.trackIndex) ?? [];
    list.push(segment);
    expectedByTrack.set(segment.trackIndex, list);
  }

  const allActualEnds: number[] = [];
  const allActualStarts: number[] = [];

  for (const [trackIndex, expected] of expectedByTrack) {
    const track = videoTracks.find((candidate) => numeric(candidate.index) === trackIndex);
    if (!track) {
      issues.push(`Video track ${trackIndex} is missing from the inspected timeline.`);
      continue;
    }
    if (numeric(track.itemCount) !== expected.length) {
      issues.push(`Video track ${trackIndex} has ${String(track.itemCount)} items, expected ${expected.length}.`);
    }
    const items = asItems(track.items);
    if (items === null || items.length !== expected.length) {
      issues.push(`Video track ${trackIndex} inspection did not return ${expected.length} item summaries.`);
      continue;
    }

    const baseExpected = expected[0]!.recordFrame;
    const firstStart = numeric(items[0]?.start);
    if (firstStart === null) {
      issues.push(`Video track ${trackIndex} item 1 has no readable start frame.`);
      continue;
    }

    for (let index = 0; index < expected.length; index += 1) {
      const want = expected[index]!;
      const item = items[index]!;
      const start = numeric(item.start);
      const finish = numeric(item.finish);
      const duration = numeric(item.duration);
      if (start === null || finish === null || duration === null) {
        issues.push(`Video track ${trackIndex} item ${index + 1} has unreadable timing.`);
        continue;
      }
      checkedItems += 1;
      allActualStarts.push(start);
      allActualEnds.push(finish);

      const relativeActual = start - firstStart;
      const relativeExpected = want.recordFrame - baseExpected;
      if (Math.abs(relativeActual - relativeExpected) > FRAME_TOLERANCE) {
        issues.push(
          `Video track ${trackIndex} item ${index + 1} starts at relative frame ${relativeActual}, expected ${relativeExpected}.`
        );
      }
      if (Math.abs(duration - want.durationFrames) > FRAME_TOLERANCE) {
        issues.push(
          `Video track ${trackIndex} item ${index + 1} lasts ${duration} frames, expected ${want.durationFrames}.`
        );
      }
      if (preparation.mode === "ranges") {
        const sourceStart = numeric(item.sourceStartFrame);
        const sourceEnd = numeric(item.sourceEndFrame);
        if (sourceStart === null || sourceEnd === null) {
          issues.push(
            `Video track ${trackIndex} item ${index + 1} did not report source in/out frames; trimmed placement cannot be verified.`
          );
        } else if (sourceStart !== want.startFrame || sourceEnd !== want.endFrameExclusive) {
          issues.push(
            `Video track ${trackIndex} item ${index + 1} used source frames ${sourceStart}..${sourceEnd}, expected ${want.startFrame}..${want.endFrameExclusive}.`
          );
        }
      }
      if (index > 0) {
        const previousFinish = numeric(items[index - 1]?.finish);
        if (previousFinish !== null && Math.abs(start - previousFinish) > FRAME_TOLERANCE) {
          issues.push(
            `Video track ${trackIndex} has a gap or overlap before item ${index + 1}: previous ended at ${previousFinish}, next starts at ${start}.`
          );
        }
      }
    }
  }

  // Linked source audio is only required for clips whose source is known to
  // carry audio. Silent or unknown sources stay video-only without failing.
  const audioSegments = preparation.segments.filter((segment) => segment.includeAudio
    && plan.sources.find((source) => source.mediaId === segment.mediaId)?.hasAudio === true);
  if (preparation.mode === "ranges" && audioSegments.length > 0) {
    const audioTracks = asTrackList(inspection.tracks?.audio);
    if (audioTracks === null) {
      issues.push("The inspection did not include audio tracks, so linked source audio cannot be verified.");
    } else {
      const track = audioTracks.find((candidate) => numeric(candidate.index) === 1);
      if (!track) {
        issues.push("Audio track 1 is missing from the inspected timeline.");
      } else {
        const items = asItems(track.items);
        if (numeric(track.itemCount) !== audioSegments.length) {
          issues.push(`Audio track 1 has ${String(track.itemCount)} items, expected ${audioSegments.length}.`);
        }
        if (items === null || items.length !== audioSegments.length) {
          issues.push(`Audio track 1 inspection did not return ${audioSegments.length} item summaries.`);
        } else {
          const baseExpected = audioSegments[0]!.recordFrame;
          const firstStart = numeric(items[0]?.start);
          if (firstStart === null) {
            issues.push("Audio track 1 item 1 has no readable start frame.");
          } else {
            for (let index = 0; index < audioSegments.length; index += 1) {
              const want = audioSegments[index]!;
              const item = items[index]!;
              const start = numeric(item.start);
              const duration = numeric(item.duration);
              if (start === null || duration === null) {
                issues.push(`Audio track 1 item ${index + 1} has unreadable timing.`);
                continue;
              }
              checkedItems += 1;
              const relativeActual = start - firstStart;
              const relativeExpected = want.recordFrame - baseExpected;
              if (Math.abs(relativeActual - relativeExpected) > FRAME_TOLERANCE) {
                issues.push(`Audio track 1 item ${index + 1} starts at relative frame ${relativeActual}, expected ${relativeExpected}.`);
              }
              if (Math.abs(duration - want.durationFrames) > FRAME_TOLERANCE) {
                issues.push(`Audio track 1 item ${index + 1} lasts ${duration} frames, expected ${want.durationFrames}.`);
              }
              const sourceStart = numeric(item.sourceStartFrame);
              const sourceEnd = numeric(item.sourceEndFrame);
              if (sourceStart !== null && sourceEnd !== null
                && (sourceStart !== want.startFrame || sourceEnd !== want.endFrameExclusive)) {
                issues.push(
                  `Audio track 1 item ${index + 1} used source frames ${sourceStart}..${sourceEnd}, expected ${want.startFrame}..${want.endFrameExclusive}.`
                );
              }
            }
          }
        }
      }
    }
  }

  if (preparation.mode === "ranges" && preparation.segments.length > 0) {
    if (allActualStarts.length > 0) {
      const expectedTotal = Math.max(...preparation.segments.map((segment) => segment.recordFrame + segment.durationFrames))
        - Math.min(...preparation.segments.map((segment) => segment.recordFrame));
      const actualTotal = Math.max(...allActualEnds) - Math.min(...allActualStarts);
      const allowance = Math.max(FRAME_TOLERANCE, plan.clips.length);
      if (Math.abs(actualTotal - expectedTotal) > allowance) {
        issues.push(`Inspected timeline duration is ${actualTotal} frames, expected ${expectedTotal} frames.`);
      }
    }
    const timelineStart = numeric(inspection.timeline?.startFrame);
    const timelineEnd = numeric(inspection.timeline?.endFrame);
    // Resolve Free 21.1 can report Timeline.GetEndFrame() as the start-timecode
    // frame (216000 for a timeline starting at 01:00:00:00), so only trust the
    // reported span when it is non-degenerate. Item-level timing is authoritative.
    if (timelineStart !== null && timelineEnd !== null && timelineEnd > timelineStart && allActualStarts.length > 0) {
      const expectedTotal = Math.max(...preparation.segments.map((segment) => segment.recordFrame + segment.durationFrames))
        - Math.min(...preparation.segments.map((segment) => segment.recordFrame));
      if (Math.abs((timelineEnd - timelineStart) - expectedTotal) > Math.max(FRAME_TOLERANCE, plan.clips.length)) {
        issues.push(`Inspected timeline span is ${timelineEnd - timelineStart} frames, expected ${expectedTotal} frames.`);
      }
    }
  }

  return { ok: issues.length === 0, issues: [...new Set(issues)], checkedItems };
}
