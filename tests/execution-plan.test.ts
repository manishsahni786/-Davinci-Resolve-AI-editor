import { describe, expect, it } from "vitest";
import { createEditingPlan } from "../src/planning/editing-plan.js";
import { prepareExecution } from "../src/planning/execution-plan.js";

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

function draft(overrides: Record<string, unknown> = {}) {
  return {
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
    output: { frameRate: 30 },
    ...overrides
  };
}

describe("execution preparation", () => {
  it("prepares frame-accurate segments for a 90 second three-clip reel", () => {
    const plan = createEditingPlan(draft(), "plan-90");
    const preparation = prepareExecution(plan);
    expect(preparation.issues).toEqual([]);
    expect(preparation.mode).toBe("ranges");
    expect(preparation.segments).toEqual([
      expect.objectContaining({ clipId: "parkour-1", startFrame: 0, endFrameExclusive: 450, durationFrames: 450, recordFrame: 0, trackIndex: 1 }),
      expect.objectContaining({ clipId: "frost-1", startFrame: 300, endFrameExclusive: 1350, durationFrames: 1050, recordFrame: 450, trackIndex: 1 }),
      expect.objectContaining({ clipId: "rais-1", startFrame: 0, endFrameExclusive: 1200, durationFrames: 1200, recordFrame: 1500, trackIndex: 1 })
    ]);
  });

  it("keeps whole-clip plans on the legacy path without frame rates", () => {
    const plan = createEditingPlan(draft({
      sources: [{ mediaId: "parkour", filename: "parkour.mp4", durationSeconds: 20 }],
      clips: [clip({ clipId: "whole", sourceStartSeconds: 0, sourceEndSeconds: 20 })],
      requestedDurationSeconds: 20,
      plannedDurationSeconds: 20,
      output: {}
    }), "plan-whole");
    const preparation = prepareExecution(plan);
    expect(preparation.issues).toEqual([]);
    expect(preparation.mode).toBe("whole-clip");
  });

  it("rejects unsupported treatments", () => {
    const plan = createEditingPlan(draft({
      transitions: [{ fromClipId: "parkour-1", toClipId: "frost-1", kind: "crossfade", durationSeconds: 0.5 }],
      output: { frameRate: 30, renderFormat: "MP4" }
    }), "plan-bad");
    const preparation = prepareExecution(plan);
    expect(preparation.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("Transitions are not implemented"),
      expect.stringContaining("Output formatting and rendering are not implemented")
    ]));
    expect(preparation.mode).toBe("ranges");
  });

  it("requires a frame rate for trimmed ranges", () => {
    const plan = createEditingPlan(draft({
      sources: [
        { mediaId: "parkour", filename: "parkour.mp4", durationSeconds: 60 },
        { mediaId: "frost", filename: "frosthandler.mp4", durationSeconds: 120 },
        { mediaId: "rais", filename: "rais.mp4", durationSeconds: 90 }
      ],
      output: {}
    }), "plan-nofps");
    const preparation = prepareExecution(plan);
    expect(preparation.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("timeline frame rate is required")
    ]));
  });

  it("forces range execution for multi-track plans", () => {
    const plan = createEditingPlan(draft({
      clips: [
        clip({ clipId: "base", sourceMediaId: "frost", sourceStartSeconds: 0, sourceEndSeconds: 90, timelineStartSeconds: 0, videoTrack: 1 }),
        clip({ clipId: "overlay", sourceMediaId: "rais", sourceStartSeconds: 0, sourceEndSeconds: 5, timelineStartSeconds: 0, videoTrack: 2 })
      ],
      requestedDurationSeconds: 90,
      plannedDurationSeconds: 90
    }), "plan-multitrack");
    const preparation = prepareExecution(plan);
    expect(preparation.mode).toBe("ranges");
    expect(preparation.segments.map((segment) => segment.trackIndex)).toEqual([1, 2]);
  });
});
