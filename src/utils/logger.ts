import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const REDACTED_KEYS = /token|secret|password|authorization|api[_-]?key/i;

export interface LoggerOptions {
  logDir: string;
  level?: LogLevel;
  console?: boolean;
  bindings?: Record<string, unknown>;
}

export type LogFields = Record<string, unknown>;

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return error;
}

function redact(value: unknown, key?: string): unknown {
  if (key && REDACTED_KEYS.test(key)) {
    return "[REDACTED]";
  }
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redact(childValue, childKey);
    }
    return output;
  }
  return value;
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class Logger {
  readonly logDir: string;
  readonly level: LogLevel;
  readonly consoleEnabled: boolean;
  readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions) {
    this.logDir = options.logDir;
    this.level = options.level ?? "info";
    this.consoleEnabled = options.console ?? true;
    this.bindings = options.bindings ?? {};
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger({
      logDir: this.logDir,
      level: this.level,
      console: this.consoleEnabled,
      bindings: { ...this.bindings, ...bindings }
    });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const record = {
      timestamp,
      level,
      message,
      ...(redact(this.bindings) as Record<string, unknown>),
      ...(redact(fields) as Record<string, unknown>)
    };

    try {
      mkdirSync(this.logDir, { recursive: true });
      const file = path.join(this.logDir, `ai-video-editor-${timestamp.slice(0, 10)}.log`);
      appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Logging must never take down the process.
    }

    if (this.consoleEnabled) {
      const suffix = Object.keys(fields).length > 0
        ? ` ${formatConsoleValue(redact(fields))}`
        : "";
      const stream = level === "error" || level === "warn" ? console.error : console.log;
      stream(`[${timestamp}] ${level.toUpperCase()} ${message}${suffix}`);
    }
  }
}
