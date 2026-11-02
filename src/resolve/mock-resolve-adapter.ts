import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppSettings } from "../config/settings.js";
import type { Logger } from "../utils/logger.js";
import type {
  BridgeErrorInfo,
  BridgeRequestEnvelope,
  BridgeResponseEnvelope,
  BridgeResponseStatus
} from "../types/bridge.types.js";
import {
  REQUEST_FILE_NAME,
  createResponse,
  isKnownMilestone1Command,
  parseRequest,
  responseFileName,
  serializeResponse
} from "../bridge/message-protocol.js";
import {
  ensureDir,
  isMissingFileError,
  moveFile,
  pathExists,
  readJsonFile,
  writeTextFileAtomic
} from "../utils/file-utils.js";

export interface MockResolveAdapterOptions {
  latencyMs?: number;
  pollIntervalMs?: number;
  version?: string;
  isStudio?: boolean;
  projectName?: string;
  timelineName?: string;
}

export class MockResolveAdapter {
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private readonly options: Required<MockResolveAdapterOptions>;
  private readonly requestPath: string;

  constructor(
    private readonly settings: AppSettings,
    private readonly logger: Logger,
    options: MockResolveAdapterOptions = {}
  ) {
    this.options = {
      latencyMs: options.latencyMs ?? 0,
      pollIntervalMs: options.pollIntervalMs ?? 100,
      version: options.version ?? "21.1.0.17-mock",
      isStudio: options.isStudio ?? false,
      projectName: options.projectName ?? "Mock Project",
      timelineName: options.timelineName ?? "Mock Timeline"
    };
    this.requestPath = path.join(settings.requestsDir, REQUEST_FILE_NAME);
  }

  async start(): Promise<void> {
    await this.ensureLayout();
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.processOnce();
    }, this.options.pollIntervalMs);
    this.logger.info("Mock Resolve adapter started", {
      requestsDir: this.settings.requestsDir,
      pollIntervalMs: this.options.pollIntervalMs
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("Mock Resolve adapter stopped");
  }

  async processOnce(): Promise<BridgeResponseEnvelope | null> {
    if (this.processing) {
      return null;
    }
    this.processing = true;
    try {
      if (!(await pathExists(this.requestPath))) {
        return null;
      }
      let request: BridgeRequestEnvelope;
      try {
        request = parseRequest(await readJsonFile(this.requestPath));
      } catch (error) {
        this.logger.warn("Mock adapter ignored an invalid request", {
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      }

      if (this.options.latencyMs > 0) {
        await sleep(this.options.latencyMs);
      }

      const startedAt = new Date();
      const response = this.buildResponse(request, startedAt);
      await writeTextFileAtomic(
        path.join(this.settings.responsesDir, responseFileName(request.id)),
        serializeResponse(response)
      );
      await this.archiveRequest(request);
      this.logger.info("Mock adapter responded", {
        requestId: request.id,
        command: request.command,
        status: response.status
      });
      return response;
    } finally {
      this.processing = false;
    }
  }

  private buildResponse(
    request: BridgeRequestEnvelope,
    startedAt: Date
  ): BridgeResponseEnvelope {
    const baseMeta = {
      resolveVersion: this.options.version,
      isStudio: this.options.isStudio,
      projectName: this.options.projectName,
      timelineName: this.options.timelineName,
      scriptContext: "mock-resolve-adapter"
    };

    if (!isKnownMilestone1Command(request.command)) {
      return createResponse({
        request,
        status: "unsupported",
        error: {
          code: "UNSUPPORTED_COMMAND",
          message: `Command "${request.command}" is not implemented in Milestone 1.`
        },
        startedAt,
        source: "mock",
        meta: baseMeta
      });
    }

    let status: BridgeResponseStatus = "success";
    let result: unknown;
    let error: BridgeErrorInfo | undefined;

    switch (request.command) {
      case "diagnostics.ping":
        result = {
          message: "pong",
          resolveConnected: true,
          isStudio: this.options.isStudio,
          version: this.options.version,
          projectName: this.options.projectName,
          timelineName: this.options.timelineName,
          page: "edit",
          scriptContext: "mock-resolve-adapter"
        };
        break;
      case "diagnostics.snapshot":
        result = {
          connected: true,
          version: this.options.version,
          isStudio: this.options.isStudio,
          projectName: this.options.projectName,
          timelineName: this.options.timelineName,
          mock: true
        };
        break;
      case "bridge.echo":
        result = { echoed: request.payload };
        break;
      case "bridge.health":
        result = {
          mock: true,
          requestsDir: this.settings.requestsDir,
          responsesDir: this.settings.responsesDir
        };
        break;
      default:
        status = "error";
        error = { code: "UNREACHABLE", message: "Unhandled mock command." };
        break;
    }

    return createResponse({
      request,
      status,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      startedAt,
      source: "mock",
      meta: baseMeta
    });
  }

  private async archiveRequest(request: BridgeRequestEnvelope): Promise<void> {
    const destination = path.join(this.settings.archiveDir, `${request.id}.request.json`);
    try {
      await moveFile(this.requestPath, destination);
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.logger.warn("Mock adapter could not archive request", {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async ensureLayout(): Promise<void> {
    await Promise.all([
      ensureDir(this.settings.requestsDir),
      ensureDir(this.settings.responsesDir),
      ensureDir(this.settings.archiveDir),
      ensureDir(this.settings.logsDir)
    ]);
  }
}
