import { describe, expect, it } from "vitest";
import { EditingPlanStore } from "../src/planning/plan-store.js";
import { createTestSettings } from "./helpers/test-settings.js";

const draft = {
  request: { originalInstruction: "Make a short video from this selected clip." },
  project: { timelineName: "Approved Plan Test" },
  sources: [{ mediaId: "media-a", filename: "clip.mp4", durationSeconds: 8 }],
  clips: [{
    clipId: "clip-1",
    sourceMediaId: "media-a",
    sourceStartSeconds: 0,
    sourceEndSeconds: 8,
    timelineStartSeconds: 0,
    videoTrack: 1,
    description: "Selected full clip",
    relevance: 1,
    confidence: 1,
    reason: "Explicitly selected by the user."
  }],
  plannedDurationSeconds: 8,
  output: {}
};

describe("EditingPlanStore", () => {
  it("persists, revises, approves and completes only the expected plan revision", async () => {
    const settings = await createTestSettings();
    const store = new EditingPlanStore(settings.dataDir);
    const created = await store.create(draft);
    expect((await store.get(created.planId)).status).toBe("draft");

    const revised = await store.revise(created.planId, 1, {
      request: { ...created.request, style: "Energetic" }
    });
    expect(revised.revision).toBe(2);
    await expect(store.approve(created.planId, 1)).rejects.toThrow(/revision conflict/);

    const approved = await store.approve(created.planId, 2);
    expect(approved.status).toBe("approved");
    const queued = await store.queueExecution(created.planId, 2, "request-1");
    expect(queued.status).toBe("executing");
    const executed = await store.markExecuted(created.planId, 2, "request-1");
    expect(executed.status).toBe("executed");
  });

  it("rejects plans with invalid source ranges", async () => {
    const settings = await createTestSettings();
    const store = new EditingPlanStore(settings.dataDir);
    await expect(store.create({
      ...draft,
      clips: [{ ...draft.clips[0], sourceEndSeconds: 9 }]
    })).rejects.toThrow(/exceeds clip.mp4 duration/);
  });
});
