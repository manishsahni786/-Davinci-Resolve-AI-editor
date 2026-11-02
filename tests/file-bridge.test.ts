import { describe, expect, it } from "vitest";
import path from "node:path";
import { FileBridge } from "../src/bridge/file-bridge.js";
import {
  createRequest,
  createResponse,
  responseFileName,
  serializeResponse
} from "../src/bridge/message-protocol.js";
import { Logger } from "../src/utils/logger.js";
import { BridgeBusyError, BridgeProtocolError, BridgeTimeoutError } from "../src/utils/errors.js";
import { readJsonFile, writeTextFileAtomic, writeJsonFileAtomic } from "../src/utils/file-utils.js";
import { createTestSettings } from "./helpers/test-settings.js";
import { MockResolveAdapter } from "../src/resolve/mock-resolve-adapter.js";
import { FUSION_PREF_KEYS, FusionPrefsChannel } from "../src/bridge/fusion-prefs.js";

async function makeBridge(overrides = {}) {
  const settings = await createTestSettings(overrides);
  const logger = new Logger({ logDir: settings.logsDir, level: "error", console: false });
  const bridge = new FileBridge(settings, logger);
  await bridge.initialize();
  return { settings, logger, bridge };
}

describe("FileBridge", () => {
  it("writes a request atomically in the fixed queue slot", async () => {
    const { bridge } = await makeBridge();
    const request = createRequest("diagnostics.ping");
    await bridge.enqueue(request);

    const onDisk = await readJsonFile<Record<string, unknown>>(bridge.requestFilePath);
    expect(onDisk.id).toBe(request.id);
    expect(onDisk.command).toBe("diagnostics.ping");
  });

  it("rejects a second request while one is pending", async () => {
    const { bridge } = await makeBridge();
    const first = createRequest("diagnostics.ping");
    await bridge.enqueue(first);
    await expect(bridge.enqueue(createRequest("bridge.echo"))).rejects.toBeInstanceOf(BridgeBusyError);
  });

  it("reads a response written by a simulated Lua processor", async () => {
    const { bridge, settings } = await makeBridge({ commandTimeoutMs: 1000 });
    const request = createRequest("diagnostics.ping");
    await bridge.enqueue(request);

    const response = createResponse({
      request,
      status: "success",
      result: { message: "pong", resolveConnected: true },
      startedAt: new Date(),
      source: "mock"
    });
    await writeJsonFileAtomic(
      path.join(settings.responsesDir, responseFileName(request.id)),
      response
    );

    const received = await bridge.waitForResponse(request, 1000);
    expect(received.ok).toBe(true);
    expect(received.result).toEqual({ message: "pong", resolveConnected: true });
    expect(await bridge.getPendingRequest()).toBeNull();
  });

  it("times out without faking success and keeps the request queued", async () => {
    const { bridge } = await makeBridge();
    const request = createRequest("diagnostics.ping");
    await bridge.enqueue(request);

    await expect(bridge.waitForResponse(request, 40)).rejects.toBeInstanceOf(BridgeTimeoutError);
    const pending = await bridge.getPendingRequest();
    expect(pending?.id).toBe(request.id);
  });

  it("rejects a malformed response", async () => {
    const { bridge, settings } = await makeBridge();
    const request = createRequest("diagnostics.ping");
    await bridge.enqueue(request);
    await writeTextFileAtomic(
      path.join(settings.responsesDir, responseFileName(request.id)),
      "{\"not\":\"a response\"}\n"
    );

    await expect(bridge.waitForResponse(request, 200)).rejects.toBeInstanceOf(BridgeProtocolError);
  });

  it("clears a pending request into the archive", async () => {
    const { bridge } = await makeBridge();
    const request = createRequest("diagnostics.ping");
    await bridge.enqueue(request);
    const cleared = await bridge.clearPending("test");
    expect(cleared?.id).toBe(request.id);
    expect(await bridge.getPendingRequest()).toBeNull();
  });

  it("works end-to-end with the mock Resolve adapter", async () => {
    const settings = await createTestSettings({ commandTimeoutMs: 2000 });
    const logger = new Logger({ logDir: settings.logsDir, level: "error", console: false });
    const bridge = new FileBridge(settings, logger);
    const adapter = new MockResolveAdapter(settings, logger, { pollIntervalMs: 10 });
    await bridge.initialize();
    await adapter.start();

    try {
      const request = createRequest("diagnostics.ping");
      const response = await bridge.send(request);
      expect(response.ok).toBe(true);
      expect(response.source).toBe("mock");
      const result = response.result as Record<string, unknown>;
      expect(result.resolveConnected).toBe(true);
      expect(result.message).toBe("pong");
    } finally {
      await adapter.stop();
    }
  });

  it("reads a response published through Fusion preferences", async () => {
    const settings = await createTestSettings({ commandTimeoutMs: 1000 });
    const logger = new Logger({ logDir: settings.logsDir, level: "error", console: false });
    const prefs = new FusionPrefsChannel(settings.fusionPrefsPath, logger, 5);
    const bridge = new FileBridge(settings, logger, prefs);
    await bridge.initialize();

    const request = createRequest("diagnostics.ping");
    await bridge.enqueue(request);
    const response = createResponse({
      request,
      status: "success",
      result: { message: "pong", resolveConnected: true },
      startedAt: new Date()
    });
    const responseHex = Buffer.from(JSON.stringify(response), "utf8").toString("hex");
    const requestIdHex = Buffer.from(request.id, "utf8").toString("hex");
    await writeTextFileAtomic(
      settings.fusionPrefsPath,
      [
        "Global = {",
        `\t${FUSION_PREF_KEYS.responseId} = "${requestIdHex}",`,
        `\t${FUSION_PREF_KEYS.responseHex} = "${responseHex}"`,
        "}",
        ""
      ].join("\n")
    );

    const received = await bridge.waitForResponse(request, 1000);
    expect(received.ok).toBe(true);
    expect(received.result).toEqual({ message: "pong", resolveConnected: true });
    expect(await bridge.getPendingRequest()).toBeNull();
  });

  it("serializes responses with the request id as the filename", async () => {
    const { settings } = await makeBridge();
    const request = createRequest("bridge.echo");
    const response = createResponse({
      request,
      status: "success",
      result: { echoed: request.payload },
      startedAt: new Date(),
      source: "mock"
    });
    const target = path.join(settings.responsesDir, responseFileName(request.id));
    await writeTextFileAtomic(target, serializeResponse(response));
    const parsed = await readJsonFile<Record<string, unknown>>(target);
    expect(parsed.id).toBe(request.id);
  });
});
