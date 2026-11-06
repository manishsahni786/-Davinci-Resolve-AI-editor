import { describe, expect, it } from "vitest";
import { EditingPlanDraftSchema } from "../src/planning/editing-plan.js";
import { createPlanDraftFromAnalysis } from "../src/planning/analysis-to-plan.js";

const MEDIA = {
  path: "C:/Media/demo.mp4",
  filename: "demo.mp4",
  durationSeconds: 120,
  width: 1920,
  height: 1080,
  frameRate: 30,
  hasAudio: true
};

function analysisWith(...events: Record<string, unknown>[]) {
  return { source: "automated_vision_analysis", media: MEDIA, events };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start_time: 10,
    end_time: 14,
    description: "Player jumps to the rooftop.",
    category: "action",
    confidence: 0.8,
    boundary_precision: "approximate",
    uncertainty_seconds: 0.9,
    evidence: [{ sourceTimeSeconds: 12, observation: "Mid-air jump visible." }],
    ...overrides
  };
}

describe("createPlanDraftFromAnalysis", () => {
  it("builds a valid draft ordered by event start with cumulative timeline positions", () => {
    const draft = createPlanDraftFromAnalysis(
      analysisWith(event({ start_time: 50, end_time: 55 }), event()),
      { mediaId: "media-1", timelineName: "Demo Reel", platform: "instagram" }
    );

    expect(draft.project).toEqual({
      timelineName: "Demo Reel",
      createNewTimeline: true,
      saveAfterExecution: true
    });
    expect(draft.sources[0]).toEqual({
      mediaId: "media-1",
      filename: "demo.mp4",
      durationSeconds: 120,
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: true
    });
    expect(draft.clips.map((clip) => clip.sourceStartSeconds)).toEqual([10, 50]);
    expect(draft.clips.map((clip) => clip.timelineStartSeconds)).toEqual([0, 4]);
    expect(draft.plannedDurationSeconds).toBe(9);
    const parsed = EditingPlanDraftSchema.parse(draft);
    expect(parsed.clips).toHaveLength(2);
    expect(draft.clips[0].evidence[0]).toEqual({
      kind: "frame",
      sourceTimeSeconds: 12,
      description: "Mid-air jump visible."
    });
  });

  it("records unknown confidence honestly as zero with a reason note", () => {
    const draft = createPlanDraftFromAnalysis(analysisWith(event({ confidence: null })), { mediaId: "m1" });

    expect(draft.clips[0].confidence).toBe(0);
    expect(draft.clips[0].relevance).toBe(0);
    expect(draft.clips[0].reason).toContain("did not report a confidence value");
  });

  it("clamps event intervals and evidence to media duration", () => {
    const draft = createPlanDraftFromAnalysis(
      analysisWith(
        event({ start_time: 118.5, end_time: 121.9, evidence: [{ sourceTimeSeconds: 119, observation: "Near end." }] }),
        event({ start_time: -3, end_time: 2, evidence: [{ sourceTimeSeconds: -1, observation: "Before zero." }] })
      ),
      { mediaId: "m1" }
    );

    const nearEnd = draft.clips[1];
    const atStart = draft.clips[0];
    expect(nearEnd.sourceEndSeconds).toBe(120);
    expect(atStart.sourceStartSeconds).toBe(0);
    expect(atStart.evidence).toHaveLength(0);
    expect(atStart.sourceEndSeconds - atStart.sourceStartSeconds).toBeGreaterThanOrEqual(0.5);
  });

  it("enforces the minimum event span inside the media", () => {
    const draft = createPlanDraftFromAnalysis(
      analysisWith(event({ start_time: 119.97, end_time: 120 })),
      { mediaId: "m1" }
    );
    expect(draft.clips[0].sourceStartSeconds).toBe(119.5);
    expect(draft.clips[0].sourceEndSeconds).toBe(120);
  });

  it("keeps boundary-precision warnings and reports ignored events", () => {
    const draft = createPlanDraftFromAnalysis(
      analysisWith(
        event({ start_time: 10, end_time: 12, uncertainty_seconds: 999 }),
        event({ start_time: "bad", end_time: 20, description: "Broken" }),
        { whatever: true }
      ),
      { mediaId: "m1" }
    );

    expect(draft.warnings.some((line) => line.includes("has a approximate boundary"))).toBe(true);
    expect(draft.warnings.some((line) => line.includes("2 analysis events were ignored"))).toBe(true);
    expect(draft.warnings.some((line) => line.includes("whole clips only"))).toBe(true);
  });

  it("limits planned events to maxEvents and notes the reduction", () => {
    const draft = createPlanDraftFromAnalysis(
      analysisWith(event({ start_time: 0, end_time: 5 }), event(), event({ start_time: 80, end_time: 85 })),
      { mediaId: "m1", maxEvents: 2 }
    );
    expect(draft.clips).toHaveLength(2);
    expect(draft.warnings.some((line) => line.includes("only the first 2 were planned"))).toBe(true);
  });

  it("throws clear errors for malformed analysis payloads", () => {
    expect(() => createPlanDraftFromAnalysis("nope", { mediaId: "m1" }))
      .toThrow(/must be the JSON object/);
    expect(() => createPlanDraftFromAnalysis(analysisWith(event()), { mediaId: "   " }))
      .toThrow(/mediaId is required/);
    expect(() => createPlanDraftFromAnalysis(analysisWith(event()), { mediaId: "m1", maxEvents: 0 }))
      .toThrow(/maxEvents must be a positive integer/);
    expect(() =>
      createPlanDraftFromAnalysis(
        { media: { ...MEDIA, durationSeconds: null }, events: [] },
        { mediaId: "m1" }
      )
    ).toThrow(/positive durationSeconds/);
    expect(() => createPlanDraftFromAnalysis({ media: { durationSeconds: 60 }, events: [] }, { mediaId: "m1" }))
      .toThrow(/missing both filename and path/);
    expect(() => createPlanDraftFromAnalysis({ media: MEDIA }, { mediaId: "m1" }))
      .toThrow(/missing an events array/);
  });

  it("falls back to path.basename when filename is absent", () => {
    const draft = createPlanDraftFromAnalysis(
      { media: { path: "D:/Footage/clip.mov", durationSeconds: 30 }, events: [event({ start_time: 1, end_time: 4 })] },
      { mediaId: "m1", instruction: "Rooftop moments" }
    );
    expect(draft.sources[0].filename).toBe("clip.mov");
    expect(draft.request.originalInstruction).toBe("Rooftop moments");
    expect(draft.project.timelineName).toBe("Analysis Highlights");
  });
});
