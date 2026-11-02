import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeManager } from "../src/bridge/bridge-manager.js";
import { FileBridge } from "../src/bridge/file-bridge.js";
import { FusionPrefsChannel } from "../src/bridge/fusion-prefs.js";
import type { AppSettings } from "../src/config/settings.js";
import {
  createMcpServer,
  type McpResolveService
} from "../src/mcp/server.js";
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
    inspectRender: async () => inspectionResponse("render.inspect", { formats: { MP4: "mp4" } })
  };
}

async function createHarness(): Promise<Harness> {
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
    logger
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
    expect(names).toContain("resolve_read_response");
    expect(names).toContain("resolve_clear_pending");
    expect(names).toContain("resolve_last_error");
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
});
