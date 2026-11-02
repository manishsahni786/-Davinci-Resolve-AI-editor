import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  createRequest,
  createResponse,
  isKnownBridgeCommand,
  isKnownMilestone1Command,
  parseRequest,
  parseResponse,
  responseFileName,
  serializeRequest,
  validateCommandPayload
} from "../src/bridge/message-protocol.js";

describe("bridge message protocol", () => {
  it("creates a valid unique request", () => {
    const first = createRequest("diagnostics.ping");
    const second = createRequest("diagnostics.ping");
    expect(first.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(first.id).not.toBe(second.id);
    expect(first.payload).toEqual({});
    expect(first.source).toBe("node");
  });

  it("round-trips a request through JSON", () => {
    const request = createRequest("bridge.echo", { payload: { value: 42 } });
    const parsed = parseRequest(JSON.parse(serializeRequest(request)));
    expect(parsed).toEqual(request);
  });

  it("rejects unsafe request ids", () => {
    expect(() => createRequest("diagnostics.ping", { id: "../escape" })).toThrow();
  });

  it("parses a success response", () => {
    const request = createRequest("diagnostics.ping");
    const startedAt = new Date("2026-10-30T10:00:00.000Z");
    const completedAt = new Date("2026-10-30T10:00:01.000Z");
    const response = createResponse({
      request,
      status: "success",
      result: { message: "pong" },
      startedAt,
      completedAt,
      source: "mock"
    });
    const parsed = parseResponse(JSON.parse(JSON.stringify(response)));
    expect(parsed.ok).toBe(true);
    expect(parsed.durationMs).toBe(1000);
    expect(parsed.result).toEqual({ message: "pong" });
  });

  it("marks unsupported commands as not ok", () => {
    const request = createRequest("timeline.render");
    const response = createResponse({
      request,
      status: "unsupported",
      error: { code: "UNSUPPORTED_COMMAND", message: "not yet" },
      startedAt: new Date()
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe("unsupported");
  });

  it("knows the Milestone 1 command set", () => {
    expect(isKnownMilestone1Command("diagnostics.ping")).toBe(true);
    expect(isKnownMilestone1Command("render.current")).toBe(false);
  });

  it("knows the Milestone 2 inspection command set", () => {
    expect(isKnownBridgeCommand("project.inspect")).toBe(true);
    expect(isKnownBridgeCommand("media.inspect")).toBe(true);
    expect(isKnownBridgeCommand("timeline.inspect")).toBe(true);
    expect(isKnownBridgeCommand("render.inspect")).toBe(true);
    expect(isKnownBridgeCommand("timeline.render")).toBe(false);
  });

  it("validates inspection payloads and rejects unknown fields", () => {
    expect(validateCommandPayload("timeline.inspect", {
      timelineIndex: 2,
      includeClips: true,
      maxClips: 25
    })).toEqual({ timelineIndex: 2, includeClips: true, maxClips: 25 });

    expect(() => validateCommandPayload("timeline.inspect", { maxClips: 0 })).toThrow();
    expect(() => validateCommandPayload("media.inspect", { unexpected: true })).toThrow();
  });

  it("builds a safe response filename", () => {
    expect(responseFileName("abc-123")).toBe("abc-123.response.json");
  });
});
