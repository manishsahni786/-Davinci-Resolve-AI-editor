import type { EditingPlan } from "./editing-plan.js";
import {
  FrameTimingError,
  parseFrameRate,
  planSegmentFrames,
  secondsToFrame,
  secondsToFrameCapacity,
  type FrameRate
} from "./frame-timing.js";

export interface PreparedSegment {
  clipId: string;
  mediaId: string;
  trackIndex: number;
  startFrame: number;
  endFrameExclusive: number;
  durationFrames: number;
  recordFrame: number;
  /** Linked source audio is placed on A1 for video-track-1 segments. */
  includeAudio: boolean;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  timelineStartSeconds: number;
}

export interface ExecutionPreparation {
  mode: "whole-clip" | "ranges";
  timelineFrameRate: FrameRate | null;
  segments: PreparedSegment[];
  issues: string[];
}

const SECONDS_TOLERANCE = 0.001;

function unsupportedTreatmentIssues(plan: EditingPlan): string[] {
  const issues: string[] = [];
  if (!plan.project.createNewTimeline) {
    issues.push("Execution currently supports creating a new timeline only.");
  }
  if (plan.transitions.length > 0) issues.push("Transitions are not implemented.");
  if (plan.captions.length > 0) issues.push("Captions and subtitles are not implemented.");
  if (plan.effects.length > 0) issues.push("Timeline effects are not implemented.");
  if (Object.keys(plan.audio).length > 0) issues.push("Audio mixing is not implemented.");
  const outputOptions = [
    "aspectRatio", "width", "height", "renderFormat", "codec", "quality", "outputPath"
  ] as const;
  if (outputOptions.some((key) => plan.output[key] !== undefined)) {
    issues.push("Output formatting and rendering are not implemented.");
  }
  return issues;
}

/**
 * Pure pre-execution validation and frame preparation. Rejects unsupported
 * treatments, invalid source references, sub-frame ranges, out-of-bounds
 * ranges, gaps/overlaps per video track and duration mismatches before any
 * Resolve request is queued. Multi-track or trimmed plans execute as explicit
 * source ranges; only fully whole, single-track plans use the legacy
 * `timeline.create` media-id path.
 */
export function prepareExecution(plan: EditingPlan): ExecutionPreparation {
  const issues = unsupportedTreatmentIssues(plan);

  let timelineFrameRate: FrameRate | null = null;
  const configuredTimelineRate = plan.output.frameRate
    ?? plan.sources.find((source) => source.frameRate !== undefined)?.frameRate;
  if (configuredTimelineRate !== undefined) {
    try {
      timelineFrameRate = parseFrameRate(configuredTimelineRate);
    } catch (error) {
      issues.push(error instanceof FrameTimingError ? error.message : `Invalid timeline frame rate: ${String(configuredTimelineRate)}`);
    }
  }

  let hasTrimmedClip = false;
  let multiTrack = false;
  for (const clip of plan.clips) {
    if (clip.audioTrack !== undefined && clip.audioTrack !== 1) {
      issues.push(`Clip ${clip.clipId} requests audio track ${clip.audioTrack}; linked source audio is only placed on A1.`);
    }
    if (clip.videoTrack !== 1) {
      multiTrack = true;
    }
    const source = plan.sources.find((candidate) => candidate.mediaId === clip.sourceMediaId);
    if (!source) {
      issues.push(`Source ${clip.sourceMediaId} is missing from the plan.`);
      continue;
    }
    if (clip.sourceStartSeconds > SECONDS_TOLERANCE
      || clip.sourceEndSeconds < source.durationSeconds - SECONDS_TOLERANCE) {
      hasTrimmedClip = true;
    }
  }

  const useRanges = hasTrimmedClip || multiTrack;
  if (useRanges && timelineFrameRate === null) {
    issues.push("A timeline frame rate is required (set output.frameRate or a source frameRate) to place trimmed or multi-track source ranges.");
  }
  if (useRanges && plan.sources.some((source) => source.frameRate === undefined)) {
    issues.push("Every source needs a frameRate to place trimmed or multi-track source ranges.");
  }

  const segments: PreparedSegment[] = [];
  const expectedByTrack = new Map<number, number>();
  let totalEndFrame = 0;
  let earliestRecordFrame: number | null = null;

  if (!useRanges || issues.length === 0) {
    for (const clip of plan.clips) {
      const source = plan.sources.find((candidate) => candidate.mediaId === clip.sourceMediaId);
      if (!source) {
        continue;
      }
      const sourceFrameRate = source.frameRate === undefined ? null : parseFrameRate(source.frameRate);
      const clipTrimmed = clip.sourceStartSeconds > SECONDS_TOLERANCE
        || clip.sourceEndSeconds < source.durationSeconds - SECONDS_TOLERANCE;

      let frames;
      try {
        if (clipTrimmed) {
          if (sourceFrameRate === null || timelineFrameRate === null || configuredTimelineRate === undefined) {
            issues.push(`Clip ${clip.clipId} cannot be trimmed without source and timeline frame rates.`);
            continue;
          }
          frames = planSegmentFrames({
            sourceStartSeconds: clip.sourceStartSeconds,
            sourceEndSeconds: clip.sourceEndSeconds,
            timelineStartSeconds: clip.timelineStartSeconds,
            sourceFrameRate: source.frameRate as number,
            timelineFrameRate: configuredTimelineRate
          });
          const capacity = secondsToFrameCapacity(source.durationSeconds, sourceFrameRate);
          if (frames.sourceEndFrameExclusive > capacity) {
            issues.push(
              `Clip ${clip.clipId} ends at source frame ${frames.sourceEndFrameExclusive}, beyond the ${capacity}-frame extent of ${source.filename}.`
            );
            continue;
          }
        } else {
          if (sourceFrameRate === null || timelineFrameRate === null) {
            // Whole-clip legacy execution does not need frame values.
            continue;
          }
          const durationFrames = secondsToFrameCapacity(source.durationSeconds, sourceFrameRate);
          frames = {
            sourceStartFrame: 0,
            sourceEndFrameExclusive: durationFrames,
            durationFrames,
            recordFrame: secondsToFrame(clip.timelineStartSeconds, timelineFrameRate)
          };
        }
      } catch (error) {
        issues.push(error instanceof FrameTimingError ? `${clip.clipId}: ${error.message}` : `Clip ${clip.clipId} could not be converted to frames.`);
        continue;
      }

      const expectedStart = expectedByTrack.get(clip.videoTrack);
      if (expectedStart !== undefined && frames.recordFrame !== expectedStart) {
        issues.push(
          `Clip ${clip.clipId} has a gap or overlap on video track ${clip.videoTrack}: expected record frame ${expectedStart}, got ${frames.recordFrame}.`
        );
      }
      expectedByTrack.set(clip.videoTrack, frames.recordFrame + frames.durationFrames);
      totalEndFrame = Math.max(totalEndFrame, frames.recordFrame + frames.durationFrames);
      earliestRecordFrame = earliestRecordFrame === null
        ? frames.recordFrame
        : Math.min(earliestRecordFrame, frames.recordFrame);

      segments.push({
        clipId: clip.clipId,
        mediaId: clip.sourceMediaId,
        trackIndex: clip.videoTrack,
        startFrame: frames.sourceStartFrame,
        endFrameExclusive: frames.sourceEndFrameExclusive,
        durationFrames: frames.durationFrames,
        recordFrame: frames.recordFrame,
        includeAudio: clip.videoTrack === 1 && source.hasAudio !== false,
        sourceStartSeconds: clip.sourceStartSeconds,
        sourceEndSeconds: clip.sourceEndSeconds,
        timelineStartSeconds: clip.timelineStartSeconds
      });
    }
  }

  if (useRanges && segments.length !== plan.clips.length) {
    issues.push("Not every planned clip could be converted to an executable source range.");
  }
  if (useRanges && earliestRecordFrame !== null && earliestRecordFrame !== 0) {
    issues.push(`Range execution must start at timeline frame 0 (first clip starts at ${earliestRecordFrame}).`);
  }

  if (useRanges && timelineFrameRate !== null && segments.length > 0) {
    const expectedTotalFrames = secondsToFrame(plan.plannedDurationSeconds, timelineFrameRate);
    const frameAllowance = Math.max(1, plan.clips.length);
    if (Math.abs(totalEndFrame - expectedTotalFrames) > frameAllowance) {
      issues.push(
        `Frame-based timeline duration is ${totalEndFrame} frames but the plan targets ${expectedTotalFrames} frames (allowance ${frameAllowance}).`
      );
    }
  }

  if (plan.requestedDurationSeconds !== undefined
    && Math.abs(plan.requestedDurationSeconds - plan.plannedDurationSeconds) > 0.05
    && plan.acceptedDurationSeconds === undefined) {
    issues.push(`Requested duration is ${plan.requestedDurationSeconds}s, but the proposed plan is ${plan.plannedDurationSeconds}s. Resolve the shortfall or overrun with the user before execution.`);
  }
  if (plan.acceptedDurationSeconds !== undefined
    && Math.abs(plan.acceptedDurationSeconds - plan.plannedDurationSeconds) > 0.05) {
    issues.push(`The explicitly accepted duration is ${plan.acceptedDurationSeconds}s, but the plan is ${plan.plannedDurationSeconds}s.`);
  }

  return {
    mode: useRanges ? "ranges" : "whole-clip",
    timelineFrameRate,
    segments,
    issues: [...new Set(issues)]
  };
}
