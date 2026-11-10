import { describe, expect, it } from "vitest";
import {
  approveEditingPlan,
  createEditingPlan,
  EditingPlanSchema,
  reviseEditingPlan
} from "../src/planning/editing-plan.js";

const draft = {
  request: {
    originalInstruction: "Create a short montage from selected footage.",
    style: "Cinematic",
    preserveOriginalOrder: false,
    excludedContent: []
  },
  project: { timelineName: "Montage Draft", createNewTimeline: true },
  sources: [{ mediaId: "media-a", filename: "recording-a.mp4", durationSeconds: 120 }],
  clips: [{
    clipId: "segment-1",
    sourceMediaId: "media-a",
    sourceStartSeconds: 10,
    sourceEndSeconds: 20,
    timelineStartSeconds: 0,
    videoTrack: 1,
    description: "Selected sequence",
    relevance: 0.9,
    confidence: 0.8,
    reason: "Matches the requested subject.",
    evidence: [{ kind: "user-selected" as const, sourceTimeSeconds: 10, description: "User selected this interval." }]
  }],
  requestedDurationSeconds: 10,
  plannedDurationSeconds: 10,
  output: { aspectRatio: "16:9", width: 1920, height: 1080 },
  warnings: []
};

describe("editing plan contract", () => {
  it("creates draft plans with stable ids and revision numbers", () => {
    const plan = createEditingPlan(draft, "plan-1", "2026-11-03T00:00:00.000Z");
    expect(plan.status).toBe("draft");
    expect(plan.revision).toBe(1);
    expect(plan.clips[0]?.sourceStartSeconds).toBe(10);
  });

  it("rejects intervals outside the source media duration", () => {
    const plan = createEditingPlan(draft, "plan-1");
    expect(EditingPlanSchema.safeParse({
      ...plan,
      clips: [{ ...plan.clips[0], sourceEndSeconds: 121 }]
    }).success).toBe(false);
  });

  it("requires duration to match the planned clip positions", () => {
    expect(() => createEditingPlan({ ...draft, plannedDurationSeconds: 12 }, "plan-1"))
      .toThrow(/Planned duration must match/);
  });

  it("requires an explicit new approval after a plan revision", () => {
    const approved = approveEditingPlan(createEditingPlan(draft, "plan-1"));
    const revised = reviseEditingPlan(approved, {
      clips: [{ ...approved.clips[0]!, sourceStartSeconds: 0 }],
      plannedDurationSeconds: 20
    });
    expect(revised.revision).toBe(2);
    expect(revised.status).toBe("draft");
    expect(revised.approvedAt).toBeUndefined();
    expect(revised.createdAt).toBe(approved.createdAt);
  });
});
