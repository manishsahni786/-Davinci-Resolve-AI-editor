import { describe, expect, it } from "vitest";
import { createResponse } from "../src/bridge/message-protocol.js";
import {
  FUSION_PREF_KEYS,
  FusionPrefsChannel,
  decodeHex,
  parseLuaPrefs,
  unescapeLuaString
} from "../src/bridge/fusion-prefs.js";
import { Logger } from "../src/utils/logger.js";
import { writeTextFileAtomic } from "../src/utils/file-utils.js";
import { createTestSettings } from "./helpers/test-settings.js";

function hex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

async function makeChannel() {
  const settings = await createTestSettings();
  const logger = new Logger({ logDir: settings.logsDir, level: "error", console: false });
  return {
    settings,
    channel: new FusionPrefsChannel(settings.fusionPrefsPath, logger, 5)
  };
}

describe("Fusion preferences channel", () => {
  it("unescapes Lua strings and hex payloads", () => {
    expect(unescapeLuaString("line\\n\\\"quote\\\"")).toBe("line\n\"quote\"");
    expect(decodeHex(hex("hello"))).toBe("hello");
    expect(decodeHex("abc")).toBeNull();
    expect(decodeHex("zz")).toBeNull();
  });

  it("parses the Fusion prefs table syntax", () => {
    const values = parseLuaPrefs([
      "Global = {",
      '\tAIVEBridgeStage = "request-loaded",',
      '\tAIVEBridgeError = "line\\nmessage"',
      "}"
    ].join("\n"));
    expect(values.get("AIVEBridgeStage")).toBe("request-loaded");
    expect(values.get("AIVEBridgeError")).toBe("line\nmessage");
  });

  it("reads a response, stage, error and processed ids", async () => {
    const { settings, channel } = await makeChannel();
    const response = createResponse({
      request: {
        protocolVersion: "1.0",
        id: "request-1",
        command: "diagnostics.ping",
        createdAt: new Date().toISOString(),
        source: "node",
        payload: {}
      },
      status: "success",
      result: { resolveConnected: true },
      startedAt: new Date()
    });

    await writeTextFileAtomic(settings.fusionPrefsPath, [
      "Global = {",
      `\t${FUSION_PREF_KEYS.responseId} = "${hex("request-1")}",`,
      `\t${FUSION_PREF_KEYS.responseHex} = "${hex(JSON.stringify(response))}",`,
      `\t${FUSION_PREF_KEYS.processedId} = "request-0,request-1",`,
      `\t${FUSION_PREF_KEYS.stage} = "response-published",`,
      `\t${FUSION_PREF_KEYS.error} = "previous failure",`,
      `\t${FUSION_PREF_KEYS.errorAt} = "2026-10-30T10:00:00Z"`,
      "}"
    ].join("\n"));

    const state = await channel.readBridgeState();
    expect(state?.stage).toBe("response-published");
    expect(state?.processedIds).toEqual(["request-0", "request-1"]);
    expect(state?.responseId).toBe("request-1");

    const bridgeError = await channel.readBridgeError();
    expect(bridgeError?.message).toBe("previous failure");

    const read = await channel.readResponse("request-1");
    expect(read?.status).toBe("success");
    expect(await channel.readResponse("request-2")).toBeNull();
  });
});
