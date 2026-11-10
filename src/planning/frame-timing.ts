/**
 * Frame-accurate timestamp conversion for source-range timeline editing.
 *
 * Resolve's AppendToTimeline/CreateTimelineFromClips clip info uses
 * `startFrame` and `endFrame` in a MediaPoolItem's own frame units. This module
 * keeps one internal convention:
 *
 *   - `sourceStartFrame`          inclusive source frame
 *   - `sourceEndFrameExclusive`   exclusive source frame (one past the last frame)
 *   - `durationFrames = sourceEndFrameExclusive - sourceStartFrame`
 *
 * A live Resolve Free 21.1 run showed that `AppendToTimeline` clip-info
 * `endFrame` is exclusive as well: sending start 1200 / end 1799 produced an
 * item with duration 599 and `GetSourceEndFrame() == 1799`. The bridge therefore
 * passes `sourceEndFrameExclusive` through unchanged. (The inclusive wording in
 * the shipped `7_add_subclips_to_timeline.py` example applies to
 * `MediaPoolItem.AddSubClip`, not to `AppendToTimeline`.)
 *
 * Frame rates are represented as integer rationals so repeated conversions do
 * not accumulate floating-point drift. NTSC-family rates are snapped to their
 * exact 1000/1001 rationals.
 */

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export class FrameTimingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FrameTimingError";
    this.code = code;
  }
}

const NTSC_RATES: ReadonlyArray<{ value: number; rate: FrameRate }> = [
  { value: 23.976, rate: { numerator: 24000, denominator: 1001 } },
  { value: 23.98, rate: { numerator: 24000, denominator: 1001 } },
  { value: 29.97, rate: { numerator: 30000, denominator: 1001 } },
  { value: 47.952, rate: { numerator: 48000, denominator: 1001 } },
  { value: 59.94, rate: { numerator: 60000, denominator: 1001 } },
  { value: 119.88, rate: { numerator: 120000, denominator: 1001 } }
];

const NTSC_TOLERANCE = 0.005;
const DECIMAL_SCALE = 1_000_000;

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0 ? 1 : a;
}

function reduce(numerator: number, denominator: number): FrameRate {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor
  };
}

/**
 * Parses a frame rate expressed as a number or decimal string into an integer
 * rational. Recognizes the common NTSC fractional rates exactly.
 */
export function parseFrameRate(value: number | string): FrameRate {
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new FrameTimingError("INVALID_FRAME_RATE", `Invalid frame rate: ${String(value)}`);
  }
  if (Math.abs(numeric - Math.round(numeric)) <= 1e-6) {
    return { numerator: Math.round(numeric), denominator: 1 };
  }
  for (const candidate of NTSC_RATES) {
    if (Math.abs(numeric - candidate.value) <= NTSC_TOLERANCE) {
      return { ...candidate.rate };
    }
  }
  const scaled = Math.round(numeric * DECIMAL_SCALE);
  if (scaled <= 0) {
    throw new FrameTimingError("INVALID_FRAME_RATE", `Invalid frame rate: ${String(value)}`);
  }
  return reduce(scaled, DECIMAL_SCALE);
}

export function frameRateToNumber(rate: FrameRate): number {
  return rate.numerator / rate.denominator;
}

export function formatFrameRate(rate: FrameRate): string {
  return `${rate.numerator}/${rate.denominator}`;
}

/** Converts seconds to the nearest frame index using integer rational math. */
export function secondsToFrame(seconds: number, rate: FrameRate): number {
  if (!Number.isFinite(seconds)) {
    throw new FrameTimingError("INVALID_TIMESTAMP", `Invalid timestamp: ${String(seconds)}`);
  }
  const scaled = seconds * rate.numerator;
  return Math.round(scaled / rate.denominator);
}

/**
 * Converts a duration in seconds to a whole number of frames, rounding down.
 * Used to bound a media item's available frame extent.
 */
export function secondsToFrameCapacity(seconds: number, rate: FrameRate): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new FrameTimingError("INVALID_TIMESTAMP", `Invalid duration: ${String(seconds)}`);
  }
  const scaled = (seconds * rate.numerator) / rate.denominator;
  return Math.floor(scaled + 1e-9);
}

export function frameToSeconds(frame: number, rate: FrameRate): number {
  return (frame * rate.denominator) / rate.numerator;
}

export interface SegmentFrameInput {
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  timelineStartSeconds: number;
  sourceFrameRate: number | string;
  timelineFrameRate: number | string;
}

export interface SegmentFramePlan {
  sourceFrameRate: FrameRate;
  timelineFrameRate: FrameRate;
  sourceStartFrame: number;
  sourceEndFrameExclusive: number;
  durationFrames: number;
  requestedDurationFrames: number;
  recordFrame: number;
}

/**
 * Converts a second-based source interval and timeline position into frame
 * values. Throws FrameTimingError when the interval is invalid, shorter than a
 * frame, or rounds to a duration that disagrees with the requested duration by
 * more than one frame.
 *
 * `sourceEndFrameExclusive` is passed to Resolve unchanged: a live Resolve Free
 * 21.1 run showed `MediaPool.AppendToTimeline` clip-info `endFrame` is exclusive
 * (start 1200 + end 1799 produced 599 frames), so no off-by-one adjustment is
 * applied at the bridge.
 */
export function planSegmentFrames(input: SegmentFrameInput): SegmentFramePlan {
  const { sourceStartSeconds, sourceEndSeconds, timelineStartSeconds } = input;
  if (!Number.isFinite(sourceStartSeconds) || sourceStartSeconds < 0) {
    throw new FrameTimingError("INVALID_SOURCE_START", "Source start must be a non-negative number.");
  }
  if (!Number.isFinite(sourceEndSeconds) || sourceEndSeconds <= sourceStartSeconds) {
    throw new FrameTimingError("INVALID_SOURCE_RANGE", "Source end must be greater than source start.");
  }
  if (!Number.isFinite(timelineStartSeconds) || timelineStartSeconds < 0) {
    throw new FrameTimingError("INVALID_TIMELINE_POSITION", "Timeline position must be a non-negative number.");
  }

  const sourceFrameRate = parseFrameRate(input.sourceFrameRate);
  const timelineFrameRate = parseFrameRate(input.timelineFrameRate);

  const sourceStartFrame = secondsToFrame(sourceStartSeconds, sourceFrameRate);
  const sourceEndFrameExclusive = secondsToFrame(sourceEndSeconds, sourceFrameRate);
  const durationFrames = sourceEndFrameExclusive - sourceStartFrame;
  if (durationFrames < 1) {
    throw new FrameTimingError(
      "RANGE_TOO_SHORT",
      `Source range ${sourceStartSeconds}s..${sourceEndSeconds}s is shorter than one frame at ${formatFrameRate(sourceFrameRate)} fps.`
    );
  }

  const requestedDurationFrames =
    ((sourceEndSeconds - sourceStartSeconds) * sourceFrameRate.numerator) / sourceFrameRate.denominator;
  if (Math.abs(durationFrames - requestedDurationFrames) > 1) {
    throw new FrameTimingError(
      "DURATION_ROUNDING_MISMATCH",
      `Source range ${sourceStartSeconds}s..${sourceEndSeconds}s rounds to ${durationFrames} frames but the requested duration is ${requestedDurationFrames.toFixed(3)} frames.`
    );
  }

  const recordFrame = secondsToFrame(timelineStartSeconds, timelineFrameRate);
  return {
    sourceFrameRate,
    timelineFrameRate,
    sourceStartFrame,
    sourceEndFrameExclusive,
    durationFrames,
    requestedDurationFrames,
    recordFrame
  };
}

/** Tolerance used when comparing frame counts derived from different paths. */
export function frameTolerance(rate: FrameRate): number {
  return 1 / frameRateToNumber(rate);
}
