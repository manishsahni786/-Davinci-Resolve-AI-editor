import type { AppSettings } from "../config/settings.js";
import type { Logger } from "../utils/logger.js";
import type { BridgeResponseEnvelope, BridgeHealth } from "../types/bridge.types.js";
import type { EnvironmentSnapshot } from "../types/resolve.types.js";
import type { BridgeManager } from "../bridge/bridge-manager.js";
import type { FileBridge } from "../bridge/file-bridge.js";
import { getEnvironmentSnapshot, probeTcpPort, getResolveProcessInfo } from "../config/environment.js";
import { listCapabilities, summarizeCapabilities } from "./resolve-capabilities.js";

export interface PingResult {
  message: string;
  resolveConnected: boolean;
  isStudio: boolean;
  version: string;
  projectName: string | null;
  timelineName: string | null;
  page: string | null;
  scriptContext: string;
}

export interface ResolveStatus {
  environment: EnvironmentSnapshot;
  bridge: BridgeHealth;
  capabilities: {
    summary: Record<string, number>;
    items: ReturnType<typeof listCapabilities>;
  };
  connection: {
    nodeToResolveDirect: boolean;
    manualLuaTriggerRequired: boolean;
    lastRequestPending: boolean;
  };
}

export class ResolveClient {
  constructor(
    private readonly settings: AppSettings,
    private readonly manager: BridgeManager,
    private readonly bridge: FileBridge,
    private readonly logger: Logger
  ) {}

  async ping(timeoutMs = this.settings.commandTimeoutMs): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("diagnostics.ping", {}, { timeoutMs });
    return response;
  }

  async snapshot(timeoutMs = this.settings.commandTimeoutMs): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("diagnostics.snapshot", {}, { timeoutMs });
    return response;
  }

  async status(): Promise<ResolveStatus> {
    const [environment, processInfo, portListening] = await Promise.all([
      getEnvironmentSnapshot(this.settings),
      getResolveProcessInfo(),
      probeTcpPort(1144)
    ]);
    const bridge = await this.bridge.health({
      resolveProcessRunning: processInfo.running,
      externalScriptingPortListening: portListening
    });
    const items = listCapabilities();
    return {
      environment,
      bridge,
      capabilities: {
        summary: summarizeCapabilities(),
        items
      },
      connection: {
        nodeToResolveDirect: portListening,
        manualLuaTriggerRequired: !portListening,
        lastRequestPending: bridge.pendingRequest !== null
      }
    };
  }

  isPingResult(value: unknown): value is PingResult {
    return typeof value === "object"
      && value !== null
      && "message" in value
      && "resolveConnected" in value;
  }
}
