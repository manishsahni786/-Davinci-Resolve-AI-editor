export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "CONFIG_ERROR"
  | "BRIDGE_BUSY"
  | "BRIDGE_TIMEOUT"
  | "BRIDGE_PROTOCOL_ERROR"
  | "BRIDGE_IO_ERROR"
  | "RESOLVE_UNAVAILABLE"
  | "UNSUPPORTED_FEATURE"
  | "INTERNAL_ERROR";

export interface AppErrorOptions {
  code: AppErrorCode;
  message: string;
  details?: unknown;
  cause?: unknown;
  retryable?: boolean;
  manualActionRequired?: boolean;
  exitCode?: number;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly manualActionRequired: boolean;
  readonly exitCode: number;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.manualActionRequired = options.manualActionRequired ?? false;
    this.exitCode = options.exitCode ?? 1;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      manualActionRequired: this.manualActionRequired
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: "VALIDATION_ERROR", message, details, exitCode: 1 });
  }
}

export class BridgeBusyError extends AppError {
  constructor(message: string, details?: unknown) {
    super({
      code: "BRIDGE_BUSY",
      message,
      details,
      retryable: true,
      manualActionRequired: true,
      exitCode: 3
    });
  }
}

export class BridgeTimeoutError extends AppError {
  constructor(message: string, details?: unknown) {
    super({
      code: "BRIDGE_TIMEOUT",
      message,
      details,
      retryable: true,
      manualActionRequired: true,
      exitCode: 2
    });
  }
}

export class BridgeProtocolError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: "BRIDGE_PROTOCOL_ERROR", message, details, exitCode: 1 });
  }
}

export class ResolveUnavailableError extends AppError {
  constructor(message: string, details?: unknown) {
    super({
      code: "RESOLVE_UNAVAILABLE",
      message,
      details,
      retryable: true,
      manualActionRequired: true,
      exitCode: 2
    });
  }
}

export class UnsupportedFeatureError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: "UNSUPPORTED_FEATURE", message, details });
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof Error) {
    return new AppError({
      code: "INTERNAL_ERROR",
      message: error.message,
      cause: error
    });
  }
  return new AppError({
    code: "INTERNAL_ERROR",
    message: String(error)
  });
}
