import type { Logger } from "../utils/logger.js";
import type { BridgeRequestEnvelope, BridgeResponseEnvelope } from "../types/bridge.types.js";
import { FileBridge, type SendOptions } from "./file-bridge.js";
import {
  createRequest,
  validateCommandPayload,
  type BridgeCommand,
  type CreateRequestOptions
} from "./message-protocol.js";

export class BridgeManager {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bridge: FileBridge,
    private readonly logger: Logger
  ) {}

  async execute(
    command: BridgeCommand,
    payload: Record<string, unknown> = {},
    options: CreateRequestOptions & SendOptions = {}
  ): Promise<{ request: BridgeRequestEnvelope; response: BridgeResponseEnvelope }> {
    return this.enqueueOperation(async () => {
      const request = createRequest(command, {
        payload: validateCommandPayload(command, payload),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.id !== undefined ? { id: options.id } : {})
      });
      this.logger.info("Executing bridge command", {
        requestId: request.id,
        command
      });
      const response = await this.bridge.send(request, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });
      return { request, response };
    });
  }

  async enqueueOnly(
    command: BridgeCommand,
    payload: Record<string, unknown> = {},
    options: CreateRequestOptions = {}
  ): Promise<BridgeRequestEnvelope> {
    return this.enqueueOperation(async () => {
      const request = createRequest(command, {
        payload: validateCommandPayload(command, payload),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.id !== undefined ? { id: options.id } : {})
      });
      await this.bridge.enqueue(request);
      return request;
    });
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
