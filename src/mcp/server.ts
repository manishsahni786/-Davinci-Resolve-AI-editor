import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AppSettings } from "../config/settings.js";
import type { FileBridge } from "../bridge/file-bridge.js";
import type { BridgeManager } from "../bridge/bridge-manager.js";
import type { FusionPrefsChannel } from "../bridge/fusion-prefs.js";
import type { BridgeResponseEnvelope } from "../types/bridge.types.js";
import type { BridgeCommand } from "../bridge/message-protocol.js";
import type { ResolveStatus } from "../resolve/resolve-client.js";
import { listCapabilities, summarizeCapabilities } from "../resolve/resolve-capabilities.js";
import { toAppError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { z } from "zod";

export const MCP_SERVER_NAME = "ai-video-editor";
export const MCP_SERVER_VERSION = "0.1.0";

const MANUAL_ACTION = "In Resolve: Workspace > Scripts > Utility > AI Video Editor Bridge";

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

const TIMEOUT_DESCRIPTION = "Maximum time to wait for the manual Resolve trigger, in milliseconds.";
const WAIT_DESCRIPTION = "When true, wait for the manual Resolve trigger and return the response. When false (default), queue the request and return its id immediately.";

export interface McpResolveService {
  status(): Promise<ResolveStatus>;
  inspectProject(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  inspectMedia(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  inspectTimeline(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  inspectRender(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
}

export interface McpServerDependencies {
  settings: AppSettings;
  bridge: FileBridge;
  manager: BridgeManager;
  resolve: McpResolveService;
  prefsChannel?: FusionPrefsChannel;
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
  return toolText(toAppError(error).toJSON(), true);
}

function queuedResponse(
  dependencies: McpServerDependencies,
  command: string,
  requestId: string
): Record<string, unknown> {
  return {
    queued: true,
    command,
    requestId,
    pendingRequestPath: dependencies.bridge.requestFilePath,
    responsePath: dependencies.bridge.responseFilePath(requestId),
    nextStep: MANUAL_ACTION,
    then: `Call resolve_read_response with requestId ${requestId}.`
  };
}

function hasWait(value: { wait?: boolean | undefined }): boolean {
  return value.wait === true;
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
      description: "Inspect the current project and project list. Read-only. By default this queues a request; set wait=true to wait for the manual Resolve trigger.",
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
      if (!hasWait(args)) {
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
      description: "Inspect media-pool bins and clips. Read-only. By default this queues a request; set wait=true to wait for the manual Resolve trigger.",
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
      if (!hasWait(args)) {
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
      description: "Inspect the current or indexed timeline, including tracks, clip items and markers. Read-only. By default this queues a request; set wait=true to wait for the manual Resolve trigger.",
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
      if (!hasWait(args)) {
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
      description: "Inspect render formats, codecs, presets and current format/codec. Read-only. By default this queues a request; set wait=true to wait for the manual Resolve trigger.",
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
      if (!hasWait(args)) {
        return queueInspection(dependencies, "render.inspect", payload, args.timeoutMs);
      }
      return waitForInspection(dependencies, "render.inspect", () =>
        dependencies.resolve.inspectRender(payload, args.timeoutMs ?? dependencies.settings.commandTimeoutMs)
      );
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
        const response = await dependencies.bridge.readResponse(args.requestId, args.waitMs ?? 3000);
        if (!response) {
          const pending = await dependencies.bridge.getPendingRequest();
          return toolText({
            found: false,
            requestId: args.requestId,
            pendingRequest: pending,
            nextStep: MANUAL_ACTION
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
