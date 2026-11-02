#!/usr/bin/env node
import path from "node:path";
import { loadSettings } from "./config/settings.js";
import { getEnvironmentSnapshot } from "./config/environment.js";
import { FileBridge } from "./bridge/file-bridge.js";
import { BridgeManager } from "./bridge/bridge-manager.js";
import { FusionPrefsChannel } from "./bridge/fusion-prefs.js";
import {
  createRequest,
  isKnownBridgeCommand,
  type BridgeCommand
} from "./bridge/message-protocol.js";
import { ResolveClient } from "./resolve/resolve-client.js";
import { listCapabilities, summarizeCapabilities } from "./resolve/resolve-capabilities.js";
import { MockResolveAdapter } from "./resolve/mock-resolve-adapter.js";
import { Logger } from "./utils/logger.js";
import { AppError, BridgeTimeoutError, toAppError } from "./utils/errors.js";
import { assertRequestId } from "./utils/validation.js";
import { writeTextFileAtomic } from "./utils/file-utils.js";

const HELP = `
AI Video Editor - Milestone 2 (Resolve inspection commands)

Usage:
  npm run status                 Show environment, bridge and capability status.
  npm run diagnostics            Full environment snapshot and capability matrix.
  npm run capabilities           Print the capability matrix as JSON.
  npm run resolve:test           Queue diagnostics.ping and wait for the manual Lua trigger.
  npm run resolve:queue -- <cmd> Queue a command without waiting (default: diagnostics.ping).
  npm run resolve:read -- <id>   Read a response by request id.
  npm run resolve:error          Show the last bridge error published through Fusion prefs.
  npm run resolve:project        Inspect the current project.
  npm run resolve:media          Inspect the media pool.
  npm run resolve:timeline       Inspect the current timeline.
  npm run resolve:render         Inspect render formats, codecs and presets.
  npm run resolve:diagnostics    Read the report published by the Diagnostics menu item.
  npm run resolve:clear          Archive a pending request without processing it.
  npm run resolve:mock           Run a mock Resolve adapter (no Resolve required).

Inspection commands:
  project.inspect, media.inspect, timeline.inspect, render.inspect

Options:
  --timeout-ms=<number>          Override the bridge wait timeout.

Important:
  DaVinci Resolve Free does not allow external scripting. After queueing a request,
  run in Resolve: Workspace > Scripts > Utility > AI Video Editor Bridge.
`.trim();

function parseTimeout(args: string[]): number | undefined {
  const value = args.find((arg) => arg.startsWith("--timeout-ms="));
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.slice("--timeout-ms=".length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Invalid --timeout-ms value. Use a positive integer."
    });
  }
  return parsed;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const timeoutOverride = parseTimeout(args);

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  const settings = loadSettings();
  const consoleLogging = !["status", "diagnostics", "capabilities"].includes(command);
  const logger = new Logger({
    logDir: settings.logsDir,
    level: settings.logLevel,
    console: consoleLogging,
    bindings: { component: "cli" }
  });
  const bridgeLogger = logger.child({ component: "file-bridge" });
  const prefsChannel = new FusionPrefsChannel(
    settings.fusionPrefsPath,
    logger.child({ component: "fusion-prefs" }),
    settings.pollIntervalMs
  );
  const bridge = new FileBridge(settings, bridgeLogger, prefsChannel);
  const manager = new BridgeManager(bridge, logger.child({ component: "bridge-manager" }));
  const client = new ResolveClient(settings, manager, bridge, logger.child({ component: "resolve-client" }));

  await bridge.initialize();

  switch (command) {
    case "status": {
      const status = await client.status();
      console.log(JSON.stringify(status, null, 2));
      return 0;
    }
    case "diagnostics": {
      const [environment, capabilities] = await Promise.all([
        getEnvironmentSnapshot(settings),
        Promise.resolve({
          summary: summarizeCapabilities(),
          items: listCapabilities()
        })
      ]);
      console.log(JSON.stringify({ environment, capabilities }, null, 2));
      return 0;
    }
    case "capabilities": {
      console.log(JSON.stringify({
        summary: summarizeCapabilities(),
        items: listCapabilities()
      }, null, 2));
      return 0;
    }
    case "test":
      return await runConnectionTest();
    case "queue": {
      const requestedCommand = args.slice(1).find((arg) => !arg.startsWith("--")) ?? "diagnostics.ping";
      if (!isKnownBridgeCommand(requestedCommand)) {
        console.error(`Unknown bridge command: ${requestedCommand}`);
        console.error("Known commands: diagnostics.ping, diagnostics.snapshot, bridge.health, bridge.echo, project.inspect, media.inspect, timeline.inspect, render.inspect");
        return 1;
      }
      const request = createRequest(requestedCommand, {
        ...(timeoutOverride !== undefined ? { timeoutMs: timeoutOverride } : {})
      });
      await bridge.enqueue(request);
      console.log(JSON.stringify({
        queued: true,
        command: request.command,
        requestId: request.id,
        requestPath: bridge.requestFilePath,
        nextStep: "In Resolve: Workspace > Scripts > Utility > AI Video Editor Bridge"
      }, null, 2));
      return 0;
    }
    case "resolve-error": {
      const bridgeError = await prefsChannel.readBridgeError();
      if (!bridgeError) {
        console.log(JSON.stringify({ found: false }, null, 2));
        return 0;
      }
      console.log(JSON.stringify({ found: true, ...bridgeError }, null, 2));
      return 0;
    }
    case "project":
      return await runInspectionCommand("project.inspect");
    case "media":
      return await runInspectionCommand("media.inspect");
    case "timeline":
      return await runInspectionCommand("timeline.inspect");
    case "render":
      return await runInspectionCommand("render.inspect");
    case "resolve-diagnostics": {
      const diagnostics = await prefsChannel.readDiagnostics();
      if (!diagnostics) {
        console.error("No diagnostics report found in Fusion preferences.");
        console.error("Run inside Resolve: Workspace > Scripts > Utility > AI Video Editor Diagnostics");
        return 2;
      }
      const target = path.join(settings.logsDir, "resolve-diagnostics.json");
      await writeTextFileAtomic(target, `${JSON.stringify(diagnostics, null, 2)}\n`);
      console.log(JSON.stringify({ writtenTo: target, diagnostics }, null, 2));
      return 0;
    }
    case "read": {
      const requestId = args[1];
      if (!requestId) {
        console.error("Usage: npm run resolve:read -- <request-id>");
        return 1;
      }
      const response = await bridge.readResponse(assertRequestId(requestId), 1500);
      if (!response) {
        const pending = await bridge.getPendingRequest();
        console.error(JSON.stringify({
          found: false,
          requestId,
          pendingRequest: pending
        }, null, 2));
        return 2;
      }
      console.log(JSON.stringify(response, null, 2));
      return response.status === "success" ? 0 : 1;
    }
    case "clear": {
      const cleared = await bridge.clearPending();
      console.log(JSON.stringify({ cleared }, null, 2));
      return 0;
    }
    case "mock": {
      const adapter = new MockResolveAdapter(settings, logger.child({ component: "mock-resolve" }));
      await adapter.start();
      console.log(JSON.stringify({
        mockAdapter: "running",
        requestsDir: settings.requestsDir,
        responsesDir: settings.responsesDir,
        note: "Press Ctrl+C to stop."
      }, null, 2));
      await new Promise<void>((resolve) => {
        const shutdown = (): void => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          resolve();
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      });
      await adapter.stop();
      return 0;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      return 1;
  }

  async function runInspectionCommand(command: BridgeCommand): Promise<number> {
    const request = createRequest(command, {
      ...(timeoutOverride !== undefined ? { timeoutMs: timeoutOverride } : {})
    });
    const timeoutMs = timeoutOverride ?? settings.commandTimeoutMs;
    await bridge.enqueue(request);

    console.log(`Queued ${command} as ${request.id}`);
    console.log("ACTION REQUIRED in DaVinci Resolve:");
    console.log("  Workspace > Scripts > Utility > AI Video Editor Bridge");
    console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds...`);

    try {
      const response = await bridge.waitForResponse(request, timeoutMs);
      console.log(JSON.stringify(response, null, 2));
      return response.status === "success" ? 0 : 1;
    } catch (error) {
      if (error instanceof BridgeTimeoutError) {
        console.error("NO RESPONSE - manual Lua trigger still required.");
        console.error(error.message);
        console.error(JSON.stringify({ requestId: request.id, details: error.details }, null, 2));
        return error.exitCode;
      }
      throw error;
    }
  }

  async function runConnectionTest(): Promise<number> {
    const environment = await getEnvironmentSnapshot(settings);
    console.log("AI Video Editor - Milestone 1 connection test");
    console.log(`  Resolve running: ${environment.resolveProcess.running ? "yes" : "no"}`
      + (environment.resolveProcess.pid ? ` (PID ${environment.resolveProcess.pid})` : ""));
    console.log(`  Resolve install: ${environment.resolveInstall?.installDir ?? "not detected"}`);
    console.log(`  Resolve version: ${environment.resolveProcess.productVersion ?? environment.resolveProcess.fileVersion ?? "unknown"}`);
    console.log(`  External scripting port ${environment.externalScriptingPort.port}: `
      + `${environment.externalScriptingPort.listening ? "LISTENING" : "closed"}`);

    if (!environment.resolveProcess.running) {
      console.error("\nDaVinci Resolve is not running. Start Resolve, open a project, then run this command again.");
      return 2;
    }

    const request = createRequest("diagnostics.ping", {
      ...(timeoutOverride !== undefined ? { timeoutMs: timeoutOverride } : {})
    });
    const timeoutMs = timeoutOverride ?? settings.commandTimeoutMs;

    await bridge.enqueue(request);

    console.log("");
    console.log(`1. Queued request ${request.id}`);
    console.log(`   ${bridge.requestFilePath}`);
    console.log("");
    console.log("2. ACTION REQUIRED in DaVinci Resolve:");
    console.log("   Workspace > Scripts > Utility > AI Video Editor Bridge");
    console.log(`   Waiting up to ${Math.round(timeoutMs / 1000)} seconds for a response...`);
    console.log("");

    try {
      const response = await bridge.waitForResponse(request, timeoutMs);
      if (response.status !== "success") {
        console.error("Resolve replied with a failure:");
        console.error(JSON.stringify(response, null, 2));
        return 1;
      }

      const result = response.result as Record<string, unknown> | undefined;
      if (!result || result.resolveConnected !== true) {
        console.error("Resolve replied, but a live Resolve API connection was not confirmed.");
        console.error(JSON.stringify(response, null, 2));
        return 1;
      }

      console.log("SUCCESS - Resolve responded through the file bridge.");
      console.log(JSON.stringify({
        requestId: response.id,
        status: response.status,
        durationMs: response.durationMs,
        meta: response.meta,
        result: response.result
      }, null, 2));
      return 0;
    } catch (error) {
      if (error instanceof BridgeTimeoutError) {
        console.error("NO RESPONSE - manual Lua trigger still required.");
        console.error(error.message);
        console.error(JSON.stringify({ requestId: request.id, details: error.details }, null, 2));
        return error.exitCode;
      }
      throw error;
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const appError = toAppError(error);
    console.error(JSON.stringify(appError.toJSON(), null, 2));
    process.exitCode = appError.exitCode;
  });
