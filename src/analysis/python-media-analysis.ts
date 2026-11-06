import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "../config/settings.js";
import { AnalysisResultCache } from "./analysis-result-cache.js";

const COMMANDS = new Set([
  "probe_media", "discover_media", "detect_scenes", "sample_frames",
  "detect_silence", "transcribe", "analyze_media", "analyze_events"
]);
const VISION_COMMANDS = new Set(["analyze_media", "analyze_events"]);
const DEFAULT_EVENT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_MEDIA_TIMEOUT_MS = 15 * 60_000;

function pythonExecutable(projectRoot: string): string {
  const configured = process.env.AVE_PYTHON_PATH?.trim();
  if (configured) return configured;
  const localVenv = process.platform === "win32"
    ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
    : path.join(projectRoot, ".venv", "bin", "python");
  return existsSync(localVenv) ? localVenv : "python";
}

export interface MediaAnalysisRunOptions {
  signal?: AbortSignal;
}

export class PythonMediaAnalysisError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "PythonMediaAnalysisError";
  }
}

function timeoutFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 86_400_000) return fallback;
  return Math.floor(value);
}

export class PythonMediaAnalysis {
  private readonly resultCache: AnalysisResultCache;
  private activeVisionJobId: string | null = null;

  constructor(
    private readonly settings: AppSettings,
    resultCache: AnalysisResultCache | null = null,
    private readonly spawnProcess: typeof spawn = spawn
  ) {
    this.resultCache = resultCache ?? new AnalysisResultCache(settings.dataDir);
  }

  async run(
    command: string,
    payload: Record<string, unknown>,
    options: MediaAnalysisRunOptions = {}
  ): Promise<unknown> {
    if (!COMMANDS.has(command)) throw new Error(`Unsupported media analysis command: ${command}`);
    if (options.signal?.aborted) {
      throw new PythonMediaAnalysisError("Media analysis was cancelled before it started.", "ANALYSIS_CANCELLED");
    }
    const cached = await this.resultCache.load(command, payload);
    if (cached !== null) return cached;

    const isVision = VISION_COMMANDS.has(command);
    if (isVision && this.activeVisionJobId) {
      throw new PythonMediaAnalysisError(
        `Vision analysis is already running as job ${this.activeVisionJobId}. Retry after it finishes.`,
        "VISION_BUSY",
        { activeJobId: this.activeVisionJobId }
      );
    }

    const jobId = randomUUID();
    if (isVision) this.activeVisionJobId = jobId;
    const workerPayload = command === "analyze_events" ? { ...payload, jobId } : payload;
    try {
      const result = await this.runWorker(command, workerPayload, jobId, options.signal);
      await this.resultCache.save(command, payload, result);
      return result;
    } finally {
      if (this.activeVisionJobId === jobId) this.activeVisionJobId = null;
    }
  }

  private async runWorker(
    command: string,
    payload: Record<string, unknown>,
    jobId: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    const python = pythonExecutable(this.settings.projectRoot);
    const script = path.join(this.settings.projectRoot, "python", "worker.py");
    const timeoutMs = command === "analyze_events"
      ? timeoutFromEnvironment("AVE_ANALYSIS_TIMEOUT_MS", DEFAULT_EVENT_TIMEOUT_MS)
      : timeoutFromEnvironment("AVE_MEDIA_ANALYSIS_TIMEOUT_MS", DEFAULT_MEDIA_TIMEOUT_MS);
    const cancellationDir = path.join(this.settings.dataDir, "analysis-cache", "cancellations");
    const cancellationPath = path.join(cancellationDir, `${jobId}.cancel`);
    await fs.mkdir(cancellationDir, { recursive: true });
    await fs.rm(cancellationPath, { force: true });

    if (signal?.aborted) {
      throw new PythonMediaAnalysisError("Media analysis was cancelled before it started.", "ANALYSIS_CANCELLED", { jobId });
    }

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(python, [script], {
        cwd: this.settings.projectRoot,
        windowsHide: true,
        env: {
          ...process.env,
          AVE_ANALYSIS_CACHE_DIR: path.join(this.settings.dataDir, "analysis-cache"),
          AVE_ANALYSIS_CANCEL_PATH: cancellationPath
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputLimitExceeded = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void fs.rm(cancellationPath, { force: true }).catch(() => undefined).finally(() => {
          if (error) reject(error);
          else resolve(value);
        });
      };

      const onAbort = (): void => {
        void fs.writeFile(cancellationPath, "cancelled\n", "utf8")
          .catch(() => undefined)
          .finally(() => {
            finish(new PythonMediaAnalysisError(
              `Media analysis job ${jobId} was cancelled.`,
              "ANALYSIS_CANCELLED",
              { jobId, lastProgress: stderr }
            ));
            child.kill();
          });
      };

      timer = setTimeout(() => {
        finish(new PythonMediaAnalysisError(
          `Python media analysis job ${jobId} timed out after ${timeoutMs} ms. Last progress: ${stderr}`.trimEnd(),
          "ANALYSIS_TIMEOUT",
          { jobId, timeoutMs, lastProgress: stderr }
        ));
        child.kill();
      }, timeoutMs);
      timer.unref?.();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 16_000_000) {
          outputLimitExceeded = true;
          child.kill();
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
      child.on("error", (error) => finish(new PythonMediaAnalysisError(
        `Could not start Python media worker for job ${jobId}: ${error.message}`,
        "WORKER_START_FAILED",
        { jobId }
      )));
      child.on("close", (code) => {
        if (settled) return;
        if (signal?.aborted) {
          return finish(new PythonMediaAnalysisError(`Media analysis job ${jobId} was cancelled.`, "ANALYSIS_CANCELLED", { jobId }));
        }
        if (outputLimitExceeded) {
          return finish(new PythonMediaAnalysisError(
            `Python media worker exceeded the 16 MB response limit for job ${jobId}.`,
            "WORKER_OUTPUT_LIMIT",
            { jobId }
          ));
        }
        const line = stdout.trim().split(/\r?\n/).at(-1);
        if (!line) return finish(new PythonMediaAnalysisError(
          `Python media worker returned no response (exit ${code}). ${stderr}`.trimEnd(),
          "WORKER_NO_RESPONSE",
          { jobId, exitCode: code, lastProgress: stderr }
        ));
        let parsedResponse: unknown;
        try {
          parsedResponse = JSON.parse(line) as unknown;
        } catch {
          return finish(new PythonMediaAnalysisError(
            `Python media worker returned invalid JSON (exit ${code}). ${stderr}`.trimEnd(),
            "WORKER_INVALID_RESPONSE",
            { jobId, exitCode: code, lastProgress: stderr }
          ));
        }
        if (!parsedResponse || typeof parsedResponse !== "object" || Array.isArray(parsedResponse)) {
          return finish(new PythonMediaAnalysisError(
            `Python media worker returned a non-object response (exit ${code}). ${stderr}`.trimEnd(),
            "WORKER_INVALID_RESPONSE",
            { jobId, exitCode: code, lastProgress: stderr }
          ));
        }
        const response = parsedResponse as {
          id?: unknown;
          command?: unknown;
          ok?: boolean;
          result?: unknown;
          error?: { code?: unknown; message?: unknown; details?: unknown };
        };
        if (response.id !== jobId || response.command !== command) {
          return finish(new PythonMediaAnalysisError(
            `Python media worker response did not match job ${jobId} (${command}).`,
            "WORKER_RESPONSE_MISMATCH",
            { expectedId: jobId, actualId: response.id, expectedCommand: command, actualCommand: response.command }
          ));
        }
        if (!response.ok) {
          const error = response.error;
          const message = typeof error?.message === "string" ? error.message : "Media analysis failed.";
          const errorCode = typeof error?.code === "string" ? error.code : "ANALYSIS_FAILED";
          return finish(new PythonMediaAnalysisError(
            `${message} (job ${jobId})`,
            errorCode,
            error?.details
          ));
        }
        finish(undefined, response.result);
      });

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdin.end(JSON.stringify({ id: jobId, command, payload }) + "\n");
    });
  }
}
