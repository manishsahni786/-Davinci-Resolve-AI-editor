import type { AppSettings } from "../config/settings.js";
import type { Logger } from "../utils/logger.js";
import type { BridgeResponseEnvelope, BridgeHealth } from "../types/bridge.types.js";
import type { EnvironmentSnapshot } from "../types/resolve.types.js";
import type { BridgeManager } from "../bridge/bridge-manager.js";
import type { FileBridge } from "../bridge/file-bridge.js";
import { getEnvironmentSnapshot, probeTcpPort, getResolveProcessInfo } from "../config/environment.js";
import { listCapabilities, summarizeCapabilities } from "./resolve-capabilities.js";
import {
  runReelWorkflow,
  type ReelWorkflowInput,
  type ReelWorkflowResult
} from "./editing-workflow.js";

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

  async inspectProject(
    payload: Record<string, unknown> = {},
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("project.inspect", payload, { timeoutMs });
    return response;
  }

  async inspectMedia(
    payload: Record<string, unknown> = {},
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("media.inspect", payload, { timeoutMs });
    return response;
  }

  async inspectTimeline(
    payload: Record<string, unknown> = {},
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("timeline.inspect", payload, { timeoutMs });
    return response;
  }

  async inspectRender(
    payload: Record<string, unknown> = {},
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("render.inspect", payload, { timeoutMs });
    return response;
  }

  async createProject(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("project.create", payload, { timeoutMs });
    return response;
  }

  async openProject(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("project.open", payload, { timeoutMs });
    return response;
  }

  async saveProject(
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("project.save", {}, { timeoutMs });
    return response;
  }

  async createBin(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("media.createBin", payload, { timeoutMs });
    return response;
  }

  async importMedia(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("media.import", payload, { timeoutMs });
    return response;
  }

  async createTimeline(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("timeline.create", payload, { timeoutMs });
    return response;
  }

  async appendClips(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("timeline.appendClips", payload, { timeoutMs });
    return response;
  }

  async deleteClips(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("timeline.deleteClips", payload, { timeoutMs });
    return response;
  }

  async setItemProperty(
    payload: Record<string, unknown>,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<BridgeResponseEnvelope> {
    const { response } = await this.manager.execute("timeline.setItemProperty", payload, { timeoutMs });
    return response;
  }

  async makeReel(
    input: ReelWorkflowInput,
    timeoutMs = this.settings.commandTimeoutMs
  ): Promise<ReelWorkflowResult> {
    return runReelWorkflow(this, input, timeoutMs);
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
        manualLuaTriggerRequired: bridge.manualTriggerRequired,
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
