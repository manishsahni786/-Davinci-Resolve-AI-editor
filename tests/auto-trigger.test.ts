import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileBridge } from "../src/bridge/file-bridge.js";
import {
  createRequest,
  createResponse,
  responseFileName,
  serializeResponse
} from "../src/bridge/message-protocol.js";
import { ResolveTrigger, type TriggerRunner } from "../src/bridge/resolve-trigger.js";
import { Logger } from "../src/utils/logger.js";
import { writeTextFileAtomic } from "../src/utils/file-utils.js";
import { createTestSettings } from "./helpers/test-settings.js";

async function makeTriggerRunner(
  overrides: Parameters<typeof createTestSettings>[0] = {}
): Promise<{
  settings: Awaited<ReturnType<typeof createTestSettings>>;
  logger: Logger;
  scriptPath: string;
}> {
  const settings = await createTestSettings(overrides);
  const logger = new Logger({ logDir: settings.logsDir, level: "error", console: false });
  const scriptPath = path.join(settings.projectRoot, "invoke-bridge.ps1");
  await writeFile(scriptPath, "# fake trigger\n", "utf8");
  return { settings, logger, scriptPath };
}

describe("ResolveTrigger", () => {
  it("stays disabled when auto-trigger is off", async () => {
    const { settings, logger, scriptPath } = await makeTriggerRunner();
    const trigger = new ResolveTrigger(
      { ...settings, autoTrigger: false, autoTriggerScriptPath: scriptPath },
      logger
    );
    expect(trigger.enabled).toBe(false);
    const result = await trigger.trigger();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("AUTO_TRIGGER_DISABLED");
  });

  it("stays disabled when the trigger script is missing", async () => {
    const { settings, logger } = await makeTriggerRunner();
    const trigger = new ResolveTrigger(
      { ...settings, autoTrigger: true, autoTriggerScriptPath: path.join(settings.projectRoot, "missing.ps1") },
      logger
    );
    expect(trigger.enabled).toBe(false);
  });

  it("parses a successful trigger result", async () => {
    const { settings, logger, scriptPath } = await makeTriggerRunner();
    const runner: TriggerRunner = async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, item: "AI Video Editor Bridge" })}\n`,
      stderr: ""
    });
    const trigger = new ResolveTrigger(
      { ...settings, autoTrigger: true, autoTriggerScriptPath: scriptPath },
      logger,
      runner
    );
    const result = await trigger.trigger("test");
    expect(result.ok).toBe(true);
    expect(result.item).toBe("AI Video Editor Bridge");
  });

  it("reports a failed trigger result", async () => {
    const { settings, logger, scriptPath } = await makeTriggerRunner();
    const runner: TriggerRunner = async () => ({
      exitCode: 3,
      stdout: `${JSON.stringify({ ok: false, code: "RESOLVE_NOT_RUNNING", message: "not running" })}\n`,
      stderr: ""
    });
    const trigger = new ResolveTrigger(
      { ...settings, autoTrigger: true, autoTriggerScriptPath: scriptPath },
      logger,
      runner
    );
    const result = await trigger.trigger("test");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("RESOLVE_NOT_RUNNING");
  });
});

describe("FileBridge auto-trigger", () => {
  it("receives a response without any manual trigger", async () => {
    const { settings, logger, scriptPath } = await makeTriggerRunner({
      commandTimeoutMs: 3_000,
      pollIntervalMs: 10
    });
    const configured = {
      ...settings,
      autoTrigger: true,
      autoTriggerIntervalMs: 50,
      autoTriggerScriptPath: scriptPath
    };
    const request = createRequest("diagnostics.ping", { id: "auto-trigger-id" });
    let triggerCount = 0;
    const runner: TriggerRunner = async () => {
      triggerCount += 1;
      const response = createResponse({
        request,
        status: "success",
        result: { message: "pong" },
        startedAt: new Date(),
        source: "resolve"
      });
      await writeTextFileAtomic(
        path.join(settings.responsesDir, responseFileName(request.id)),
        serializeResponse(response)
      );
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, item: "AI Video Editor Bridge" })}\n`,
        stderr: ""
      };
    };
    const trigger = new ResolveTrigger(configured, logger, runner);
    const bridge = new FileBridge(configured, logger, undefined, trigger);
    await bridge.initialize();

    const response = await bridge.send(request);
    expect(response.ok).toBe(true);
    expect(triggerCount).toBe(1);
    expect(await bridge.getPendingRequest()).toBeNull();
  });

  it("does not trigger twice after a successful trigger", async () => {
    const { settings, logger, scriptPath } = await makeTriggerRunner({
      commandTimeoutMs: 3_000,
      pollIntervalMs: 10
    });
    const configured = {
      ...settings,
      autoTrigger: true,
      autoTriggerIntervalMs: 20,
      autoTriggerScriptPath: scriptPath
    };
    const request = createRequest("diagnostics.ping", { id: "single-trigger-id" });
    let triggerCount = 0;
    const runner: TriggerRunner = async () => {
      triggerCount += 1;
      const response = createResponse({
        request,
        status: "success",
        result: { message: "pong" },
        startedAt: new Date(),
        source: "resolve"
      });
      setTimeout(() => {
        void writeTextFileAtomic(
          path.join(settings.responsesDir, responseFileName(request.id)),
          serializeResponse(response)
        );
      }, 250);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, item: "AI Video Editor Bridge" })}\n`,
        stderr: ""
      };
    };
    const trigger = new ResolveTrigger(configured, logger, runner);
    const bridge = new FileBridge(configured, logger, undefined, trigger);
    await bridge.initialize();

    const response = await bridge.send(request);
    expect(response.ok).toBe(true);
    expect(triggerCount).toBe(1);
  });

  it("still times out when the trigger never produces a response", async () => {
    const { settings, logger, scriptPath } = await makeTriggerRunner({
      commandTimeoutMs: 300,
      pollIntervalMs: 10
    });
    const configured = {
      ...settings,
      autoTrigger: true,
      autoTriggerIntervalMs: 50,
      autoTriggerScriptPath: scriptPath
    };
    const request = createRequest("diagnostics.ping");
    const runner: TriggerRunner = async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true })}\n`,
      stderr: ""
    });
    const trigger = new ResolveTrigger(configured, logger, runner);
    const bridge = new FileBridge(configured, logger, undefined, trigger);

    await expect(bridge.send(request)).rejects.toThrow(/No response from DaVinci Resolve/);
  });
});
