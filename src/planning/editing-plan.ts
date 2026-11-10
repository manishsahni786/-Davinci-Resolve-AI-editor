import { z } from "zod";

const nonEmptyText = z.string().trim().min(1).max(4000);
const seconds = z.number().finite().min(0);
const score = z.number().finite().min(0).max(1);
const frameRate = z.number().finite().positive().max(240);

export const PlanEvidenceSchema = z.object({
  kind: z.enum(["frame", "audio", "transcript", "scene", "user-selected"]),
  sourceTimeSeconds: seconds,
  description: nonEmptyText,
  confidence: score.optional(),
  thumbnailPath: z.string().max(32767).optional()
}).strict();

export const PlanSourceSchema = z.object({
  mediaId: z.string().trim().min(1).max(128),
  filename: nonEmptyText,
  durationSeconds: z.number().finite().positive().max(86_400),
  width: z.number().int().positive().max(32_768).optional(),
  height: z.number().int().positive().max(32_768).optional(),
  frameRate: frameRate.optional(),
  hasAudio: z.boolean().optional()
}).strict();

export const PlannedClipSchema = z.object({
  clipId: z.string().trim().min(1).max(128),
  sourceMediaId: z.string().trim().min(1).max(128),
  sourceStartSeconds: seconds,
  sourceEndSeconds: z.number().finite().positive(),
  timelineStartSeconds: seconds,
  videoTrack: z.number().int().min(1).max(100),
  audioTrack: z.number().int().min(1).max(100).optional(),
  description: nonEmptyText,
  relevance: score,
  visualQuality: score.optional(),
  audioRelevance: score.optional(),
  confidence: score,
  reason: nonEmptyText,
  evidence: z.array(PlanEvidenceSchema).max(500).default([])
}).strict();

export const EditingPlanSchema = z.object({
  planId: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "approved", "executing", "rejected", "executed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  approvedAt: z.string().datetime().optional(),
  executionRequestId: z.string().trim().min(1).max(128).optional(),
  request: z.object({
    originalInstruction: nonEmptyText,
    purpose: nonEmptyText.optional(),
    style: nonEmptyText.optional(),
    pacing: nonEmptyText.optional(),
    preserveOriginalOrder: z.boolean().default(false),
    excludedContent: z.array(nonEmptyText).max(100).default([])
  }).strict(),
  project: z.object({
    projectName: z.string().trim().min(1).max(120).optional(),
    timelineName: z.string().trim().min(1).max(120),
    createNewTimeline: z.boolean().default(true),
    saveAfterExecution: z.boolean().default(true)
  }).strict(),
  sources: z.array(PlanSourceSchema).min(1).max(500),
  clips: z.array(PlannedClipSchema).min(1).max(1000),
  requestedDurationSeconds: z.number().finite().positive().max(86_400).optional(),
  acceptedDurationSeconds: z.number().finite().positive().max(86_400).optional(),
  plannedDurationSeconds: z.number().finite().positive().max(86_400),
  output: z.object({
    platform: z.enum(["instagram", "youtube", "tiktok", "other"]).optional(),
    aspectRatio: z.string().regex(/^\d{1,5}:\d{1,5}$/).optional(),
    width: z.number().int().positive().max(32_768).optional(),
    height: z.number().int().positive().max(32_768).optional(),
    frameRate: frameRate.optional(),
    renderFormat: z.string().trim().min(1).max(64).optional(),
    codec: z.string().trim().min(1).max(64).optional(),
    quality: z.string().trim().min(1).max(128).optional(),
    outputPath: z.string().max(32767).optional()
  }).strict(),
  transitions: z.array(z.object({
    fromClipId: z.string().trim().min(1).max(128),
    toClipId: z.string().trim().min(1).max(128),
    kind: nonEmptyText,
    durationSeconds: z.number().finite().min(0).max(60)
  }).strict()).max(1000).default([]),
  captions: z.array(z.object({
    text: nonEmptyText,
    startSeconds: seconds,
    endSeconds: z.number().finite().positive(),
    track: z.number().int().min(1).max(100).optional(),
    source: z.enum(["transcript", "generated", "user-provided"]).optional()
  }).strict()).max(10_000).default([]),
  audio: z.object({
    musicPreference: z.string().max(2000).optional(),
    dialoguePriority: z.boolean().optional(),
    gainDb: z.number().finite().min(-60).max(24).optional(),
    ducking: z.boolean().optional()
  }).strict().default({}),
  effects: z.array(z.object({
    clipId: z.string().trim().min(1).max(128),
    name: nonEmptyText,
    parameters: z.record(z.string().max(128), z.union([z.string().max(1000), z.number(), z.boolean()])).default({})
  }).strict()).max(1000).default([]),
  warnings: z.array(nonEmptyText).max(500).default([])
}).strict().superRefine((plan, context) => {
  const sources = new Map<string, z.infer<typeof PlanSourceSchema>>();
  for (const source of plan.sources) {
    if (sources.has(source.mediaId)) {
      context.addIssue({ code: "custom", path: ["sources"], message: `Duplicate source media id: ${source.mediaId}` });
    }
    sources.set(source.mediaId, source);
  }

  const clips = new Map<string, z.infer<typeof PlannedClipSchema>>();
  let actualDuration = 0;
  for (const [index, clip] of plan.clips.entries()) {
    if (clips.has(clip.clipId)) {
      context.addIssue({ code: "custom", path: ["clips", index, "clipId"], message: `Duplicate clip id: ${clip.clipId}` });
    }
    clips.set(clip.clipId, clip);
    if (clip.sourceEndSeconds <= clip.sourceStartSeconds) {
      context.addIssue({ code: "custom", path: ["clips", index, "sourceEndSeconds"], message: "Source end must be after source start." });
    }
    const source = sources.get(clip.sourceMediaId);
    if (!source) {
      context.addIssue({ code: "custom", path: ["clips", index, "sourceMediaId"], message: `Unknown source media id: ${clip.sourceMediaId}` });
    } else if (clip.sourceEndSeconds > source.durationSeconds) {
      context.addIssue({ code: "custom", path: ["clips", index, "sourceEndSeconds"], message: `Source interval exceeds ${source.filename} duration (${source.durationSeconds}s).` });
    }
    for (const evidence of clip.evidence) {
      if (source && evidence.sourceTimeSeconds > source.durationSeconds) {
        context.addIssue({ code: "custom", path: ["clips", index, "evidence"], message: `Evidence timestamp exceeds ${source.filename} duration.` });
      }
    }
    actualDuration = Math.max(actualDuration, clip.timelineStartSeconds + clip.sourceEndSeconds - clip.sourceStartSeconds);
  }

  // Per-video-track contiguity: no unintended gaps or overlaps on a track.
  const clipsByTrack = new Map<number, Array<{ index: number; clip: z.infer<typeof PlannedClipSchema> }>>();
  for (const [index, clip] of plan.clips.entries()) {
    const entries = clipsByTrack.get(clip.videoTrack) ?? [];
    entries.push({ index, clip });
    clipsByTrack.set(clip.videoTrack, entries);
  }
  let earliestTimelineStart = Number.POSITIVE_INFINITY;
  for (const [track, entries] of clipsByTrack) {
    let expectedStart: number | null = null;
    let previousStart = -1;
    for (const { index, clip } of entries) {
      earliestTimelineStart = Math.min(earliestTimelineStart, clip.timelineStartSeconds);
      if (clip.timelineStartSeconds < previousStart) {
        context.addIssue({
          code: "custom",
          path: ["clips", index, "timelineStartSeconds"],
          message: `Clips on video track ${track} must be listed in timeline order.`
        });
      }
      previousStart = clip.timelineStartSeconds;
      if (expectedStart !== null) {
        const gap = clip.timelineStartSeconds - expectedStart;
        if (Math.abs(gap) > 0.05) {
          context.addIssue({
            code: "custom",
            path: ["clips", index, "timelineStartSeconds"],
            message: `Video track ${track} has a gap or overlap of ${gap.toFixed(3)}s before clip ${clip.clipId}.`
          });
        }
      }
      expectedStart = clip.timelineStartSeconds + (clip.sourceEndSeconds - clip.sourceStartSeconds);
    }
  }
  if (Number.isFinite(earliestTimelineStart) && earliestTimelineStart > 0.05) {
    context.addIssue({
      code: "custom",
      path: ["clips"],
      message: `The timeline must start at 0s (earliest clip starts at ${earliestTimelineStart.toFixed(3)}s).`
    });
  }

  if (Math.abs(actualDuration - plan.plannedDurationSeconds) > 0.05) {
    context.addIssue({ code: "custom", path: ["plannedDurationSeconds"], message: `Planned duration must match the last clip end (${actualDuration.toFixed(3)}s).` });
  }

  for (const [index, transition] of plan.transitions.entries()) {
    if (!clips.has(transition.fromClipId) || !clips.has(transition.toClipId)) {
      context.addIssue({ code: "custom", path: ["transitions", index], message: "Transition references an unknown clip id." });
    }
  }
  for (const [index, effect] of plan.effects.entries()) {
    if (!clips.has(effect.clipId)) {
      context.addIssue({ code: "custom", path: ["effects", index, "clipId"], message: "Effect references an unknown clip id." });
    }
  }
  for (const [index, caption] of plan.captions.entries()) {
    if (caption.endSeconds <= caption.startSeconds) {
      context.addIssue({ code: "custom", path: ["captions", index, "endSeconds"], message: "Caption end must be after start." });
    }
    if (caption.endSeconds > plan.plannedDurationSeconds) {
      context.addIssue({ code: "custom", path: ["captions", index, "endSeconds"], message: "Caption extends beyond the planned timeline duration." });
    }
  }
});

export const EditingPlanDraftSchema = EditingPlanSchema.innerType().omit({
  planId: true,
  revision: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
  executionRequestId: true
});

export type EditingPlan = z.infer<typeof EditingPlanSchema>;
export type EditingPlanDraft = z.infer<typeof EditingPlanDraftSchema>;

export function createEditingPlan(
  draft: unknown,
  planId: string,
  createdAt = new Date().toISOString()
): EditingPlan {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    throw new Error("Editing plan draft must be an object.");
  }
  const parsedDraft = EditingPlanDraftSchema.parse(draft);
  return EditingPlanSchema.parse({
    ...parsedDraft,
    planId,
    revision: 1,
    status: "draft",
    createdAt
  });
}

export function reviseEditingPlan(
  current: EditingPlan,
  changesValue: unknown,
  revisedAt = new Date().toISOString()
): EditingPlan {
  if (typeof changesValue !== "object" || changesValue === null || Array.isArray(changesValue)) {
    throw new Error("Editing plan changes must be an object.");
  }
  const changes = EditingPlanDraftSchema.partial().parse(changesValue);
  return EditingPlanSchema.parse({
    ...current,
    ...changes,
    project: changes.project ?? current.project,
    request: changes.request ?? current.request,
    sources: changes.sources ?? current.sources,
    clips: changes.clips ?? current.clips,
    output: changes.output ?? current.output,
    transitions: changes.transitions ?? current.transitions,
    captions: changes.captions ?? current.captions,
    audio: changes.audio ?? current.audio,
    effects: changes.effects ?? current.effects,
    warnings: changes.warnings ?? current.warnings,
    planId: current.planId,
    revision: current.revision + 1,
    status: "draft",
    approvedAt: undefined,
    createdAt: current.createdAt,
    updatedAt: revisedAt
  });
}

export function approveEditingPlan(plan: EditingPlan, approvedAt = new Date().toISOString()): EditingPlan {
  if (plan.status !== "draft") {
    throw new Error(`Only a draft plan can be approved (current status: ${plan.status}).`);
  }
  return EditingPlanSchema.parse({ ...plan, status: "approved", approvedAt });
}

export function markEditingPlanExecuted(plan: EditingPlan): EditingPlan {
  if (plan.status !== "executing") {
    throw new Error("Only a plan with a queued execution can be marked executed.");
  }
  return EditingPlanSchema.parse({ ...plan, status: "executed" });
}

export function markEditingPlanExecuting(plan: EditingPlan, requestId: string): EditingPlan {
  if (plan.status !== "approved") {
    throw new Error("Only an approved plan can be executed.");
  }
  return EditingPlanSchema.parse({ ...plan, status: "executing", executionRequestId: requestId });
}
