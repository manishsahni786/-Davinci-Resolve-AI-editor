import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../utils/errors.js";
import { parsePositiveInteger } from "../utils/validation.js";
import type { LogLevel } from "../utils/logger.js";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

export interface AppSettings {
  projectRoot: string;
  resolveInstallDir?: string;
  dataDir: string;
  requestsDir: string;
  responsesDir: string;
  archiveDir: string;
  logsDir: string;
  fusionPrefsPath: string;
  commandTimeoutMs: number;
  pollIntervalMs: number;
  autoTrigger: boolean;
  autoTriggerIntervalMs: number;
  autoTriggerScriptPath: string;
  logLevel: LogLevel;
}

interface SettingsFile {
  resolveInstallDir?: string;
  dataDir?: string;
  logsDir?: string;
  fusionPrefsPath?: string;
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  autoTrigger?: boolean;
  autoTriggerIntervalMs?: number;
  autoTriggerScriptPath?: string;
  logLevel?: LogLevel;
}

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  const content = readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readSettingsFile(file: string): SettingsFile {
  if (!existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SettingsFile;
  } catch (error) {
    throw new ValidationError(`Unable to parse ${file}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase() as LogLevel;
  if (!VALID_LOG_LEVELS.includes(normalized)) {
    throw new ValidationError(`Invalid log level "${value}". Use debug, info, warn or error.`);
  }
  return normalized;
}

function resolveConfiguredPath(value: string | undefined, base: string): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new ValidationError(`Invalid boolean value "${value}". Use true or false.`);
}

export function loadSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  loadDotEnv(path.join(PROJECT_ROOT, ".env"));
  const fileSettings = readSettingsFile(path.join(PROJECT_ROOT, "config", "settings.json"));

  const dataDir = overrides.dataDir
    ?? resolveConfiguredPath(process.env.AVE_DATA_DIR, PROJECT_ROOT)
    ?? resolveConfiguredPath(fileSettings.dataDir, PROJECT_ROOT)
    ?? path.join(PROJECT_ROOT, "data");

  const logsDir = overrides.logsDir
    ?? resolveConfiguredPath(process.env.AVE_LOG_DIR, PROJECT_ROOT)
    ?? resolveConfiguredPath(fileSettings.logsDir, PROJECT_ROOT)
    ?? path.join(PROJECT_ROOT, "logs");

  const resolveInstallDir = overrides.resolveInstallDir
    ?? resolveConfiguredPath(process.env.AVE_RESOLVE_INSTALL_DIR, PROJECT_ROOT)
    ?? resolveConfiguredPath(fileSettings.resolveInstallDir, PROJECT_ROOT);

  const appData = process.env.APPDATA
    ?? path.join(homedir(), "AppData", "Roaming");
  const fusionPrefsPath = overrides.fusionPrefsPath
    ?? resolveConfiguredPath(process.env.AVE_FUSION_PREFS_PATH, PROJECT_ROOT)
    ?? resolveConfiguredPath(fileSettings.fusionPrefsPath, PROJECT_ROOT)
    ?? path.join(
      appData,
      "Blackmagic Design",
      "DaVinci Resolve",
      "Support",
      "Fusion",
      "Profiles",
      "Default",
      "Fusion.prefs"
    );

  const commandTimeoutMs = overrides.commandTimeoutMs
    ?? parsePositiveInteger(
      process.env.AVE_COMMAND_TIMEOUT_MS,
      fileSettings.commandTimeoutMs ?? 120_000
    );

  const pollIntervalMs = overrides.pollIntervalMs
    ?? parsePositiveInteger(
      process.env.AVE_POLL_INTERVAL_MS,
      fileSettings.pollIntervalMs ?? 500
    );

  const autoTrigger = overrides.autoTrigger
    ?? parseBoolean(
      process.env.AVE_AUTO_TRIGGER,
      fileSettings.autoTrigger ?? false
    );

  const autoTriggerIntervalMs = overrides.autoTriggerIntervalMs
    ?? parsePositiveInteger(
      process.env.AVE_AUTO_TRIGGER_INTERVAL_MS,
      fileSettings.autoTriggerIntervalMs ?? 1_500
    );

  const autoTriggerScriptPath = overrides.autoTriggerScriptPath
    ?? resolveConfiguredPath(process.env.AVE_AUTO_TRIGGER_SCRIPT, PROJECT_ROOT)
    ?? resolveConfiguredPath(fileSettings.autoTriggerScriptPath, PROJECT_ROOT)
    ?? path.join(PROJECT_ROOT, "resolve-scripts", "invoke-bridge.ps1");

  const logLevel = overrides.logLevel
    ?? parseLogLevel(process.env.AVE_LOG_LEVEL, fileSettings.logLevel ?? "info");

  return {
    projectRoot: PROJECT_ROOT,
    ...(resolveInstallDir ? { resolveInstallDir } : {}),
    dataDir,
    requestsDir: path.join(dataDir, "requests"),
    responsesDir: path.join(dataDir, "responses"),
    archiveDir: path.join(dataDir, "requests", "archive"),
    logsDir,
    fusionPrefsPath,
    commandTimeoutMs,
    pollIntervalMs,
    autoTrigger,
    autoTriggerIntervalMs,
    autoTriggerScriptPath,
    logLevel
  };
}
