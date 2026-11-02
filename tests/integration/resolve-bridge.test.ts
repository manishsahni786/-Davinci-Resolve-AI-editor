import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/config/settings.js";
import { FileBridge } from "../../src/bridge/file-bridge.js";
import { createRequest } from "../../src/bridge/message-protocol.js";
import { Logger } from "../../src/utils/logger.js";

const enabled = process.env.AVE_INTEGRATION === "1";

describe.skipIf(!enabled)("Resolve Lua bridge integration", () => {
  it("receives diagnostics.ping after the manual Scripts-menu trigger", async () => {
    const settings = loadSettings({
      commandTimeoutMs: Number(process.env.AVE_INTEGRATION_TIMEOUT_MS ?? 180_000)
    });
    const logger = new Logger({ logDir: settings.logsDir, level: "info", console: false });
    const bridge = new FileBridge(settings, logger);
    await bridge.initialize();

    const request = createRequest("diagnostics.ping");
    console.log(
      `Queued ${request.id}. Trigger: Workspace > Scripts > Utility > AI Video Editor Bridge`
    );
    const response = await bridge.send(request, { timeoutMs: settings.commandTimeoutMs });
    expect(response.ok).toBe(true);
    const result = response.result as Record<string, unknown>;
    expect(result.resolveConnected).toBe(true);
  }, 240_000);
});
