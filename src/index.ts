#!/usr/bin/env node
import path from "node:path";
import { loadSettings } from "./config/settings.js";
import { getEnvironmentSnapshot } from "./config/environment.js";
import { FileBridge } from "./bridge/file-bridge.js";
import { BridgeManager } from "./bridge/bridge-manager.js";
import { FusionPrefsChannel } from "./bridge/fusion-prefs.js";
import { ResolveTrigger } from "./bridge/resolve-trigger.js";
import {
  createRequest,
  isKnownBridgeCommand,
  type BridgeCommand
} from "./bridge/message-protocol.js";
import { ResolveClient } from "./resolve/resolve-client.js";
import type { ReelWorkflowInput } from "./resolve/editing-workflow.js";
import { listCapabilities, summarizeCapabilities } from "./resolve/resolve-capabilities.js";
import { MockResolveAdapter } from "./resolve/mock-resolve-adapter.js";
import { Logger } from "./utils/logger.js";
import { AppError, BridgeTimeoutError, toAppError } from "./utils/errors.js";
import { assertRequestId } from "./utils/validation.js";
import { writeTextFileAtomic } from "./utils/file-utils.js";

const HELP = `
AI Video Editor - Milestone 5 (Resolve inspection, project/media management and timeline editing)

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
  npm run resolve:timeline-create -- "<name>" [--media-ids=<id,id>]
                                 Create a timeline, optionally from media ids.
  npm run resolve:timeline-append -- <mediaId> [<mediaId>...]
                                 Append media ids to the current timeline.
  npm run resolve:timeline-delete -- <trackType> <trackIndex> <itemIndex>...
                                 Delete timeline items.
  npm run resolve:timeline-set-property -- <trackType> <trackIndex> <itemIndex> --key=<key> [--value=<value>]
                                 Set a property on a timeline item.
  npm run resolve:render         Inspect render formats, codecs and presets.
  npm run resolve:project-create -- "<name>" [--media-path=<path>]
                                 Create and open a new project.
  npm run resolve:project-open -- "<name>" [--save-current]
                                 Open an existing project.
  npm run resolve:project-save   Save the current project.
  npm run resolve:bin-create -- "<name>" [--parent=<bin/path>]
                                 Create a media pool bin.
  npm run resolve:media-import -- <path> [<path>...] [--bin=<bin/path>]
                                 Import media into the current or target bin.
  npm run reel -- [--project=<name>] [--media=<path,path>] [--topic=<words>]
                 [--platform=instagram|youtube] [--clip-ids=<id,id>]
                 [--timeline=<name>] [--bin=<name>] [--max-clips=<n>] [--no-save]
                                 Build a whole-clip rough cut; launch Bridge for each request.
  npm run resolve:diagnostics    Read the report published by the Diagnostics menu item.
  npm run resolve:clear          Archive a pending request without processing it.
  npm run resolve:mock           Run a mock Resolve adapter (no Resolve required).

Inspection commands:
  project.inspect, media.inspect, timeline.inspect, render.inspect

Management commands:
  project.create, project.open, project.save, media.createBin, media.import

Timeline editing commands:
  timeline.create, timeline.appendClips, timeline.deleteClips, timeline.setItemProperty

Options:
  --timeout-ms=<number>          Override the bridge wait timeout.

Important:
  DaVinci Resolve Free does not allow external scripting. Commands are executed by
  manually launching Workspace > Scripts > Utility > AI Video Editor Bridge for
  each request. Optional Windows UI automation is disabled by default.
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

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value?.slice(prefix.length);
}

function positionalArgs(args: string[]): string[] {
  return args.slice(1).filter((arg) => !arg.startsWith("--"));
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
  const trigger = new ResolveTrigger(settings, logger.child({ component: "resolve-trigger" }));
  const bridge = new FileBridge(settings, bridgeLogger, prefsChannel, trigger);
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
        console.error("Known commands: diagnostics.ping, diagnostics.snapshot, bridge.health, bridge.echo, project.inspect, media.inspect, timeline.inspect, render.inspect, project.create, project.open, project.save, media.createBin, media.import, timeline.create, timeline.appendClips, timeline.deleteClips, timeline.setItemProperty");
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
        autoTrigger: trigger.enabled,
        nextStep: trigger.enabled
          ? "The bridge is triggered automatically when you wait for the response."
          : "In Resolve: Workspace > Scripts > Utility > AI Video Editor Bridge"
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
    case "project-create": {
      const name = positionalArgs(args)[0];
      if (!name) {
        console.error('Usage: npm run resolve:project-create -- "<name>" [--media-path=<path>]');
        return 1;
      }
      const mediaPath = optionValue(args, "media-path");
      return await runManagementCommand("project.create", {
        name,
        ...(mediaPath !== undefined ? { mediaPath } : {})
      });
    }
    case "project-open": {
      const name = positionalArgs(args)[0];
      if (!name) {
        console.error('Usage: npm run resolve:project-open -- "<name>" [--save-current]');
        return 1;
      }
      return await runManagementCommand("project.open", {
        name,
        saveCurrent: args.includes("--save-current")
      });
    }
    case "project-save":
      return await runManagementCommand("project.save", {});
    case "bin-create": {
      const name = positionalArgs(args)[0];
      if (!name) {
        console.error('Usage: npm run resolve:bin-create -- "<name>" [--parent=<bin/path>]');
        return 1;
      }
      const parentPath = optionValue(args, "parent");
      return await runManagementCommand("media.createBin", {
        name,
        ...(parentPath !== undefined ? { parentPath } : {})
      });
    }
    case "media-import": {
      const filePaths = positionalArgs(args);
      if (filePaths.length === 0) {
        console.error("Usage: npm run resolve:media-import -- <path> [<path>...] [--bin=<bin/path>]");
        return 1;
      }
      const binPath = optionValue(args, "bin");
      return await runManagementCommand("media.import", {
        filePaths,
        ...(binPath !== undefined ? { binPath } : {})
      });
    }
    case "timeline-create": {
      const name = positionalArgs(args)[0];
      const mediaIdsValue = optionValue(args, "media-ids");
      const mediaIds = mediaIdsValue
        ? mediaIdsValue.split(",").map((id) => id.trim()).filter((id) => id !== "")
        : [];
      if (!name && mediaIds.length === 0) {
        console.error('Usage: npm run resolve:timeline-create -- "<name>" [--media-ids=<id,id>]');
        return 1;
      }
      const payload: Record<string, unknown> = {
        ...(name !== undefined ? { name } : {}),
        ...(mediaIds.length > 0 ? { mediaIds } : {})
      };
      return await runManagementCommand("timeline.create", payload);
    }
    case "timeline-append": {
      const mediaIds = positionalArgs(args);
      if (mediaIds.length === 0) {
        console.error("Usage: npm run resolve:timeline-append -- <mediaId> [<mediaId>...]");
        return 1;
      }
      return await runManagementCommand("timeline.appendClips", { mediaIds });
    }
    case "timeline-delete": {
      const positionals = positionalArgs(args);
      if (positionals.length < 3) {
        console.error("Usage: npm run resolve:timeline-delete -- <trackType> <trackIndex> <itemIndex>...");
        return 1;
      }
      const trackType = positionals[0];
      const trackIndex = Number(positionals[1]);
      const itemIndices = positionals.slice(2).map((value) => Number(value));
      if (
        !(trackType === "video" || trackType === "audio" || trackType === "subtitle")
        || !Number.isInteger(trackIndex) || trackIndex < 1 || trackIndex > 100
        || itemIndices.length === 0
        || itemIndices.some((value) => !Number.isInteger(value) || value < 1 || value > 500)
      ) {
        console.error("Invalid timeline delete target. Use: <trackType> <trackIndex> <itemIndex>...");
        return 1;
      }
      return await runManagementCommand("timeline.deleteClips", {
        targets: [{ trackType, trackIndex, itemIndices }]
      });
    }
    case "timeline-set-property": {
      const positionals = positionalArgs(args);
      const trackType = positionals[0];
      const trackIndex = Number(positionals[1]);
      const itemIndex = Number(positionals[2]);
      const key = optionValue(args, "key");
      const rawValue = optionValue(args, "value");
      let value: string | number | boolean = true;
      const trimmedValue = rawValue?.trim();
      if (trimmedValue !== undefined && trimmedValue !== "") {
        if (/^true$/i.test(trimmedValue)) {
          value = true;
        } else if (/^false$/i.test(trimmedValue)) {
          value = false;
        } else if (/^-?\d+(\.\d+)?$/.test(trimmedValue)) {
          value = Number(trimmedValue);
        } else {
          value = trimmedValue;
        }
      }
      if (
        !(trackType === "video" || trackType === "audio" || trackType === "subtitle")
        || !Number.isInteger(trackIndex) || trackIndex < 1 || trackIndex > 100
        || !Number.isInteger(itemIndex) || itemIndex < 1 || itemIndex > 500
        || !key
      ) {
        console.error('Usage: npm run resolve:timeline-set-property -- <trackType> <trackIndex> <itemIndex> --key=<key> [--value=<value>]');
        return 1;
      }
      return await runManagementCommand("timeline.setItemProperty", {
        target: { trackType, trackIndex, itemIndex },
        properties: { [key]: value }
      });
    }
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
    case "reel": {
      const mediaValue = optionValue(args, "media");
      const clipIdsValue = optionValue(args, "clip-ids");
      const maxClipsValue = optionValue(args, "max-clips");
      const platformValue = optionValue(args, "platform");
      if (
        platformValue !== undefined
        && platformValue !== "instagram"
        && platformValue !== "youtube"
      ) {
        console.error("Invalid --platform value. Use instagram or youtube.");
        return 1;
      }
      const maxClips = maxClipsValue === undefined ? undefined : Number(maxClipsValue);
      if (
        maxClips !== undefined
        && (!Number.isInteger(maxClips) || maxClips < 1 || maxClips > 100)
      ) {
        console.error("Invalid --max-clips value. Use an integer from 1 to 100.");
        return 1;
      }

      const input: ReelWorkflowInput = {};
      const projectName = optionValue(args, "project");
      if (projectName !== undefined) input.projectName = projectName;
      if (mediaValue !== undefined) {
        input.mediaPaths = mediaValue.split(",").map((value) => value.trim()).filter((value) => value !== "");
      }
      const binName = optionValue(args, "bin");
      if (binName !== undefined) input.binName = binName;
      if (clipIdsValue !== undefined) {
        input.clipIds = clipIdsValue.split(",").map((value) => value.trim()).filter((value) => value !== "");
      }
      const timelineName = optionValue(args, "timeline");
      if (timelineName !== undefined) input.timelineName = timelineName;
      const topic = optionValue(args, "topic");
      if (topic !== undefined) input.topic = topic;
      if (platformValue !== undefined) input.platform = platformValue;
      if (maxClips !== undefined) input.maxClips = maxClips;
      if (args.includes("--no-save")) input.save = false;

      const result = await client.makeReel(input, timeoutOverride ?? settings.commandTimeoutMs);
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
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
    if (trigger.enabled) {
      console.log("Auto-triggering the Resolve bridge (no manual click required).");
    } else {
      console.log("ACTION REQUIRED in DaVinci Resolve:");
      console.log("  Workspace > Scripts > Utility > AI Video Editor Bridge");
    }
    console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds...`);

    try {
      const response = await bridge.waitForResponse(request, timeoutMs);
      console.log(JSON.stringify(response, null, 2));
      return response.status === "success" ? 0 : 1;
    } catch (error) {
      if (error instanceof BridgeTimeoutError) {
        console.error(trigger.enabled
          ? "NO RESPONSE - the automatic Resolve trigger did not complete the request."
          : "NO RESPONSE - manual Lua trigger still required.");
        console.error(error.message);
        console.error(JSON.stringify({ requestId: request.id, details: error.details }, null, 2));
        return error.exitCode;
      }
      throw error;
    }
  }

  async function runManagementCommand(
    command: BridgeCommand,
    payload: Record<string, unknown>
  ): Promise<number> {
    const timeoutMs = timeoutOverride ?? settings.commandTimeoutMs;
    const request = await manager.enqueueOnly(command, payload, { timeoutMs });
    console.log(`Queued ${command} as ${request.id}`);
    if (trigger.enabled) {
      console.log("Auto-triggering the Resolve bridge (no manual click required).");
    } else {
      console.log("ACTION REQUIRED in DaVinci Resolve:");
      console.log("  Workspace > Scripts > Utility > AI Video Editor Bridge");
    }
    console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds...`);

    try {
      const response = await bridge.waitForResponse(request, timeoutMs);
      console.log(JSON.stringify(response, null, 2));
      return response.status === "success" ? 0 : 1;
    } catch (error) {
      if (error instanceof BridgeTimeoutError) {
        console.error(trigger.enabled
          ? "NO RESPONSE - the automatic Resolve trigger did not complete the request."
          : "NO RESPONSE - manual Lua trigger still required.");
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
    if (trigger.enabled) {
      console.log("2. Auto-triggering the Resolve bridge (no manual click required).");
    } else {
      console.log("2. ACTION REQUIRED in DaVinci Resolve:");
      console.log("   Workspace > Scripts > Utility > AI Video Editor Bridge");
    }
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
        console.error(trigger.enabled
          ? "NO RESPONSE - the automatic Resolve trigger did not complete the request."
          : "NO RESPONSE - manual Lua trigger still required.");
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
