import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PythonMediaAnalysis, PythonMediaAnalysisError } from "../src/analysis/python-media-analysis.js";
import { createTestSettings } from "./helpers/test-settings.js";

class FakeStream extends EventEmitter {
  setEncoding(_encoding: string): this { return this; }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  requestLine = "";
  killed = false;
  readonly stdin = {
    end: (chunk: string): void => { this.requestLine = chunk.trim(); }
  };

  kill(): boolean {
    this.killed = true;
    this.emit("close", null);
    return true;
  }

  respond(result: unknown, override: Record<string, unknown> = {}): void {
    const request = JSON.parse(this.requestLine) as { id: string; command: string };
    this.respondRaw(JSON.stringify({
      id: request.id,
      command: request.command,
      ok: true,
      result,
      ...override
    }));
  }

  respondRaw(line: string): void {
    this.stdout.emit("data", `${line}\n`);
    this.emit("close", 0);
  }
}

const roots: string[] = [];
const envNames = ["AVE_PYTHON_PATH", "AVE_ANALYSIS_TIMEOUT_MS", "AVE_MEDIA_ANALYSIS_TIMEOUT_MS"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

async function testSettings() {
  const settings = await createTestSettings();
  roots.push(settings.projectRoot);
  return settings;
}

afterEach(async () => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("PythonMediaAnalysis worker lifecycle", () => {
  it("assigns a unique job id and verifies the matching worker response", async () => {
    const settings = await testSettings();
    const child = new FakeChild();
    let workerEnv: NodeJS.ProcessEnv | undefined;
    const spawnProcess = vi.fn((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      workerEnv = options.env;
      setImmediate(() => child.respond({ jobId: JSON.parse(child.requestLine).payload.jobId }));
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const analysis = new PythonMediaAnalysis(settings, null, spawnProcess);

    const result = await analysis.run("analyze_events", { path: "C:/Media/demo.mp4" }) as { jobId: string };

    expect(result.jobId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.parse(child.requestLine).id).toBe(result.jobId);
    expect(workerEnv?.AVE_ANALYSIS_CANCEL_PATH).toContain(`${result.jobId}.cancel`);
    await expect(fs.stat(workerEnv!.AVE_ANALYSIS_CANCEL_PATH!)).rejects.toThrow();
  });

  it("rejects overlapping vision jobs to keep Ollama requests sequential", async () => {
    const settings = await testSettings();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>) as unknown as typeof spawn;
    const analysis = new PythonMediaAnalysis(settings, null, spawnProcess);
    const first = analysis.run("analyze_events", { path: "first.mp4" });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));

    await expect(analysis.run("analyze_events", { path: "second.mp4" }))
      .rejects.toMatchObject({ code: "VISION_BUSY" });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    child.respond({ eventCount: 0 });
    await expect(first).resolves.toEqual({ eventCount: 0 });
  });

  it("kills the worker and removes the cancellation marker when the client aborts", async () => {
    const settings = await testSettings();
    const child = new FakeChild();
    let workerEnv: NodeJS.ProcessEnv | undefined;
    const spawnProcess = vi.fn((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      workerEnv = options.env;
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const analysis = new PythonMediaAnalysis(settings, null, spawnProcess);
    const controller = new AbortController();
    const running = analysis.run("analyze_events", { path: "C:/Media/long.mp4" }, { signal: controller.signal });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "ANALYSIS_CANCELLED" });
    expect(child.killed).toBe(true);
    await expect(fs.stat(workerEnv!.AVE_ANALYSIS_CANCEL_PATH!)).rejects.toThrow();
  });

  it("enforces the overall event-analysis timeout and kills the worker", async () => {
    process.env.AVE_ANALYSIS_TIMEOUT_MS = "25";
    const settings = await testSettings();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>) as unknown as typeof spawn;
    const analysis = new PythonMediaAnalysis(settings, null, spawnProcess);

    await expect(analysis.run("analyze_events", { path: "C:/Media/long.mp4" }))
      .rejects.toMatchObject({ code: "ANALYSIS_TIMEOUT" });
    expect(child.killed).toBe(true);
  });

  it("returns worker analysis errors with their structured code and details", async () => {
    const settings = await testSettings();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => {
      setImmediate(() => child.respond(null, {
        ok: false,
        error: { code: "VISION_GPU_OFFLOAD_LIMIT", message: "CPU offload too high", details: { cpuPercent: 32 } }
      }));
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const analysis = new PythonMediaAnalysis(settings, null, spawnProcess);

    await expect(analysis.run("analyze_events", { path: "C:/Media/demo.mp4" }))
      .rejects.toMatchObject({
        name: "PythonMediaAnalysisError",
        code: "VISION_GPU_OFFLOAD_LIMIT",
        details: { cpuPercent: 32 }
      } satisfies Partial<PythonMediaAnalysisError>);
  });

  it("rejects valid JSON that is not a worker response object", async () => {
    const settings = await testSettings();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => {
      setImmediate(() => child.respondRaw("null"));
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const analysis = new PythonMediaAnalysis(settings, null, spawnProcess);

    await expect(analysis.run("analyze_media", { path: "C:/Media/demo.mp4" }))
      .rejects.toMatchObject({
        name: "PythonMediaAnalysisError",
        code: "WORKER_INVALID_RESPONSE"
      } satisfies Partial<PythonMediaAnalysisError>);
  });
});
