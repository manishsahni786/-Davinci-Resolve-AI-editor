#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadSettings } from "./config/settings.js";
import { FileBridge } from "./bridge/file-bridge.js";
import { BridgeManager } from "./bridge/bridge-manager.js";
import { FusionPrefsChannel } from "./bridge/fusion-prefs.js";
import { ResolveTrigger } from "./bridge/resolve-trigger.js";
import { ResolveClient } from "./resolve/resolve-client.js";
import { Logger } from "./utils/logger.js";
import { toAppError } from "./utils/errors.js";
import { createMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const settings = loadSettings();
  const logger = new Logger({
    logDir: settings.logsDir,
    level: settings.logLevel,
    console: false,
    bindings: { component: "mcp-server" }
  });
  const prefsChannel = new FusionPrefsChannel(
    settings.fusionPrefsPath,
    logger.child({ component: "fusion-prefs" }),
    settings.pollIntervalMs
  );
  const trigger = new ResolveTrigger(settings, logger.child({ component: "resolve-trigger" }));
  const bridge = new FileBridge(
    settings,
    logger.child({ component: "file-bridge" }),
    prefsChannel,
    trigger
  );
  const manager = new BridgeManager(bridge, logger.child({ component: "bridge-manager" }));
  const client = new ResolveClient(
    settings,
    manager,
    bridge,
    logger.child({ component: "resolve-client" })
  );

  await bridge.initialize();

  const server = createMcpServer({
    settings,
    bridge,
    manager,
    resolve: client,
    prefsChannel,
    trigger,
    logger
  });
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    logger.info("MCP server shutting down");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await server.connect(transport);
  logger.info("MCP server started over stdio", {
    projectRoot: settings.projectRoot,
    requestsDir: settings.requestsDir,
    responsesDir: settings.responsesDir
  });
}

main().catch((error: unknown) => {
  const appError = toAppError(error);
  process.stderr.write(`${JSON.stringify(appError.toJSON(), null, 2)}\n`);
  process.exitCode = 1;
});
