import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppSettings } from "../../src/config/settings.js";

export async function createTestSettings(overrides: Partial<AppSettings> = {}): Promise<AppSettings> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ave-test-"));
  const dataDir = path.join(root, "data");
  return {
    projectRoot: root,
    dataDir,
    requestsDir: path.join(dataDir, "requests"),
    responsesDir: path.join(dataDir, "responses"),
    archiveDir: path.join(dataDir, "requests", "archive"),
    logsDir: path.join(root, "logs"),
    fusionPrefsPath: path.join(root, "Fusion.prefs"),
    commandTimeoutMs: 500,
    pollIntervalMs: 10,
    autoTrigger: false,
    autoTriggerIntervalMs: 100,
    autoTriggerScriptPath: path.join(root, "invoke-bridge.ps1"),
    logLevel: "debug",
    ...overrides
  };
}
