import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AppSettings } from "../config/settings.js";
import type { FileBridge } from "../bridge/file-bridge.js";
import type { BridgeManager } from "../bridge/bridge-manager.js";
import type { FusionPrefsChannel } from "../bridge/fusion-prefs.js";
import type { BridgeResponseEnvelope } from "../types/bridge.types.js";
import type { BridgeCommand } from "../bridge/message-protocol.js";
import type { ResolveTrigger } from "../bridge/resolve-trigger.js";
import type { ResolveStatus } from "../resolve/resolve-client.js";
import type {
  ReelWorkflowInput,
  ReelWorkflowResult
} from "../resolve/editing-workflow.js";
import { listCapabilities, summarizeCapabilities } from "../resolve/resolve-capabilities.js";
import { EditingPlanStore } from "../planning/plan-store.js";
import { createPlanDraftFromAnalysis } from "../planning/analysis-to-plan.js";
import { EditingPlanDraftSchema, type EditingPlan } from "../planning/editing-plan.js";
import { prepareExecution } from "../planning/execution-plan.js";
import { verifyTimelineInspection, type InspectedTimeline } from "../planning/execution-verification.js";
import { toAppError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { PythonMediaAnalysis, PythonMediaAnalysisError } from "../analysis/python-media-analysis.js";

export const MCP_SERVER_NAME = "ai-video-editor";
export const MCP_SERVER_VERSION = "0.1.0";

const MANUAL_ACTION = "In Resolve: Workspace > Scripts > Utility > AI Video Editor Bridge";
const AUTO_ACTION = "The Resolve bridge is triggered automatically while waiting for the response.";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const QUEUE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const MUTATION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const TIMEOUT_DESCRIPTION = "Maximum time to wait for the Resolve bridge response, in milliseconds.";
const WAIT_DESCRIPTION = "When true, wait for the response while the user manually launches the Resolve Bridge. When false, queue the request and return its id immediately. Defaults to false when manual Bridge launch is required.";

export interface McpResolveService {
  status(): Promise<ResolveStatus>;
  inspectProject(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  inspectMedia(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  inspectTimeline(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  inspectRender(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  createProject(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  openProject(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  saveProject(timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  createBin(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  importMedia(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  createTimeline(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  appendClips(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  deleteClips(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  setItemProperty(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  makeReel(input: ReelWorkflowInput, timeoutMs?: number): Promise<ReelWorkflowResult>;
}

export interface McpServerDependencies {
  settings: AppSettings;
  bridge: FileBridge;
  manager: BridgeManager;
  resolve: McpResolveService;
  prefsChannel?: FusionPrefsChannel;
  trigger?: ResolveTrigger;
  planStore?: EditingPlanStore;
  mediaAnalysis?: PythonMediaAnalysis;
  logger: Logger;
}

function toolText(value: unknown, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof PythonMediaAnalysisError) {
    return toolText({
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details
    }, true);
  }
  return toolText(toAppError(error).toJSON(), true);
}

function queuedResponse(
  dependencies: McpServerDependencies,
  command: string,
  requestId: string
): Record<string, unknown> {
  const autoTrigger = dependencies.trigger?.enabled === true;
  return {
    queued: true,
    command,
    requestId,
    pendingRequestPath: dependencies.bridge.requestFilePath,
    responsePath: dependencies.bridge.responseFilePath(requestId),
    autoTrigger,
    nextStep: autoTrigger ? AUTO_ACTION : MANUAL_ACTION,
    then: `Call resolve_read_response with requestId ${requestId}.`
  };
}

function hasWait(
  value: { wait?: boolean | undefined },
  dependencies: McpServerDependencies
): boolean {
  if (value.wait === false) {
    return false;
  }
  if (value.wait === true) {
    return true;
  }
  return dependencies.trigger?.enabled === true;
}

async function queueInspection(
  dependencies: McpServerDependencies,
  command: BridgeCommand,
  payload: Record<string, unknown>,
  timeoutMs: number | undefined
): Promise<CallToolResult> {
  try {
    const request = await dependencies.manager.enqueueOnly(
      command,
      payload,
      timeoutMs === undefined ? {} : { timeoutMs }
    );
    return toolText(queuedResponse(dependencies, command, request.id));
  } catch (error) {
    return toolError(error);
  }
}

async function waitForInspection(
  dependencies: McpServerDependencies,
  command: BridgeCommand,
  operation: () => Promise<BridgeResponseEnvelope>
): Promise<CallToolResult> {
  try {
    const response = await operation();
    return toolText(response, !response.ok);
  } catch (error) {
    dependencies.logger.warn("MCP inspection failed", {
      command,
      error: error instanceof Error ? error.message : String(error)
    });
    return toolError(error);
  }
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION
  });
  const planStore = dependencies.planStore ?? new EditingPlanStore(dependencies.settings.dataDir);
  const mediaAnalysis = dependencies.mediaAnalysis ?? new PythonMediaAnalysis(dependencies.settings);

  server.registerTool(
    "resolve_analyze_media",
    {
      title: "Analyze selected media",
      description: "Read-only local media discovery and analysis. Visual analysis samples up to 8 frames by default at reduced resolution and uses a configured local/compatible vision model. Use operation analyze_events for two-pass, evidence-backed event detection with explicit boundary uncertainty. Event analysis defaults to one frame per vision request; multi-image batches are opt-in and automatically fall back to single-image requests when a batch fails. Slow scene detection, silence scanning and transcription are optional and disabled unless requested; no dependencies are installed and Resolve is never changed.",
      inputSchema: {
        path: z.string().trim().min(1).describe("A selected video file, or a folder when operation is discover_media."),
        operation: z.enum(["analyze_media", "analyze_events", "probe_media", "discover_media", "detect_scenes", "detect_silence", "transcribe"]).default("analyze_media"),
        task: z.string().max(2000).optional().describe("User's content request, such as the scene or subject to look for."),
        recursive: z.boolean().optional(),
        maxFiles: z.number().int().min(1).max(100).optional(),
        maxFrames: z.number().int().min(1).max(120).optional(),
        maxDimension: z.number().int().min(128).max(2048).optional(),
        detectScenes: z.boolean().optional(),
        sceneMaxDurationSeconds: z.number().int().min(1).max(3600).optional(),
        detectSilence: z.boolean().optional(),
        transcribe: z.boolean().optional(),
        pass1MaxFrames: z.number().int().min(4).max(120).optional().describe("Two-pass: representative frames sampled across the whole video in pass 1."),
        pass2FramesPerEvent: z.number().int().min(4).max(24).optional().describe("Two-pass: dense frames sampled around each candidate event in pass 2."),
        maxEvents: z.number().int().min(1).max(50).optional().describe("Two-pass: maximum candidate events refined in pass 2."),
        maxRequests: z.number().int().min(1).max(64).optional().describe("Two-pass: sequential vision-request budget for the whole analysis."),
        visionBatchSize: z.number().int().min(1).max(8).optional().describe("Two-pass: frames per vision request. Defaults to 1 (single-image baseline); larger batches fall back to single-image requests when inference fails.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ path: mediaPath, operation, task, recursive, maxFiles, maxFrames, maxDimension, detectScenes, sceneMaxDurationSeconds, detectSilence, transcribe, pass1MaxFrames, pass2FramesPerEvent, maxEvents, maxRequests, visionBatchSize }, extra) => {
      try {
        const payload: Record<string, unknown> = { path: mediaPath };
        if (task !== undefined) payload.task = task;
        if (recursive !== undefined) payload.recursive = recursive;
        if (maxFiles !== undefined) payload.maxFiles = maxFiles;
        if (maxFrames !== undefined) payload.maxFrames = maxFrames;
        if (maxDimension !== undefined) payload.maxDimension = maxDimension;
        if (detectScenes !== undefined) payload.detectScenes = detectScenes;
        if (sceneMaxDurationSeconds !== undefined) payload.sceneMaxDurationSeconds = sceneMaxDurationSeconds;
        if (detectSilence !== undefined) payload.detectSilence = detectSilence;
        if (transcribe !== undefined) payload.transcribe = transcribe;
        if (pass1MaxFrames !== undefined) payload.pass1MaxFrames = pass1MaxFrames;
        if (pass2FramesPerEvent !== undefined) payload.pass2FramesPerEvent = pass2FramesPerEvent;
        if (maxEvents !== undefined) payload.maxEvents = maxEvents;
        if (maxRequests !== undefined) payload.maxRequests = maxRequests;
        if (visionBatchSize !== undefined) payload.visionBatchSize = visionBatchSize;
        return toolText(await mediaAnalysis.run(operation, payload, { signal: extra.signal }));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_create_editing_plan",
    {
      title: "Create editing plan draft",
      description: "Validate and save a proposed edit plan. This does not access or change DaVinci Resolve.",
      inputSchema: {
        draft: EditingPlanDraftSchema.describe("Structured plan containing source intervals, timeline positions, evidence, output settings and requested treatments.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ draft }) => {
      try {
        return toolText(await planStore.create(draft));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_create_plan_from_analysis",
    {
      title: "Create plan draft from media analysis",
      description: "Convert a resolve_analyze_media analyze_events result into a validated editing-plan draft. This does not access or change Resolve; execution still requires explicit approval. Event boundaries are kept as reported; because execution currently enforces whole clips, the draft carries a warning that partial source intervals would be rejected.",
      inputSchema: {
        analysis: z.record(z.unknown()).describe("Result object returned by resolve_analyze_media with operation analyze_events."),
        mediaId: z.string().trim().min(1).max(128).describe("Media pool clip id of the analyzed file in Resolve."),
        timelineName: z.string().trim().max(120).optional().describe("Target timeline name. Defaults to \"Analysis Highlights\"."),
        projectName: z.string().trim().max(120).optional(),
        platform: z.enum(["instagram", "youtube", "tiktok", "other"]).optional(),
        instruction: z.string().trim().max(2000).optional().describe("Original user request recorded in the plan."),
        maxEvents: z.number().int().min(1).max(1000).optional().describe("Limit how many ranked events (in source order) are planned.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ analysis, mediaId, timelineName, projectName, platform, instruction, maxEvents }) => {
      try {
        const draft = createPlanDraftFromAnalysis(analysis, {
          mediaId,
          timelineName,
          projectName,
          platform,
          instruction,
          maxEvents
        });
        return toolText(await planStore.create(draft));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_get_editing_plan",
    {
      title: "Read editing plan",
      description: "Read the latest validated editing-plan revision and its approval state. Does not change Resolve.",
      inputSchema: {
        planId: z.string().trim().min(1).max(128).describe("Plan id returned by resolve_create_editing_plan.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ planId }) => {
      try {
        return toolText(await planStore.get(planId));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_revise_editing_plan",
    {
      title: "Revise editing plan",
      description: "Revise a plan without restarting the workflow. The revision number increments and any prior approval is cleared.",
      inputSchema: {
        planId: z.string().trim().min(1).max(128),
        expectedRevision: z.number().int().positive(),
        changes: EditingPlanDraftSchema.partial().describe("Fields to replace in the current plan, such as clips, style, duration or output settings.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ planId, expectedRevision, changes }) => {
      try {
        return toolText(await planStore.revise(planId, expectedRevision, changes));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_approve_editing_plan",
    {
      title: "Approve editing plan",
      description: "Record the user's explicit approval for the displayed draft revision. Call only after the user approves that exact plan. This does not change Resolve.",
      inputSchema: {
        planId: z.string().trim().min(1).max(128),
        expectedRevision: z.number().int().positive(),
        userApproved: z.literal(true).describe("Set true only after the user explicitly approves this plan revision.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ planId, expectedRevision }) => {
      try {
        return toolText(await planStore.approve(planId, expectedRevision));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_reject_editing_plan",
    {
      title: "Reject editing plan",
      description: "Record that the user rejected the displayed plan revision. Revise it or create a new proposal; this does not change Resolve.",
      inputSchema: {
        planId: z.string().trim().min(1).max(128),
        expectedRevision: z.number().int().positive(),
        userRejected: z.literal(true).describe("Set true only after the user rejects this plan revision.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ planId, expectedRevision }) => {
      try {
        return toolText(await planStore.reject(planId, expectedRevision));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_execute_editing_plan",
    {
      title: "Queue approved editing plan",
      description: "Queue a new timeline from an explicitly approved plan. Execution supports contiguous whole clips, frame-accurate source ranges, multiple video tracks and linked source audio for video-track-1 ranges when frame rates are known. Transitions, captions, effects, audio mixing/gain and rendering are rejected. The user must launch the Resolve Bridge for this request.",
      inputSchema: {
        planId: z.string().trim().min(1).max(128),
        expectedRevision: z.number().int().positive()
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async ({ planId, expectedRevision }) => {
      try {
        const plan = await planStore.get(planId);
        if (plan.revision !== expectedRevision) {
          throw new Error(`Editing plan revision conflict: expected ${expectedRevision}, current revision is ${plan.revision}.`);
        }
        if (plan.status !== "approved") {
          throw new Error(`Only an approved plan can be executed (current status: ${plan.status}).`);
        }
        const preparation = prepareExecution(plan);
        if (preparation.issues.length > 0) {
          return toolText({
            ok: false,
            code: "PLAN_NOT_EXECUTABLE",
            planId,
            revision: expectedRevision,
            issues: preparation.issues
          }, true);
        }

        const command = preparation.mode === "ranges" ? "timeline.createFromRanges" : "timeline.create";
        const payload = preparation.mode === "ranges"
          ? {
              name: plan.project.timelineName,
              segments: preparation.segments.map((segment) => ({
                mediaId: segment.mediaId,
                startFrame: segment.startFrame,
                endFrameExclusive: segment.endFrameExclusive,
                trackIndex: segment.trackIndex,
                recordFrame: segment.recordFrame,
                includeAudio: segment.includeAudio
              }))
            }
          : {
              name: plan.project.timelineName,
              mediaIds: plan.clips.map((clip) => clip.sourceMediaId)
            };

        const requestId = randomUUID();
        await planStore.queueExecution(planId, expectedRevision, requestId);
        try {
          const request = await dependencies.manager.enqueueOnly(
            command,
            payload,
            { id: requestId, timeoutMs: dependencies.settings.commandTimeoutMs }
          );
          return toolText({
            ...queuedResponse(dependencies, command, request.id),
            planId,
            planRevision: expectedRevision,
            planStatus: "executing",
            executionMode: preparation.mode,
            expectedSegments: preparation.segments.map((segment) => ({
              clipId: segment.clipId,
              mediaId: segment.mediaId,
              trackIndex: segment.trackIndex,
              startFrame: segment.startFrame,
              endFrameExclusive: segment.endFrameExclusive,
              durationFrames: segment.durationFrames,
              recordFrame: segment.recordFrame,
              includeAudio: segment.includeAudio
            }))
          });
        } catch (error) {
          await planStore.cancelExecution(planId, expectedRevision, requestId);
          throw error;
        }
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_mark_editing_plan_executed",
    {
      title: "Record verified plan execution",
        description: "Mark a queued plan complete only after its create, timeline-inspection and required save responses all succeeded.",
      inputSchema: {
        planId: z.string().trim().min(1).max(128),
        expectedRevision: z.number().int().positive(),
        requestId: z.string().trim().min(1).max(128),
        timelineInspectionRequestId: z.string().trim().min(1).max(128),
        saveRequestId: z.string().trim().min(1).max(128).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ planId, expectedRevision, requestId, timelineInspectionRequestId, saveRequestId }) => {
      try {
        const plan = await planStore.get(planId);
        const preparation = prepareExecution(plan);
        if (preparation.issues.length > 0) {
          throw new Error(`The plan is no longer executable: ${preparation.issues.join(" ")}`);
        }
        const response = await dependencies.bridge.readResponse(requestId);
        const expectedCommand = preparation.mode === "ranges" ? "timeline.createFromRanges" : "timeline.create";
        if (!response || !response.ok || response.command !== expectedCommand) {
          throw new Error(`The queued ${expectedCommand} request has no successful Resolve response.`);
        }
        const inspected = await dependencies.bridge.readResponse(timelineInspectionRequestId);
        if (!inspected?.ok || inspected.command !== "timeline.inspect") {
          throw new Error("The timeline inspection request has no successful Resolve response.");
        }
        const verification = verifyTimelineInspection(
          plan,
          preparation,
          inspected.result as InspectedTimeline | undefined
        );
        if (!verification.ok) {
          return toolText({
            ok: false,
            code: "TIMELINE_VERIFICATION_FAILED",
            planId,
            revision: expectedRevision,
            checkedItems: verification.checkedItems,
            issues: verification.issues
          }, true);
        }
        if (plan.project.saveAfterExecution) {
          if (!saveRequestId) {
            throw new Error("The approved plan requires a project save request id.");
          }
          const saved = await dependencies.bridge.readResponse(saveRequestId);
          if (!saved?.ok || saved.command !== "project.save") {
            throw new Error("The approved plan has no successful project.save response.");
          }
        }
        return toolText(await planStore.markExecuted(planId, expectedRevision, requestId));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_status",
    {
      title: "Resolve status",
      description: "Report the local Resolve environment, bridge health and capability summary. Does not change the project.",
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      try {
        return toolText(await dependencies.resolve.status());
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_capabilities",
    {
      title: "Resolve capabilities",
      description: "Return the capability matrix, including verified, untested and Free-restricted features.",
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => toolText({
      summary: summarizeCapabilities(),
      items: listCapabilities()
    })
  );

  server.registerTool(
    "resolve_inspect_project",
    {
      title: "Inspect Resolve project",
      description: "Inspect the current project and project list. Read-only. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        includeProjects: z.boolean().optional().describe("Include the project list in the result.")
      },
      annotations: QUEUE_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.includeProjects !== undefined) {
        payload.includeProjects = args.includeProjects;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "project.inspect", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "project.inspect", () =>
        dependencies.resolve.inspectProject(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_inspect_media",
    {
      title: "Inspect Resolve media pool",
      description: "Inspect media-pool bins and clips. Read-only. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        includeClips: z.boolean().optional().describe("Include clip summaries."),
        maxClips: z.number().int().min(1).max(500).optional().describe("Maximum number of clips to include.")
      },
      annotations: QUEUE_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.includeClips !== undefined) {
        payload.includeClips = args.includeClips;
      }
      if (args.maxClips !== undefined) {
        payload.maxClips = args.maxClips;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "media.inspect", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "media.inspect", () =>
        dependencies.resolve.inspectMedia(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_inspect_timeline",
    {
      title: "Inspect Resolve timeline",
      description: "Inspect the current or indexed timeline, including tracks, clip items and markers. Read-only. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        timelineIndex: z.number().int().min(1).max(1000).optional().describe("1-based timeline index. Omit to inspect the current timeline."),
        includeClips: z.boolean().optional().describe("Include timeline item summaries."),
        maxClips: z.number().int().min(1).max(500).optional().describe("Maximum number of items to include.")
      },
      annotations: QUEUE_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.timelineIndex !== undefined) {
        payload.timelineIndex = args.timelineIndex;
      }
      if (args.includeClips !== undefined) {
        payload.includeClips = args.includeClips;
      }
      if (args.maxClips !== undefined) {
        payload.maxClips = args.maxClips;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "timeline.inspect", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "timeline.inspect", () =>
        dependencies.resolve.inspectTimeline(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_inspect_render",
    {
      title: "Inspect Resolve render settings",
      description: "Inspect render formats, codecs, presets and current format/codec. Read-only. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        includeJobs: z.boolean().optional().describe("Include render queue jobs when the installed API supports them.")
      },
      annotations: QUEUE_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.includeJobs !== undefined) {
        payload.includeJobs = args.includeJobs;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "render.inspect", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "render.inspect", () =>
        dependencies.resolve.inspectRender(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_create_project",
    {
      title: "Create Resolve project",
      description: "Create and open a new Resolve project. Fails if the project already exists. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        name: z.string().trim().min(1).max(120).describe("Project name."),
        mediaPath: z.string().trim().min(1).max(32767).optional().describe("Optional project media location path.")
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = { name: args.name };
      if (args.mediaPath !== undefined) {
        payload.mediaPath = args.mediaPath;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "project.create", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "project.create", () =>
        dependencies.resolve.createProject(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_open_project",
    {
      title: "Open Resolve project",
      description: "Open an existing project from the current project folder. Unsaved changes in the current project may be lost unless saveCurrent=true. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        name: z.string().trim().min(1).max(120).describe("Existing project name."),
        saveCurrent: z.boolean().optional().describe("Save the current project before loading the requested one.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const payload: Record<string, unknown> = { name: args.name };
      if (args.saveCurrent !== undefined) {
        payload.saveCurrent = args.saveCurrent;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "project.open", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "project.open", () =>
        dependencies.resolve.openProject(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_save_project",
    {
      title: "Save Resolve project",
      description: "Save the currently open Resolve project. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION)
      },
      annotations: QUEUE_ANNOTATIONS
    },
    async (args) => {
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "project.save", {}, args.timeoutMs);
      }
      return waitForInspection(dependencies, "project.save", () =>
        dependencies.resolve.saveProject(args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_create_bin",
    {
      title: "Create Resolve media pool bin",
      description: "Create a bin under the media pool root or a slash-separated parent bin path. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        name: z.string().trim().min(1).max(120).describe("New bin name."),
        parentPath: z.string().trim().max(4096).optional().describe("Parent bin path such as Footage/Angle A. Omit for the root bin.")
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = { name: args.name };
      if (args.parentPath !== undefined) {
        payload.parentPath = args.parentPath;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "media.createBin", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "media.createBin", () =>
        dependencies.resolve.createBin(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_import_media",
    {
      title: "Import media into Resolve",
      description: "Import one or more media files into the current media pool bin or a specified bin. Source files are read/linked, never modified. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        filePaths: z.array(z.string().trim().min(1).max(32767)).min(1).max(100).describe("Absolute media file or folder paths."),
        binPath: z.string().trim().max(4096).optional().describe("Target bin path such as Footage. Omit to use the current bin.")
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = { filePaths: args.filePaths };
      if (args.binPath !== undefined) {
        payload.binPath = args.binPath;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "media.import", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "media.import", () =>
        dependencies.resolve.importMedia(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_create_timeline",
    {
      title: "Create Resolve timeline",
      description: "Low-level timeline mutation. Use only after the user approves an editing plan; the video-editor agent should execute plans with resolve_execute_editing_plan. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        name: z.string().trim().min(1).max(120).optional().describe("Optional new timeline name."),
        mediaIds: z.array(z.string().trim().min(1).max(64)).max(100).optional().describe("Optional media pool clip ids to create the timeline from.")
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.name !== undefined) {
        payload.name = args.name;
      }
      if (args.mediaIds !== undefined) {
        payload.mediaIds = args.mediaIds;
      }
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "timeline.create", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "timeline.create", () =>
        dependencies.resolve.createTimeline(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_append_clips",
    {
      title: "Append Resolve timeline clips",
      description: "Low-level timeline mutation. Use only after the user approves an editing plan; the video-editor agent should execute plans with resolve_execute_editing_plan. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        mediaIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100).describe("Media pool clip ids to append to the current timeline.")
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = { mediaIds: args.mediaIds };
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "timeline.appendClips", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "timeline.appendClips", () =>
        dependencies.resolve.appendClips(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_delete_clips",
    {
      title: "Delete Resolve timeline clips",
      description: "Low-level destructive timeline mutation. Requires an explicitly approved plan and confirmation; the video-editor agent should not call this until delete actions are modeled in the plan. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        targets: z.array(z.object({
          trackType: z.enum(["video", "audio", "subtitle"]),
          trackIndex: z.number().int().min(1).max(100),
          itemIndices: z.array(z.number().int().min(1).max(500)).min(1).max(200)
        }).strict()).min(1).max(50).describe("Delete targets referencing timeline items.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const payload: Record<string, unknown> = { targets: args.targets };
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "timeline.deleteClips", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "timeline.deleteClips", () =>
        dependencies.resolve.deleteClips(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_set_item_property",
    {
      title: "Set Resolve timeline item property",
      description: "Low-level timeline mutation. Use only when the user approved this property change as part of the plan; the video-editor agent should execute plans with resolve_execute_editing_plan. By default this queues a request for manual Bridge launch; set wait=true to block while you launch the Bridge.",
      inputSchema: {
        wait: z.boolean().optional().describe(WAIT_DESCRIPTION),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        target: z.object({
          trackType: z.enum(["video", "audio", "subtitle"]),
          trackIndex: z.number().int().min(1).max(100),
          itemIndex: z.number().int().min(1).max(500)
        }).strict().describe("Timeline item target."),
        properties: z.record(z.string().min(1).max(64), z.union([z.string().max(256), z.number(), z.boolean()])).refine(
          (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 20,
          "Provide between 1 and 20 properties."
        ).describe("Property key/value pairs to set.")
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async (args) => {
      const payload: Record<string, unknown> = {
        target: args.target,
        properties: args.properties
      };
      if (!hasWait(args, dependencies)) {
        return queueInspection(dependencies, "timeline.setItemProperty", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "timeline.setItemProperty", () =>
        dependencies.resolve.setItemProperty(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
    }
  );

  server.registerTool(
    "resolve_make_reel",
    {
      title: "Build a reel or video rough cut",
      description: "Legacy one-shot rough-cut workflow. It selects clips and mutates a timeline without consuming an approved editing plan; the video-editor agent must use the plan workflow instead. Rendering is not included.",
      inputSchema: {
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe(TIMEOUT_DESCRIPTION),
        projectName: z.string().trim().min(1).max(120).optional().describe("Project to create or open. Omit to use the current project."),
        mediaPaths: z.array(z.string().trim().min(1).max(32767)).max(100).optional().describe("Absolute media files or folders to import before editing."),
        binName: z.string().trim().min(1).max(120).optional().describe("Media pool bin for imported media. Defaults to Reel Footage."),
        clipIds: z.array(z.string().trim().min(1).max(64)).max(100).optional().describe("Explicit media-pool unique ids to use, in order."),
        timelineName: z.string().trim().min(1).max(120).optional().describe("New timeline name."),
        topic: z.string().trim().min(1).max(200).optional().describe("Topic keywords used to pick clips by name or file path."),
        platform: z.enum(["instagram", "youtube"]).optional().describe("Target platform; adds a resolution/export warning."),
        maxClips: z.number().int().min(1).max(100).optional().describe("Maximum number of clips to place. Defaults to 20."),
        save: z.boolean().optional().describe("Save the project at the end. Defaults to true.")
      },
      annotations: MUTATION_ANNOTATIONS
    },
    async (args) => {
      try {
        const input: ReelWorkflowInput = {};
        if (args.projectName !== undefined) input.projectName = args.projectName;
        if (args.mediaPaths !== undefined) input.mediaPaths = args.mediaPaths;
        if (args.binName !== undefined) input.binName = args.binName;
        if (args.clipIds !== undefined) input.clipIds = args.clipIds;
        if (args.timelineName !== undefined) input.timelineName = args.timelineName;
        if (args.topic !== undefined) input.topic = args.topic;
        if (args.platform !== undefined) input.platform = args.platform;
        if (args.maxClips !== undefined) input.maxClips = args.maxClips;
        if (args.save !== undefined) input.save = args.save;
        const result = await dependencies.resolve.makeReel(
          input,
          args.timeoutMs ?? dependencies.settings.commandTimeoutMs
        );
        return toolText(result, !result.ok);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_read_response",
    {
      title: "Read Resolve bridge response",
      description: "Read the response for a queued request id. Waits briefly for Fusion preferences to flush. Returns found=false when no response is available yet.",
      inputSchema: {
        requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).describe("The request id returned by an inspection tool."),
        waitMs: z.number().int().min(0).max(60000).optional().describe("Maximum time to wait for the response. Defaults to 3000 ms.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      try {
        let response = await dependencies.bridge.readResponse(args.requestId, args.waitMs ?? 3000);
        let triggerResult: { ok: boolean; code?: string } | null = null;
        if (!response && dependencies.trigger?.enabled) {
          triggerResult = await dependencies.trigger.trigger("read-response");
          if (triggerResult.ok) {
            response = await dependencies.bridge.readResponse(args.requestId, 5_000);
          }
        }
        if (!response) {
          const pending = await dependencies.bridge.getPendingRequest();
          const autoTrigger = dependencies.trigger?.enabled === true;
          return toolText({
            found: false,
            requestId: args.requestId,
            pendingRequest: pending,
            autoTrigger,
            triggerResult,
            nextStep: autoTrigger ? AUTO_ACTION : MANUAL_ACTION
          });
        }
        return toolText(response, !response.ok);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_clear_pending",
    {
      title: "Clear pending Resolve request",
      description: "Archive an unprocessed bridge request without running it. Does not modify the Resolve project.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true. Clearing discards the pending request.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        const cleared = await dependencies.bridge.clearPending("cleared-by-mcp");
        return toolText({ cleared });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "resolve_last_error",
    {
      title: "Read last Resolve bridge error",
      description: "Read the last early bridge error and stage published through Fusion preferences, if any.",
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      if (!dependencies.prefsChannel) {
        return toolText({ found: false, note: "Fusion prefs channel is not configured." });
      }
      try {
        const bridgeError = await dependencies.prefsChannel.readBridgeError();
        return toolText(bridgeError
          ? { found: true, ...bridgeError }
          : { found: false });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}
