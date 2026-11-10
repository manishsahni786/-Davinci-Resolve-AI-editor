import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeManager } from "../src/bridge/bridge-manager.js";
import { FileBridge } from "../src/bridge/file-bridge.js";
import { FusionPrefsChannel } from "../src/bridge/fusion-prefs.js";
import type { AppSettings } from "../src/config/settings.js";
import {
  createMcpServer,
  type McpResolveService,
  type McpServerDependencies
} from "../src/mcp/server.js";
import { PythonMediaAnalysisError, type PythonMediaAnalysis } from "../src/analysis/python-media-analysis.js";
import type { ResolveStatus } from "../src/resolve/resolve-client.js";
import type { BridgeResponseEnvelope } from "../src/types/bridge.types.js";
import { createResponse, serializeResponse } from "../src/bridge/message-protocol.js";
import { Logger } from "../src/utils/logger.js";
import { writeTextFileAtomic } from "../src/utils/file-utils.js";
import { createTestSettings } from "./helpers/test-settings.js";

interface Harness {
  client: Client;
  server: ReturnType<typeof createMcpServer>;
  bridge: FileBridge;
  settings: AppSettings;
}

const harnesses: Harness[] = [];

function inspectionResponse(command: string, result: unknown): BridgeResponseEnvelope {
  const now = new Date();
  return {
    protocolVersion: "1.0",
    id: "fake-id",
    command,
    ok: true,
    status: "success",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    durationMs: 1,
    source: "resolve",
    result,
    meta: {
      resolveVersion: "21.1.0.17",
      isStudio: false,
      projectName: "Test Project"
    }
  };
}

function fakeResolve(): McpResolveService {
  const status = {
    environment: {},
    bridge: {},
    capabilities: { summary: {}, items: [] },
    connection: {
      nodeToResolveDirect: false,
      manualLuaTriggerRequired: true,
      lastRequestPending: false
    }
  } as unknown as ResolveStatus;
  return {
    status: async () => status,
    inspectProject: async () => inspectionResponse("project.inspect", { projectName: "Test Project" }),
    inspectMedia: async () => inspectionResponse("media.inspect", { mediaPool: { clipCount: 0 } }),
    inspectTimeline: async () => inspectionResponse("timeline.inspect", { timelineName: "Timeline 1" }),
    inspectRender: async () => inspectionResponse("render.inspect", { formats: { MP4: "mp4" } }),
    createProject: async (payload: Record<string, unknown>) =>
      inspectionResponse("project.create", { projectName: payload.name }),
    openProject: async (payload: Record<string, unknown>) =>
      inspectionResponse("project.open", { projectName: payload.name }),
    saveProject: async () => inspectionResponse("project.save", { saved: true }),
    createBin: async (payload: Record<string, unknown>) =>
      inspectionResponse("media.createBin", { binPath: payload.name }),
    importMedia: async (payload: Record<string, unknown>) =>
      inspectionResponse("media.import", { count: (payload.filePaths as unknown[]).length }),
    createTimeline: async (payload: Record<string, unknown>) =>
      inspectionResponse("timeline.create", { timelineName: String(payload.name) }),
    appendClips: async (payload: Record<string, unknown>) =>
      inspectionResponse("timeline.appendClips", { appended: { count: (payload.mediaIds as string[]).length } }),
    deleteClips: async (payload: Record<string, unknown>) =>
      inspectionResponse("timeline.deleteClips", { deleted: { count: 1 } }),
    setItemProperty: async (payload: Record<string, unknown>) =>
      inspectionResponse("timeline.setItemProperty", { applied: [] }),
    makeReel: async () => ({
      ok: true,
      steps: [],
      projectName: "Test Project",
      timelineName: "Reel",
      selectedClips: [],
      warnings: [],
      platform: "instagram"
    }),
  };
}

async function createHarness(
  overrides: Pick<McpServerDependencies, "mediaAnalysis"> = {}
): Promise<Harness> {
  const settings = await createTestSettings();
  const logger = new Logger({
    logDir: settings.logsDir,
    level: "error",
    console: false
  });
  const prefsChannel = new FusionPrefsChannel(settings.fusionPrefsPath, logger, 10);
  const bridge = new FileBridge(settings, logger, prefsChannel);
  await bridge.initialize();
  const manager = new BridgeManager(bridge, logger);
  const server = createMcpServer({
    settings,
    bridge,
    manager,
    resolve: fakeResolve(),
    prefsChannel,
    logger,
    mediaAnalysis: overrides.mediaAnalysis
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  const harness = { client, server, bridge, settings };
  harnesses.push(harness);
  return harness;
}

function parseText(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== "text" || first.text === undefined) {
    throw new Error("Expected a text tool result.");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness) {
      await harness.client.close();
      await harness.server.close();
    }
  }
});

describe("AI Video Editor MCP server", () => {
  it("lists the read-only Resolve tools", async () => {
    const { client } = await createHarness();
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("resolve_status");
    expect(names).toContain("resolve_capabilities");
    expect(names).toContain("resolve_inspect_project");
    expect(names).toContain("resolve_inspect_media");
    expect(names).toContain("resolve_inspect_timeline");
    expect(names).toContain("resolve_inspect_render");
    expect(names).toContain("resolve_create_project");
    expect(names).toContain("resolve_open_project");
    expect(names).toContain("resolve_save_project");
    expect(names).toContain("resolve_create_bin");
    expect(names).toContain("resolve_import_media");
    expect(names).toContain("resolve_read_response");
    expect(names).toContain("resolve_clear_pending");
    expect(names).toContain("resolve_last_error");
    expect(names).toContain("resolve_create_editing_plan");
    expect(names).toContain("resolve_get_editing_plan");
    expect(names).toContain("resolve_revise_editing_plan");
    expect(names).toContain("resolve_approve_editing_plan");
    expect(names).toContain("resolve_reject_editing_plan");
    expect(names).toContain("resolve_execute_editing_plan");
    expect(names).toContain("resolve_mark_editing_plan_executed");
  });

  it("lists the management and timeline editing tools", async () => {
    const { client } = await createHarness();
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("resolve_create_timeline");
    expect(names).toContain("resolve_append_clips");
    expect(names).toContain("resolve_delete_clips");
    expect(names).toContain("resolve_set_item_property");
  });

  it("queues Resolve inspection by default for the manual Bridge workflow", async () => {
    const { client, bridge } = await createHarness();
    const queued = parseText(await client.callTool({
      name: "resolve_inspect_project",
      arguments: {}
    }));
    expect(queued.queued).toBe(true);
    expect(queued.autoTrigger).toBe(false);
    expect(String(queued.nextStep)).toContain("Workspace > Scripts");
    await bridge.clearPending();
  });

  it("creates, revises and approves a validated plan without queueing Resolve work", async () => {
    const { client, bridge } = await createHarness();
    const created = parseText(await client.callTool({
      name: "resolve_create_editing_plan",
      arguments: {
        draft: {
          request: { originalInstruction: "Make a short highlight video." },
          project: { timelineName: "Highlight Draft" },
          sources: [{ mediaId: "media-1", filename: "gameplay.mp4", durationSeconds: 20 }],
          clips: [{
            clipId: "segment-1",
            sourceMediaId: "media-1",
            sourceStartSeconds: 0,
            sourceEndSeconds: 20,
            timelineStartSeconds: 0,
            videoTrack: 1,
            description: "Candidate moment",
            relevance: 0.8,
            confidence: 0.7,
            reason: "Supported by the available evidence.",
            evidence: [{ kind: "frame", sourceTimeSeconds: 4, description: "Representative sampled frame." }]
          }],
          requestedDurationSeconds: 20,
          plannedDurationSeconds: 20,
          output: {}
        }
      }
    }));
    expect(created.status).toBe("draft");
    const planId = String(created.planId);
    const prematureExecution = await client.callTool({
      name: "resolve_execute_editing_plan",
      arguments: { planId, expectedRevision: 1 }
    });
    expect(prematureExecution.isError).toBe(true);
    expect(await bridge.getPendingRequest()).toBeNull();

    const approved = parseText(await client.callTool({
      name: "resolve_approve_editing_plan",
      arguments: { planId, expectedRevision: 1, userApproved: true }
    }));
    expect(approved.status).toBe("approved");
    const queued = parseText(await client.callTool({
      name: "resolve_execute_editing_plan",
      arguments: { planId, expectedRevision: 1 }
    }));
    expect(queued.queued).toBe(true);
    expect(queued.planStatus).toBe("executing");
    expect((await bridge.getPendingRequest())?.command).toBe("timeline.create");

    const persist = async (requestId: string, command: string, result: unknown): Promise<void> => {
      const now = new Date().toISOString();
      await writeTextFileAtomic(bridge.responseFilePath(requestId), JSON.stringify({
        protocolVersion: "1.0",
        id: requestId,
        command,
        ok: true,
        status: "success",
        startedAt: now,
        completedAt: now,
        durationMs: 1,
        source: "resolve",
        result
      }));
    };
    const executionId = String(queued.requestId);
    await persist(executionId, "timeline.create", { timelineName: "Highlight Draft" });
    await persist("inspect-1", "timeline.inspect", {
      timeline: { name: "Highlight Draft" },
      tracks: { video: [{ itemCount: 1 }] }
    });
    await persist("save-1", "project.save", { saved: true });
    const executed = parseText(await client.callTool({
      name: "resolve_mark_editing_plan_executed",
      arguments: {
        planId,
        expectedRevision: 1,
        requestId: executionId,
        timelineInspectionRequestId: "inspect-1",
        saveRequestId: "save-1"
      }
    }));
    expect(executed.status).toBe("executed");
  });

  it("queues timeline editing tools without waiting", async () => {
    const { client, bridge } = await createHarness();

    const created = parseText(await client.callTool({
      name: "resolve_create_timeline",
      arguments: { wait: false, name: "Milestone 5 Reel" }
    }));
    expect(created.queued).toBe(true);
    expect(created.command).toBe("timeline.create");
    await bridge.clearPending();

    const appended = parseText(await client.callTool({
      name: "resolve_append_clips",
      arguments: { wait: false, mediaIds: ["media-1", "media-2"] }
    }));
    expect(appended.queued).toBe(true);
    expect(appended.command).toBe("timeline.appendClips");
    await bridge.clearPending();

    const deleted = parseText(await client.callTool({
      name: "resolve_delete_clips",
      arguments: { wait: false, targets: [{ trackType: "video", trackIndex: 1, itemIndices: [2] }] }
    }));
    expect(deleted.queued).toBe(true);
    expect(deleted.command).toBe("timeline.deleteClips");
    await bridge.clearPending();

    const setProperty = parseText(await client.callTool({
      name: "resolve_set_item_property",
      arguments: { wait: false, target: { trackType: "video", trackIndex: 1, itemIndex: 1 }, properties: { "Color": "blue" } }
    }));
    expect(setProperty.queued).toBe(true);
    expect(setProperty.command).toBe("timeline.setItemProperty");

    const pending = await bridge.getPendingRequest();
    expect(pending?.command).toBe("timeline.setItemProperty");
  });

  it("waits for a timeline editing response when requested", async () => {
    const { client } = await createHarness();
    const payload = parseText(await client.callTool({
      name: "resolve_create_timeline",
      arguments: { wait: true, name: "Milestone 5 Reel" }
    }));
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("timeline.create");
  });

  it("rejects timeline editing tool calls with invalid input", async () => {
    const { client } = await createHarness();
    const result = await client.callTool({
      name: "resolve_append_clips",
      arguments: { wait: false, mediaIds: [] }
    });
    expect(result.isError).toBe(true);
  });
  it("returns the capability matrix", async () => {
    const { client } = await createHarness();
    const payload = parseText(await client.callTool({
      name: "resolve_capabilities",
      arguments: {}
    }));
    expect(payload.summary).toBeTypeOf("object");
    const items = payload.items as Array<{ id: string; status: string }>;
    expect(items.find((item) => item.id === "resolve.inspection-readonly")?.status).toBe("verified");
  });

  it("queues an inspection without waiting", async () => {
    const { client, bridge } = await createHarness();
    const payload = parseText(await client.callTool({
      name: "resolve_inspect_project",
      arguments: { wait: false }
    }));
    expect(payload.queued).toBe(true);
    expect(payload.command).toBe("project.inspect");
    const requestId = payload.requestId as string;
    expect(requestId).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(await bridge.getPendingRequest()).not.toBeNull();
  });

  it("returns a matching response after it is published", async () => {
    const { client, bridge } = await createHarness();
    const queued = parseText(await client.callTool({
      name: "resolve_inspect_timeline",
      arguments: { wait: false, timelineIndex: 1 }
    }));
    const requestId = queued.requestId as string;
    const request = {
      protocolVersion: "1.0" as const,
      id: requestId,
      command: "timeline.inspect",
      createdAt: new Date().toISOString(),
      source: "node" as const,
      payload: { timelineIndex: 1 }
    };
    const response = createResponse({
      request,
      status: "success",
      result: { timelineName: "Timeline 1", markers: [] },
      startedAt: new Date(),
      meta: { resolveVersion: "21.1.0.17", projectName: "Test Project" }
    });
    await writeTextFileAtomic(bridge.responseFilePath(requestId), serializeResponse(response));

    const payload = parseText(await client.callTool({
      name: "resolve_read_response",
      arguments: { requestId, waitMs: 0 }
    }));
    expect(payload.id).toBe(requestId);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("timeline.inspect");
  });

  it("waits for an inspection response when requested", async () => {
    const { client } = await createHarness();
    const payload = parseText(await client.callTool({
      name: "resolve_inspect_render",
      arguments: { wait: true }
    }));
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("render.inspect");
  });

  it("clears a pending request only when explicitly confirmed", async () => {
    const { client } = await createHarness();
    await client.callTool({
      name: "resolve_inspect_media",
      arguments: { wait: false }
    });
    const payload = parseText(await client.callTool({
      name: "resolve_clear_pending",
      arguments: { confirm: true }
    }));
    const cleared = payload.cleared as { id: string } | null;
    expect(cleared?.id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("queues project and media management commands without waiting", async () => {
    const { client, bridge } = await createHarness();
    const create = parseText(await client.callTool({
      name: "resolve_create_project",
      arguments: { wait: false, name: "Milestone 4 Test" }
    }));
    expect(create.queued).toBe(true);
    expect(create.command).toBe("project.create");
    await bridge.clearPending();

    const bin = parseText(await client.callTool({
      name: "resolve_create_bin",
      arguments: { wait: false, name: "Footage", parentPath: "B-Roll" }
    }));
    expect(bin.queued).toBe(true);
    expect(bin.command).toBe("media.createBin");
    await bridge.clearPending();

    const imported = parseText(await client.callTool({
      name: "resolve_import_media",
      arguments: { wait: false, filePaths: ["C:/Media/a.mp4"], binPath: "B-Roll" }
    }));
    expect(imported.queued).toBe(true);
    expect(imported.command).toBe("media.import");

    const pending = await bridge.getPendingRequest();
    expect(pending?.command).toBe("media.import");
  });

  it("waits for a management response when requested", async () => {
    const { client } = await createHarness();
    const payload = parseText(await client.callTool({
      name: "resolve_save_project",
      arguments: { wait: true }
    }));
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("project.save");

    const opened = parseText(await client.callTool({
      name: "resolve_open_project",
      arguments: { wait: true, name: "Test Reel", saveCurrent: true }
    }));
    expect(opened.ok).toBe(true);
    expect(opened.command).toBe("project.open");
  });

  it("rejects management tool calls with invalid input", async () => {
    const { client } = await createHarness();
    const result = await client.callTool({
      name: "resolve_create_project",
      arguments: { wait: false, name: "   " }
    });
    expect(result.isError).toBe(true);
  });

  it("maps analyze_events parameters into the Python worker payload", async () => {
    const calls: Array<{ command: string; payload: Record<string, unknown>; signal?: AbortSignal }> = [];
    const mediaAnalysis = {
      run: async (command: string, payload: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        calls.push({ command, payload, signal: options?.signal });
        return { eventCount: 1 };
      }
    } as unknown as PythonMediaAnalysis;
    const { client } = await createHarness({ mediaAnalysis });
    const registeredTool = (await client.listTools()).tools.find((tool) => tool.name === "resolve_analyze_media");

    const result = await client.callTool({
      name: "resolve_analyze_media",
      arguments: {
        path: " C:/Media/clip.mp4 ",
        operation: "analyze_events",
        task: "Find the boss fight.",
        pass1MaxFrames: 12,
        pass2FramesPerEvent: 8,
        maxEvents: 3,
        maxRequests: 10,
        visionBatchSize: 1,
        detectScenes: true
      }
    });

    expect(parseText(result)).toEqual({ eventCount: 1 });
    expect(registeredTool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("analyze_events");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].payload).toEqual({
      path: "C:/Media/clip.mp4",
      task: "Find the boss fight.",
      pass1MaxFrames: 12,
      pass2FramesPerEvent: 8,
      maxEvents: 3,
      maxRequests: 10,
      visionBatchSize: 1,
      detectScenes: true
    });
  });

  it("defaults resolve_analyze_media to analyze_media", async () => {
    const calls: string[] = [];
    const mediaAnalysis = {
      run: async (command: string) => {
        calls.push(command);
        return { analyzed: true };
      }
    } as unknown as PythonMediaAnalysis;
    const { client } = await createHarness({ mediaAnalysis });

    const result = await client.callTool({
      name: "resolve_analyze_media",
      arguments: { path: "C:/Media/clip.mp4" }
    });

    expect(parseText(result)).toEqual({ analyzed: true });
    expect(calls).toEqual(["analyze_media"]);
  });

  it("preserves structured vision offload errors at the MCP boundary", async () => {
    const mediaAnalysis = {
      run: async () => {
        throw new PythonMediaAnalysisError(
          "Vision inference stopped: Ollama reports 32% CPU offload.",
          "VISION_GPU_OFFLOAD_LIMIT",
          { cpuOffloadPercent: 32, maxCpuOffloadPercent: 20 }
        );
      }
    } as unknown as PythonMediaAnalysis;
    const { client } = await createHarness({ mediaAnalysis });

    const result = await client.callTool({
      name: "resolve_analyze_media",
      arguments: { path: "C:/Media/clip.mp4", operation: "analyze_events" }
    });

    expect(result.isError).toBe(true);
    expect(parseText(result)).toMatchObject({
      code: "VISION_GPU_OFFLOAD_LIMIT",
      details: { cpuOffloadPercent: 32, maxCpuOffloadPercent: 20 }
    });
  });

  it("creates a validated plan draft from an analyze_events result", async () => {
    const { client } = await createHarness();
    const plan = parseText(await client.callTool({
      name: "resolve_create_plan_from_analysis",
      arguments: {
        analysis: {
          media: { filename: "demo.mp4", durationSeconds: 60 },
          events: [{
            start_time: 10.5,
            end_time: 15.5,
            description: "Boss encounter starts.",
            category: "encounter",
            confidence: 0.7,
            boundary_precision: "approximate",
            uncertainty_seconds: 1.2,
            evidence: [{ sourceTimeSeconds: 12.5, observation: "Enemy enters frame." }]
          }]
        },
        mediaId: "media-1",
        instruction: "Highlight the boss encounter."
      }
    }));

    expect(typeof plan.planId).toBe("string");
    expect(plan.revision).toBe(1);
    expect(plan.status).toBe("draft");
    expect((plan.clips as Array<{ clipId: string; sourceStartSeconds: number; confidence: number }>)[0])
      .toMatchObject({ clipId: "event-1", sourceStartSeconds: 10.5, confidence: 0.7 });
    expect((plan.warnings as string[]).some((line) => line.includes("converted to whole source frames"))).toBe(true);
  });

  it("rejects plan creation from a malformed analysis result", async () => {
    const { client } = await createHarness();
    const result = await client.callTool({
      name: "resolve_create_plan_from_analysis",
      arguments: { analysis: { events: [] }, mediaId: "media-1" }
    });
    expect(result.isError).toBe(true);
  });

  it("queues frame-accurate source ranges and verifies the inserted clips", async () => {
    const { client, bridge } = await createHarness();
    const created = parseText(await client.callTool({
      name: "resolve_create_editing_plan",
      arguments: {
        draft: {
          request: { originalInstruction: "Build the 90 second acceptance reel." },
          project: { timelineName: "Instagram Reel - Parkour and Combat", saveAfterExecution: false },
          sources: [
            { mediaId: "parkour", filename: "parkour.mp4", durationSeconds: 60, frameRate: 30 },
            { mediaId: "frost", filename: "frosthandler.mp4", durationSeconds: 120, frameRate: 30 },
            { mediaId: "rais", filename: "rais-thugs.mp4", durationSeconds: 90, frameRate: 30 }
          ],
          clips: [
            {
              clipId: "parkour-15s", sourceMediaId: "parkour", sourceStartSeconds: 0, sourceEndSeconds: 15,
              timelineStartSeconds: 0, videoTrack: 1, description: "15 seconds of parkour.",
              relevance: 0.9, confidence: 0.8, reason: "User-selected parkour interval.",
              evidence: [{ kind: "user-selected", sourceTimeSeconds: 0, description: "User selected parkour." }]
            },
            {
              clipId: "frost-35s", sourceMediaId: "frost", sourceStartSeconds: 10, sourceEndSeconds: 45,
              timelineStartSeconds: 15, videoTrack: 1, description: "35 seconds of Frosthandler combat.",
              relevance: 0.9, confidence: 0.8, reason: "User-selected combat interval.",
              evidence: [{ kind: "user-selected", sourceTimeSeconds: 10, description: "User selected combat." }]
            },
            {
              clipId: "rais-40s", sourceMediaId: "rais", sourceStartSeconds: 5, sourceEndSeconds: 45,
              timelineStartSeconds: 50, videoTrack: 1, description: "40 seconds of Rais and thugs.",
              relevance: 0.9, confidence: 0.8, reason: "User-selected thug interval.",
              evidence: [{ kind: "user-selected", sourceTimeSeconds: 5, description: "User selected thugs." }]
            }
          ],
          requestedDurationSeconds: 90,
          plannedDurationSeconds: 90,
          output: { frameRate: 30 }
        }
      }
    }));
    const planId = String(created.planId);
    await client.callTool({
      name: "resolve_approve_editing_plan",
      arguments: { planId, expectedRevision: 1, userApproved: true }
    });

    const queued = parseText(await client.callTool({
      name: "resolve_execute_editing_plan",
      arguments: { planId, expectedRevision: 1 }
    }));
    expect(queued.executionMode).toBe("ranges");
    expect(queued.expectedSegments).toEqual([
      expect.objectContaining({ clipId: "parkour-15s", startFrame: 0, endFrameExclusive: 450, durationFrames: 450, recordFrame: 0 }),
      expect.objectContaining({ clipId: "frost-35s", startFrame: 300, endFrameExclusive: 1350, durationFrames: 1050, recordFrame: 450 }),
      expect.objectContaining({ clipId: "rais-40s", startFrame: 150, endFrameExclusive: 1350, durationFrames: 1200, recordFrame: 1500 })
    ]);
    expect((await bridge.getPendingRequest())?.command).toBe("timeline.createFromRanges");
    const request = JSON.parse(await readFile(bridge.requestFilePath, "utf8")) as {
      payload: { name: string; segments: Array<Record<string, unknown>> };
    };
    expect(request.payload.name).toBe("Instagram Reel - Parkour and Combat");
    expect(request.payload.segments[1]).toEqual({
      mediaId: "frost", startFrame: 300, endFrameExclusive: 1350, trackIndex: 1, recordFrame: 450, includeAudio: true
    });

    const persist = async (requestId: string, command: string, result: unknown): Promise<void> => {
      const now = new Date().toISOString();
      await writeTextFileAtomic(bridge.responseFilePath(requestId), JSON.stringify({
        protocolVersion: "1.0",
        id: requestId,
        command,
        ok: true,
        status: "success",
        startedAt: now,
        completedAt: now,
        durationMs: 1,
        source: "resolve",
        result
      }));
    };
    const timelineName = "Instagram Reel - Parkour and Combat";
    await persist(String(queued.requestId), "timeline.createFromRanges", { timelineName, created: true });
    await persist("inspect-trimmed", "timeline.inspect", {
      timeline: { name: timelineName, startFrame: 0, endFrame: 2700 },
      tracks: {
        video: [{
          index: 1,
          itemCount: 3,
          items: [
            { name: "parkour", start: 0, finish: 450, duration: 450, sourceStartFrame: 0, sourceEndFrame: 450 },
            { name: "frosthandler", start: 450, finish: 1500, duration: 1050, sourceStartFrame: 300, sourceEndFrame: 1350 },
            { name: "rais-thugs", start: 1500, finish: 2700, duration: 1200, sourceStartFrame: 150, sourceEndFrame: 1350 }
          ]
        }]
      }
    });

    const executed = parseText(await client.callTool({
      name: "resolve_mark_editing_plan_executed",
      arguments: {
        planId,
        expectedRevision: 1,
        requestId: String(queued.requestId),
        timelineInspectionRequestId: "inspect-trimmed"
      }
    }));
    expect(executed.status).toBe("executed");
  });
});
