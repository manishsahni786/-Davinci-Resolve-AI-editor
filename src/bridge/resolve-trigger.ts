import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AppSettings } from "../config/settings.js";
import type { Logger } from "../utils/logger.js";

export interface TriggerProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type TriggerRunner = (
  scriptPath: string,
  workingDirectory: string,
  timeoutMs: number
) => Promise<TriggerProcessResult>;

export interface TriggerResult {
  ok: boolean;
  code?: string;
  message?: string;
  item?: string;
  durationMs: number;
}

const DEFAULT_TRIGGER_TIMEOUT_MS = 20_000;

export function runPowerShellTrigger(
  scriptPath: string,
  workingDirectory: string,
  timeoutMs: number
): Promise<TriggerProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: TriggerProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath
      ],
      {
        cwd: workingDirectory,
        windowsHide: true
      }
    );

    const timer = setTimeout(() => {
      child.kill();
      settle({
        exitCode: null,
        stdout,
        stderr: `${stderr}\nTrigger timed out after ${timeoutMs} ms.`
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      settle({ exitCode: null, stdout, stderr: error.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      settle({ exitCode: code, stdout, stderr });
    });
  });
}

function parseTriggerOutput(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return null;
  }
  try {
    const value = JSON.parse(lines[lines.length - 1] as string) as unknown;
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export class ResolveTrigger {
  private inFlight = false;

  constructor(
    private readonly settings: AppSettings,
    private readonly logger: Logger,
    private readonly runner: TriggerRunner = runPowerShellTrigger
  ) {}

  get enabled(): boolean {
    return this.settings.autoTrigger && existsSync(this.settings.autoTriggerScriptPath);
  }

  get busy(): boolean {
    return this.inFlight;
  }

  async trigger(reason = "bridge-wait"): Promise<TriggerResult> {
    const started = Date.now();

    if (!this.enabled) {
      return { ok: false, code: "AUTO_TRIGGER_DISABLED", durationMs: 0 };
    }
    if (this.inFlight) {
      return { ok: false, code: "TRIGGER_BUSY", durationMs: 0 };
    }

    this.inFlight = true;
    this.logger.debug("Auto-triggering the Resolve bridge menu item", {
      reason,
      scriptPath: this.settings.autoTriggerScriptPath
    });

    let processResult: TriggerProcessResult;
    try {
      processResult = await this.runner(
        this.settings.autoTriggerScriptPath,
        this.settings.projectRoot,
        DEFAULT_TRIGGER_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.inFlight = false;
      this.logger.warn("Resolve auto-trigger failed to start", { reason, message });
      return {
        ok: false,
        code: "TRIGGER_START_FAILED",
        message,
        durationMs: Date.now() - started
      };
    }
    this.inFlight = false;

    const durationMs = Date.now() - started;
    const parsed = parseTriggerOutput(processResult.stdout);
    const ok = parsed?.ok === true;

    if (ok) {
      this.logger.debug("Resolve bridge triggered automatically", {
        reason,
        item: parsed?.item,
        durationMs
      });
      return {
        ok: true,
        item: typeof parsed?.item === "string" ? parsed.item : undefined,
        durationMs
      };
    }

    const code = typeof parsed?.code === "string"
      ? parsed.code
      : processResult.exitCode === null
        ? "TRIGGER_TIMEOUT"
        : "TRIGGER_FAILED";
    const message = typeof parsed?.message === "string"
      ? parsed.message
      : (processResult.stderr.trim() || "The auto-trigger script did not report success.");

    if (code !== "TRIGGER_BUSY") {
      this.logger.warn("Resolve auto-trigger did not run the bridge", {
        reason,
        code,
        message,
        exitCode: processResult.exitCode
      });
    }

    return { ok: false, code, message, durationMs };
  }
}
