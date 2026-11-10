import { describe, expect, it } from "vitest";
import { createEditingPlan } from "../src/planning/editing-plan.js";
import { prepareExecution, type PreparedSegment } from "../src/planning/execution-plan.js";
import { verifyTimelineInspection, type InspectedTimeline } from "../src/planning/execution-verification.js";

function clip(overrides: Record<string, unknown>) {
  return {
    sourceMediaId: "parkour",
    sourceStartSeconds: 0,
    sourceEndSeconds: 15,
    timelineStartSeconds: 0,
    videoTrack: 1,
    description: "Selected moment",
    relevance: 0.9,
    confidence: 0.8,
    reason: "Matched the requested content.",
    evidence: [{ kind: "user-selected", sourceTimeSeconds: 0, description: "User selected this interval." }],
    ...overrides
  };
}

function makePlan() {
  return createEditingPlan({
    request: { originalInstruction: "Build a 90 second reel." },
    project: { timelineName: "Reel 90" },
    sources: [
      { mediaId: "parkour", filename: "parkour.mp4", durationSeconds: 60, frameRate: 30 },
      { mediaId: "frost", filename: "frosthandler.mp4", durationSeconds: 120, frameRate: 30 },
      { mediaId: "rais", filename: "rais.mp4", durationSeconds: 90, frameRate: 30 }
    ],
    clips: [
      clip({ clipId: "parkour-1", sourceMediaId: "parkour", sourceStartSeconds: 0, sourceEndSeconds: 15, timelineStartSeconds: 0 }),
      clip({ clipId: "frost-1", sourceMediaId: "frost", sourceStartSeconds: 10, sourceEndSeconds: 45, timelineStartSeconds: 15 }),
      clip({ clipId: "rais-1", sourceMediaId: "rais", sourceStartSeconds: 0, sourceEndSeconds: 40, timelineStartSeconds: 50 })
    ],
    requestedDurationSeconds: 90,
    plannedDurationSeconds: 90,
    output: { frameRate: 30 }
  }, "plan-90");
}

function inspection(segments: PreparedSegment[], offset = 0): InspectedTimeline {
  const items = segments.map((segment) => ({
    name: segment.clipId,
    start: offset + segment.recordFrame,
    finish: offset + segment.recordFrame + segment.durationFrames,
    duration: segment.durationFrames,
    sourceStartFrame: segment.startFrame,
    sourceEndFrame: segment.endFrameExclusive,
    trackIndex: segment.trackIndex
  }));
  return {
    timeline: { name: "Reel 90", startFrame: offset, endFrame: offset + 2700 },
    tracks: { video: [{ index: 1, itemCount: items.length, items }] }
  };
}

function makeAudioPlan() {
  return createEditingPlan({
    request: { originalInstruction: "Build a 90 second reel." },
    project: { timelineName: "Reel 90" },
    sources: [
      { mediaId: "parkour", filename: "parkour.mp4", durationSeconds: 60, frameRate: 30, hasAudio: true },
      { mediaId: "frost", filename: "frosthandler.mp4", durationSeconds: 120, frameRate: 30, hasAudio: true },
      { mediaId: "rais", filename: "rais.mp4", durationSeconds: 90, frameRate: 30, hasAudio: true }
    ],
    clips: [
      clip({ clipId: "parkour-1", sourceMediaId: "parkour", sourceStartSeconds: 0, sourceEndSeconds: 15, timelineStartSeconds: 0 }),
      clip({ clipId: "frost-1", sourceMediaId: "frost", sourceStartSeconds: 10, sourceEndSeconds: 45, timelineStartSeconds: 15 }),
      clip({ clipId: "rais-1", sourceMediaId: "rais", sourceStartSeconds: 0, sourceEndSeconds: 40, timelineStartSeconds: 50 })
    ],
    requestedDurationSeconds: 90,
    plannedDurationSeconds: 90,
    output: { frameRate: 30 }
  }, "plan-audio");
}

function audioInspection(segments: PreparedSegment[], offset = 0): InspectedTimeline {
  const base = inspection(segments, offset);
  const audioSegments = segments.filter((segment) => segment.includeAudio);
  const items = audioSegments.map((segment) => ({
    name: segment.clipId,
    start: offset + segment.recordFrame,
    finish: offset + segment.recordFrame + segment.durationFrames,
    duration: segment.durationFrames,
    sourceStartFrame: segment.startFrame,
    sourceEndFrame: segment.endFrameExclusive,
    trackIndex: 1
  }));
  return {
    ...base,
    tracks: { ...base.tracks, audio: [{ index: 1, itemCount: items.length, items }] }
  };
}

describe("timeline execution verification", () => {
  it("accepts a matching timeline, including a non-zero project start offset", () => {
    const plan = makePlan();
    const preparation = prepareExecution(plan);
    const result = verifyTimelineInspection(plan, preparation, inspection(preparation.segments, 108000));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedItems).toBe(3);
  });

  it("ignores a degenerate reported timeline span such as 216000..216000", () => {
    const plan = makePlan();
    const preparation = prepareExecution(plan);
    const wrong = inspection(preparation.segments, 216000);
    wrong.timeline = { name: "Reel 90", startFrame: 216000, endFrame: 216000 };
    const result = verifyTimelineInspection(plan, preparation, wrong);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects the wrong timeline name", () => {
    const plan = makePlan();
    const preparation = prepareExecution(plan);
    const wrong = inspection(preparation.segments);
    wrong.timeline = { ...wrong.timeline, name: "Some Other Timeline" };
    const result = verifyTimelineInspection(plan, preparation, wrong);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("Some Other Timeline");
  });

  it("rejects incorrect source in/out frames", () => {
    const plan = makePlan();
    const preparation = prepareExecution(plan);
    const wrong = inspection(preparation.segments);
    const items = (wrong.tracks?.video as Array<{ items: Array<Record<string, unknown>> }>)[0]!.items;
    items[1]!.sourceStartFrame = 0;
    const result = verifyTimelineInspection(plan, preparation, wrong);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("expected 300..1350");
  });

  it("rejects gaps between adjacent items", () => {
    const plan = makePlan();
    const preparation = prepareExecution(plan);
    const wrong = inspection(preparation.segments);
    const items = (wrong.tracks?.video as Array<{ items: Array<Record<string, unknown>> }>)[0]!.items;
    items[2]!.start = 1502;
    items[2]!.finish = 2702;
    const result = verifyTimelineInspection(plan, preparation, wrong);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("gap or overlap");
  });

  it("rejects a different inserted duration", () => {
    const plan = makePlan();
    const preparation = prepareExecution(plan);
    const wrong = inspection(preparation.segments);
    const items = (wrong.tracks?.video as Array<{ items: Array<Record<string, unknown>> }>)[0]!.items;
    items[0]!.duration = 440;
    items[0]!.finish = 440;
    const result = verifyTimelineInspection(plan, preparation, wrong);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("lasts 440 frames, expected 450");
  });

  it("rejects an inspection without item summaries", () => {
    const plan = makePlan();
    const preparation = prepareExecution(plan);
    const result = verifyTimelineInspection(plan, preparation, {
      timeline: { name: "Reel 90" },
      tracks: { video: [{ index: 1, itemCount: 3 }] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("did not return 3 item summaries");
  });

  it("accepts linked source audio on A1 when the plan expects it", () => {
    const plan = makeAudioPlan();
    const preparation = prepareExecution(plan);
    const result = verifyTimelineInspection(plan, preparation, audioInspection(preparation.segments));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedItems).toBe(6);
  });

  it("rejects a missing A1 audio item", () => {
    const plan = makeAudioPlan();
    const preparation = prepareExecution(plan);
    const wrong = audioInspection(preparation.segments);
    const audio = (wrong.tracks?.audio as Array<{ items: Array<Record<string, unknown>>; itemCount: number }>)[0]!;
    audio.items = audio.items.slice(0, 2);
    audio.itemCount = 2;
    const result = verifyTimelineInspection(plan, preparation, wrong);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("Audio track 1 has 2 items, expected 3");
  });

  it("rejects audio items with the wrong source range", () => {
    const plan = makeAudioPlan();
    const preparation = prepareExecution(plan);
    const wrong = audioInspection(preparation.segments);
    const audio = (wrong.tracks?.audio as Array<{ items: Array<Record<string, unknown>> }>)[0]!;
    audio.items[1]!.sourceStartFrame = 0;
    const result = verifyTimelineInspection(plan, preparation, wrong);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("Audio track 1 item 2 used source frames");
  });
});
