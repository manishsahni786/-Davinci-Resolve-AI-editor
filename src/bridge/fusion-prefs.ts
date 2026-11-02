import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import type { BridgeResponseEnvelope } from "../types/bridge.types.js";
import type { Logger } from "../utils/logger.js";
import { isMissingFileError, pathExists } from "../utils/file-utils.js";
import { parseJson, parseResponse } from "./message-protocol.js";

export const FUSION_PREF_KEYS = {
  responseId: "AIVideoEditorBridgeResponseId",
  responseHex: "AIVideoEditorBridgeResponseHex",
  processedId: "AIVideoEditorBridgeProcessedId",
  stage: "AIVEBridgeStage",
  error: "AIVEBridgeError",
  errorAt: "AIVEBridgeErrorAt",
  diagnosticsHex: "AIVideoEditorBridgeDiagnosticsHex",
  diagnosticsAt: "AIVideoEditorBridgeDiagnosticsAt"
} as const;

export interface FusionBridgeState {
  stage: string | null;
  error: string | null;
  errorAt: string | null;
  responseId: string | null;
  processedIds: string[];
}

export function unescapeLuaString(value: string): string {
  return value.replace(/\\(x[0-9a-fA-F]{2}|[0-9]{1,3}|.)/g, (_match, escape: string) => {
    if (escape.startsWith("x") && escape.length === 3) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }
    if (/^[0-9]{1,3}$/.test(escape)) {
      return String.fromCharCode(Number.parseInt(escape, 10));
    }
    switch (escape) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "a": return "\u0007";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\u000b";
      case "\\": return "\\";
      case "\"": return "\"";
      case "'": return "'";
      default: return escape;
    }
  });
}

export function parseLuaPrefs(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const pattern = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*"((?:\\.|[^"\\])*)"\s*,?\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], unescapeLuaString(match[2]));
    }
  }
  return values;
}

export function decodeHex(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.length % 2 !== 0) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    return null;
  }
  return Buffer.from(value, "hex").toString("utf8");
}

export class FusionPrefsChannel {
  constructor(
    private readonly prefsPath: string,
    private readonly logger: Logger,
    private readonly pollIntervalMs = 500
  ) {}

  get filePath(): string {
    return this.prefsPath;
  }

  async exists(): Promise<boolean> {
    return pathExists(this.prefsPath);
  }

  async readValues(): Promise<Map<string, string> | null> {
    try {
      const text = await readFile(this.prefsPath, "utf8");
      return parseLuaPrefs(text);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async readResponse(requestId: string): Promise<BridgeResponseEnvelope | null> {
    const values = await this.readValues();
    if (!values) {
      return null;
    }
    const responseId = decodeHex(values.get(FUSION_PREF_KEYS.responseId));
    if (responseId !== requestId) {
      return null;
    }
    const responseJson = decodeHex(values.get(FUSION_PREF_KEYS.responseHex));
    if (responseJson === null) {
      return null;
    }
    try {
      const response = parseResponse(parseJson(responseJson, "Fusion.prefs response"));
      if (response.id !== requestId) {
        this.logger.warn("Fusion prefs response id does not match the request", {
          requestId,
          responseId: response.id
        });
        return null;
      }
      return response;
    } catch (error) {
      this.logger.warn("Fusion prefs response is not valid yet", {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  async waitForResponse(
    requestId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<BridgeResponseEnvelope | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        return null;
      }
      const response = await this.readResponse(requestId);
      if (response) {
        return response;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(this.pollIntervalMs, remaining), undefined, { signal });
    }
    return null;
  }

  async readBridgeState(): Promise<FusionBridgeState | null> {
    const values = await this.readValues();
    if (!values) {
      return null;
    }
    const responseId = decodeHex(values.get(FUSION_PREF_KEYS.responseId));
    const processedValue = values.get(FUSION_PREF_KEYS.processedId) ?? "";
    const processedIds = processedValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    return {
      stage: values.get(FUSION_PREF_KEYS.stage) ?? null,
      error: values.get(FUSION_PREF_KEYS.error) ?? null,
      errorAt: values.get(FUSION_PREF_KEYS.errorAt) ?? null,
      responseId,
      processedIds
    };
  }

  async readBridgeError(): Promise<{ message: string; at: string | null; stage: string | null } | null> {
    const state = await this.readBridgeState();
    if (!state || state.error === null || state.error.trim() === "") {
      return null;
    }
    return {
      message: state.error,
      at: state.errorAt,
      stage: state.stage
    };
  }

  async readDiagnostics(): Promise<unknown | null> {
    const values = await this.readValues();
    if (!values) {
      return null;
    }
    const diagnosticsJson = decodeHex(values.get(FUSION_PREF_KEYS.diagnosticsHex));
    if (diagnosticsJson === null) {
      return null;
    }
    try {
      return parseJson(diagnosticsJson, "Fusion.prefs diagnostics");
    } catch (error) {
      this.logger.warn("Fusion prefs diagnostics are not valid JSON", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
}
