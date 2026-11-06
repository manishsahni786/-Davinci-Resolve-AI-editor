import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ANALYSIS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredAnalysis {
  createdAt: string;
  command: string;
  payload: Record<string, unknown>;
  result: unknown;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function analysisTtlMs(): number {
  const parsed = Number(process.env.AVE_ANALYSIS_TTL_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_ANALYSIS_TTL_MS;
}

export class AnalysisResultCache {
  constructor(private readonly dataDir: string) {}

  cachePath(command: string, payload: Record<string, unknown>): string {
    const hash = createHash("sha256")
      .update(`${command}\n${canonicalJson(payload)}`)
      .digest("hex");
    return path.join(this.dataDir, "analysis-cache", "results", `${command}-${hash}.json`);
  }

  async load(command: string, payload: Record<string, unknown>, nowMs = Date.now()): Promise<unknown | null> {
    try {
      const raw = await fs.readFile(this.cachePath(command, payload), "utf8");
      const stored = JSON.parse(raw) as StoredAnalysis;
      if (stored.command !== command) return null;
      if (canonicalJson(stored.payload) !== canonicalJson(payload)) return null;
      const createdAt = Date.parse(stored.createdAt);
      if (!Number.isFinite(createdAt)) return null;
      const ttl = analysisTtlMs();
      if (!Number.isFinite(ttl) || ttl <= 0) return null;
      if (nowMs - createdAt > ttl || nowMs - createdAt < -60000) return null;
      return stored.result;
    } catch {
      return null;
    }
  }

  async save(command: string, payload: Record<string, unknown>, result: unknown, nowMs = Date.now()): Promise<void> {
    try {
      const stored: StoredAnalysis = { createdAt: new Date(nowMs).toISOString(), command, payload, result };
      const filePath = this.cachePath(command, payload);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    } catch {
      // A cache write failure must never fail or delay a completed analysis.
    }
  }
}
