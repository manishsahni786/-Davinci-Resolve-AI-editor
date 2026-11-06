import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import type { AppSettings } from "../config/settings.js";
import type { Logger } from "../utils/logger.js";
import type {
  BridgeHealth,
  BridgeRequestEnvelope,
  BridgeResponseEnvelope
} from "../types/bridge.types.js";
import {
  LUA_REQUEST_FILE_NAME,
  REQUEST_FILE_NAME,
  parseJson,
  parseRequest,
  parseResponse,
  responseFileName,
  serializeLuaRequest,
  serializeRequest,
  serializeResponse
} from "./message-protocol.js";
import type { FusionPrefsChannel } from "./fusion-prefs.js";
import type { ResolveTrigger } from "./resolve-trigger.js";
import {
  ensureDir,
  isMissingFileError,
  listFiles,
  moveFile,
  pathExists,
  readJsonFile,
  readTextFile,
  removeFile,
  writeTextFileAtomic
} from "../utils/file-utils.js";
import {
  BridgeBusyError,
  BridgeProtocolError,
  BridgeTimeoutError,
  AppError
} from "../utils/errors.js";

export interface SendOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PendingRequestInfo {
  id: string;
  command: string;
  createdAt: string;
  path: string;
}

export interface RuntimeProbe {
  resolveProcessRunning: boolean;
  externalScriptingPortListening: boolean;
}

export class FileBridge {
  private initialized = false;
  private readonly requestPath: string;
  private readonly luaRequestPath: string;

  constructor(
    private readonly settings: AppSettings,
    private readonly logger: Logger,
    private readonly prefsChannel?: FusionPrefsChannel,
    private readonly trigger?: ResolveTrigger
  ) {
    this.requestPath = path.join(settings.requestsDir, REQUEST_FILE_NAME);
    this.luaRequestPath = path.join(settings.requestsDir, LUA_REQUEST_FILE_NAME);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await Promise.all([
      ensureDir(this.settings.requestsDir),
      ensureDir(this.settings.responsesDir),
      ensureDir(this.settings.archiveDir),
      ensureDir(this.settings.logsDir)
    ]);
    await this.reconcile();
    this.initialized = true;
    this.logger.debug("File bridge initialized", {
      requestsDir: this.settings.requestsDir,
      responsesDir: this.settings.responsesDir
    });
  }

  get requestFilePath(): string {
    return this.requestPath;
  }

  get luaRequestFilePath(): string {
    return this.luaRequestPath;
  }

  responseFilePath(requestId: string): string {
    return path.join(this.settings.responsesDir, responseFileName(requestId));
  }

  async enqueue(request: BridgeRequestEnvelope): Promise<string> {
    await this.ensureInitialized();
    await this.reconcile();

    const pending = await this.getPendingRequest();
    if (pending) {
      if (pending.id === request.id) {
        if (pending.command !== request.command) {
          throw new BridgeProtocolError(
            "A pending request has the same id but a different command.",
            {
              requestId: request.id,
              pendingCommand: pending.command,
              requestedCommand: request.command
            }
          );
        }
        if (!(await pathExists(this.luaRequestPath))) {
          await writeTextFileAtomic(this.luaRequestPath, serializeLuaRequest(request));
        }
        this.logger.info("Bridge request already queued", {
          requestId: request.id,
          command: request.command
        });
        return this.requestPath;
      }
      throw new BridgeBusyError(
        "Another bridge request is already waiting for the Resolve Lua processor. "
          + "Run the bridge script in Resolve, or clear the pending request with `npm run resolve:clear`.",
        { pending }
      );
    }

    await writeTextFileAtomic(this.luaRequestPath, serializeLuaRequest(request));
    await writeTextFileAtomic(this.requestPath, serializeRequest(request));
    this.logger.info("Bridge request queued", {
      requestId: request.id,
      command: request.command,
      requestPath: this.requestPath,
      timeoutMs: request.timeoutMs ?? this.settings.commandTimeoutMs
    });
    return this.requestPath;
  }

  async send(request: BridgeRequestEnvelope, options: SendOptions = {}): Promise<BridgeResponseEnvelope> {
    await this.enqueue(request);
    const timeoutMs = options.timeoutMs ?? request.timeoutMs ?? this.settings.commandTimeoutMs;
    return this.waitForResponse(request, timeoutMs, options.signal);
  }

  async waitForResponse(
    request: BridgeRequestEnvelope,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<BridgeResponseEnvelope> {
    const deadline = Date.now() + timeoutMs;
    const responsePath = this.responseFilePath(request.id);

    this.logger.info("Waiting for Resolve Lua response", {
      requestId: request.id,
      command: request.command,
      responsePath,
      timeoutMs,
      autoTrigger: this.trigger?.enabled ?? false
    });

    let lastTriggerAt = 0;
    let triggerSucceeded = false;
    const maybeTrigger = (reason: string): void => {
      const trigger = this.trigger;
      if (!trigger?.enabled || triggerSucceeded) {
        return;
      }
      if (Date.now() - lastTriggerAt < this.settings.autoTriggerIntervalMs) {
        return;
      }
      lastTriggerAt = Date.now();
      void trigger.trigger(reason).then((result) => {
        if (result.ok) {
          triggerSucceeded = true;
          this.logger.info("Resolve bridge auto-triggered", {
            requestId: request.id,
            reason,
            durationMs: result.durationMs
          });
        }
      });
    };

    maybeTrigger("wait-start");

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new BridgeTimeoutError("Bridge wait was aborted before a response arrived.", {
          requestId: request.id,
          responsePath
        });
      }

      try {
        const text = await readTextFile(responsePath);
        if (text.trim() !== "") {
          const response = parseResponse(parseJson(text, responsePath));
          if (response.id !== request.id) {
            throw new BridgeProtocolError("Bridge response id does not match the request id.", {
              expected: request.id,
              actual: response.id,
              responsePath
            });
          }
          if (response.command !== request.command) {
            this.logger.warn("Bridge response command differs from request", {
              requestId: request.id,
              expectedCommand: request.command,
              actualCommand: response.command
            });
          }
          await this.reconcile();
          this.logger.info("Bridge response received", {
            requestId: request.id,
            command: request.command,
            status: response.status,
            durationMs: response.durationMs
          });
          return response;
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }

      if (this.prefsChannel) {
        const prefResponse = await this.prefsChannel.readResponse(request.id);
        if (prefResponse) {
          await this.persistResponse(prefResponse);
          await this.reconcile();
          this.logger.info("Bridge response received through Fusion prefs", {
            requestId: request.id,
            command: request.command,
            status: prefResponse.status,
            durationMs: prefResponse.durationMs
          });
          return prefResponse;
        }
      }

      maybeTrigger("wait-retry");

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(this.settings.pollIntervalMs, remaining), undefined, { signal });
    }

    this.logger.warn("Bridge response timed out", {
      requestId: request.id,
      command: request.command,
      responsePath
    });

    const hint = this.trigger?.enabled
      ? "No response from DaVinci Resolve. The request is still queued; the automatic "
        + "bridge trigger could not complete it. Confirm Resolve is running with a project "
        + "open, then read the response with:"
      : "No response from DaVinci Resolve. The request is still queued; run "
        + "Workspace > Scripts > Utility > AI Video Editor Bridge in Resolve, "
        + "then read the response with:";

    throw new BridgeTimeoutError(
      `${hint} npm run resolve:read -- ${request.id}`,
      {
        requestId: request.id,
        command: request.command,
        requestPath: this.requestPath,
        responsePath
      }
    );
  }

  async readResponse(requestId: string, waitMs = 0): Promise<BridgeResponseEnvelope | null> {
    const responsePath = this.responseFilePath(requestId);
    const deadline = Date.now() + waitMs;

    while (true) {
      try {
        const text = await readTextFile(responsePath);
        const response = parseResponse(parseJson(text, responsePath));
        if (response.id !== requestId) {
          throw new BridgeProtocolError("Response id does not match the requested id.", {
            expected: requestId,
            actual: response.id,
            responsePath
          });
        }
        await this.reconcile();
        return response;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }

      if (this.prefsChannel) {
        const prefResponse = await this.prefsChannel.readResponse(requestId);
        if (prefResponse) {
          await this.persistResponse(prefResponse);
          await this.reconcile();
          return prefResponse;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      await sleep(Math.min(this.settings.pollIntervalMs, remaining));
    }
  }

  async getPendingRequest(): Promise<PendingRequestInfo | null> {
    try {
      const value = await readJsonFile<unknown>(this.requestPath);
      const request = parseRequest(value);
      return {
        id: request.id,
        command: request.command,
        createdAt: request.createdAt,
        path: this.requestPath
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      if (error instanceof AppError) {
        this.logger.warn("Queued bridge request could not be parsed", {
          requestPath: this.requestPath,
          error: error.toJSON()
        });
        return null;
      }
      throw error;
    }
  }

  async clearPending(reason = "cleared-by-user"): Promise<PendingRequestInfo | null> {
    await this.ensureInitialized();
    const pending = await this.getPendingRequest();
    if (!pending) {
      return null;
    }
    await this.archiveRequestFiles(pending.id, reason);
    this.logger.warn("Pending bridge request cleared", {
      requestId: pending.id,
      command: pending.command,
      reason
    });
    return pending;
  }

  async reconcile(): Promise<void> {
    if (!(await pathExists(this.requestPath)) && !(await pathExists(this.luaRequestPath))) {
      return;
    }
    const pending = await this.getPendingRequest();
    if (!pending) {
      return;
    }
    if (await this.hasResponse(pending.id)) {
      await this.archiveRequestFiles(pending.id);
      this.logger.debug("Archived processed bridge request", {
        requestId: pending.id
      });
    }
  }

  async health(runtime: RuntimeProbe = {
    resolveProcessRunning: false,
    externalScriptingPortListening: false
  }): Promise<BridgeHealth> {
    await this.ensureInitialized();
    const pending = await this.getPendingRequest();
    const responses = await listFiles(this.settings.responsesDir, ".json");
    const fusionState = this.prefsChannel ? await this.prefsChannel.readBridgeState() : null;
    const autoTriggerEnabled = this.trigger?.enabled ?? false;
    return {
      initialized: this.initialized,
      requestsDir: this.settings.requestsDir,
      responsesDir: this.settings.responsesDir,
      archiveDir: this.settings.archiveDir,
      pendingRequest: pending,
      unresolvedResponseCount: responses.length,
      resolveProcessRunning: runtime.resolveProcessRunning,
      externalScriptingPortListening: runtime.externalScriptingPortListening,
      autoTriggerEnabled,
      autoTriggerScriptPath: autoTriggerEnabled ? this.settings.autoTriggerScriptPath : null,
      manualTriggerRequired: !runtime.externalScriptingPortListening && !autoTriggerEnabled,
      fusionPrefsPath: this.prefsChannel?.filePath ?? null,
      fusionPrefsPresent: this.prefsChannel ? await this.prefsChannel.exists() : false,
      fusionBridgeStage: fusionState?.stage ?? null,
      fusionLastError: fusionState?.error || null,
      fusionLastErrorAt: fusionState?.errorAt ?? null
    };
  }

  async cleanupResponse(requestId: string): Promise<void> {
    await removeFile(this.responseFilePath(requestId));
  }

  private async persistResponse(response: BridgeResponseEnvelope): Promise<void> {
    try {
      await writeTextFileAtomic(
        this.responseFilePath(response.id),
        serializeResponse(response)
      );
    } catch (error) {
      this.logger.warn("Could not persist the Fusion prefs response to disk", {
        requestId: response.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async hasResponse(requestId: string): Promise<boolean> {
    if (await pathExists(this.responseFilePath(requestId))) {
      return true;
    }
    if (this.prefsChannel) {
      return (await this.prefsChannel.readResponse(requestId)) !== null;
    }
    return false;
  }

  private async archiveRequestFiles(requestId: string, reason?: string): Promise<void> {
    const timestamp = Date.now();
    const sources = [
      { source: this.requestPath, extension: ".json" },
      { source: this.luaRequestPath, extension: ".lua" }
    ];
    for (const item of sources) {
      if (!(await pathExists(item.source))) {
        continue;
      }
      const suffix = reason
        ? `.request.${reason}-${timestamp}${item.extension}`
        : `.request${item.extension}`;
      let destination = path.join(this.settings.archiveDir, `${requestId}${suffix}`);
      if (await pathExists(destination)) {
        destination = path.join(
          this.settings.archiveDir,
          `${requestId}.request-${timestamp}-${Math.random().toString(16).slice(2, 8)}${item.extension}`
        );
      }
      await moveFile(item.source, destination);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
