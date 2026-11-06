import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AnalysisResultCache,
  canonicalJson,
  DEFAULT_ANALYSIS_TTL_MS
} from "../src/analysis/analysis-result-cache.js";
import { PythonMediaAnalysis } from "../src/analysis/python-media-analysis.js";
import { createTestSettings } from "./helpers/test-settings.js";

const PAYLOAD: Record<string, unknown> = {
  path: "C:/Media/demo.mp4",
  pass1MaxFrames: 6,
  pass2FramesPerEvent: 4
};

describe("analysis result cache", () => {
  it("round-trips a saved analysis result", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);
    const result = { eventCount: 2, events: [{ start_time: 10.5 }] };

    expect(await cache.load("analyze_events", PAYLOAD)).toBeNull();
    await cache.save("analyze_events", PAYLOAD, result);
    expect(await cache.load("analyze_events", PAYLOAD)).toEqual(result);
  });

  it("keys identical payloads with different key order to the same file", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);

    expect(cache.cachePath("probe_media", { a: 1, b: "x" })).toBe(
      cache.cachePath("probe_media", { b: "x", a: 1 })
    );
    expect(canonicalJson({ a: 1, b: [1, { c: 2, d: null }] })).toBe(
      canonicalJson({ b: [1, { d: null, c: 2 }], a: 1 })
    );
  });

  it("does not return results for a different payload or command", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);
    await cache.save("analyze_events", PAYLOAD, { eventCount: 1 });

    expect(
      await cache.load("analyze_events", { ...PAYLOAD, maxEvents: 3 })
    ).toBeNull();
    expect(await cache.load("probe_media", PAYLOAD)).toBeNull();
  });

  it("expires results after the configured TTL", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);
    const nowMs = Date.now();

    await cache.save("analyze_events", PAYLOAD, { eventCount: 1 }, nowMs);
    expect(await cache.load("analyze_events", PAYLOAD, nowMs + DEFAULT_ANALYSIS_TTL_MS - 1000))
      .toEqual({ eventCount: 1 });
    expect(await cache.load("analyze_events", PAYLOAD, nowMs + DEFAULT_ANALYSIS_TTL_MS + 60000))
      .toBeNull();

    process.env.AVE_ANALYSIS_TTL_MS = "5000";
    expect(await cache.load("analyze_events", PAYLOAD, nowMs + 6000)).toBeNull();
    expect(await cache.load("analyze_events", PAYLOAD, nowMs + 4000)).toEqual({ eventCount: 1 });
  });

  it("treats a corrupted cache file as a miss", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);
    await cache.save("analyze_events", PAYLOAD, { eventCount: 1 });
    await fs.writeFile(cache.cachePath("analyze_events", PAYLOAD), "{not-json", "utf8");

    expect(await cache.load("analyze_events", PAYLOAD)).toBeNull();
  });
});

describe("PythonMediaAnalysis result cache wiring", () => {
  const originalPythonPath = process.env.AVE_PYTHON_PATH;
  const originalTtl = process.env.AVE_ANALYSIS_TTL_MS;

  afterEach(() => {
    if (originalPythonPath === undefined) delete process.env.AVE_PYTHON_PATH;
    else process.env.AVE_PYTHON_PATH = originalPythonPath;
    if (originalTtl === undefined) delete process.env.AVE_ANALYSIS_TTL_MS;
    else process.env.AVE_ANALYSIS_TTL_MS = originalTtl;
  });

  it("returns a cached analysis result without starting the Python worker", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);
    const result = { eventCount: 1, passes: { batchSize: 1 } };
    await cache.save("analyze_events", PAYLOAD, result);

    process.env.AVE_PYTHON_PATH = "Z:\\definitely-not-real-python.exe";
    const analysis = new PythonMediaAnalysis(settings, cache);
    expect(await analysis.run("analyze_events", PAYLOAD)).toEqual(result);
  });

  it("runs the worker when no cached result exists", async () => {
    const settings = await createTestSettings();
    const analysis = new PythonMediaAnalysis(settings);

    process.env.AVE_PYTHON_PATH = "Z:\\definitely-not-real-python.exe";
    await expect(analysis.run("analyze_events", PAYLOAD)).rejects.toThrow(/Could not start Python media worker/);
  });

  it("does not serve a cached result from another payload", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);
    await cache.save("analyze_events", PAYLOAD, { eventCount: 1 });

    process.env.AVE_PYTHON_PATH = "Z:\\definitely-not-real-python.exe";
    const analysis = new PythonMediaAnalysis(settings, cache);
    await expect(analysis.run("analyze_events", { ...PAYLOAD, maxEvents: 5 })).rejects.toThrow(
      /Could not start Python media worker/
    );
  });

  it("leaves analysis results on disk under data/analysis-cache/results", async () => {
    const settings = await createTestSettings();
    const cache = new AnalysisResultCache(settings.dataDir);
    await cache.save("probe_media", { path: "x.mp4" }, { durationSeconds: 12 });

    const resultsDir = path.join(settings.dataDir, "analysis-cache", "results");
    const files = await fs.readdir(resultsDir);
    expect(files.some((name) => name.startsWith("probe_media-") && name.endsWith(".json"))).toBe(true);
  });
});
