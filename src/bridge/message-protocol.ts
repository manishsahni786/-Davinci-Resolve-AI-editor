import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  BridgeErrorInfo,
  BridgeRequestEnvelope,
  BridgeResponseEnvelope,
  BridgeResponseStatus
} from "../types/bridge.types.js";
import { BridgeProtocolError } from "../utils/errors.js";

export const PROTOCOL_VERSION = "1.0" as const;
export const REQUEST_FILE_NAME = "next.request.json";
export const LUA_REQUEST_FILE_NAME = "next.request.lua";

export const MILESTONE_1_COMMANDS = [
  "diagnostics.ping",
  "diagnostics.snapshot",
  "bridge.echo",
  "bridge.health"
] as const;

export const INSPECTION_COMMANDS = [
  "project.inspect",
  "media.inspect",
  "timeline.inspect",
  "render.inspect"
] as const;

export const BRIDGE_COMMANDS = [
  ...MILESTONE_1_COMMANDS,
  ...INSPECTION_COMMANDS
] as const;

export type Milestone1Command = (typeof MILESTONE_1_COMMANDS)[number];
export type InspectionCommand = (typeof INSPECTION_COMMANDS)[number];
export type BridgeCommand = (typeof BRIDGE_COMMANDS)[number];

const requestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const isoDateSchema = z.string().min(1);

export const BridgeRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: requestIdSchema,
  command: z.string().min(1).max(128),
  createdAt: isoDateSchema,
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  source: z.literal("node"),
  payload: z.record(z.unknown()).default({})
});

export const BridgeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
});

export const BridgeResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: requestIdSchema,
  command: z.string().min(1),
  ok: z.boolean(),
  status: z.enum(["success", "error", "unsupported"]),
  startedAt: isoDateSchema,
  completedAt: isoDateSchema,
  durationMs: z.number().nonnegative(),
  source: z.enum(["resolve", "mock"]),
  result: z.unknown().optional(),
  error: BridgeErrorSchema.optional(),
  meta: z.object({
    resolveVersion: z.string().optional(),
    isStudio: z.boolean().optional(),
    projectName: z.string().optional(),
    timelineName: z.string().optional(),
    scriptContext: z.string().optional()
  }).optional()
});

export interface CreateRequestOptions {
  timeoutMs?: number;
  payload?: Record<string, unknown>;
  id?: string;
  now?: Date;
}

export function createRequest(
  command: string,
  options: CreateRequestOptions = {}
): BridgeRequestEnvelope {
  const createdAt = (options.now ?? new Date()).toISOString();
  const request: BridgeRequestEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: options.id ?? randomUUID(),
    command,
    createdAt,
    source: "node",
    payload: options.payload ?? {}
  };
  if (options.timeoutMs !== undefined) {
    request.timeoutMs = options.timeoutMs;
  }
  return BridgeRequestSchema.parse(request);
}

export function parseRequest(value: unknown): BridgeRequestEnvelope {
  const result = BridgeRequestSchema.safeParse(value);
  if (!result.success) {
    throw new BridgeProtocolError("Invalid bridge request envelope.", {
      issues: result.error.issues
    });
  }
  return result.data as BridgeRequestEnvelope;
}

export function parseResponse(value: unknown): BridgeResponseEnvelope {
  const result = BridgeResponseSchema.safeParse(value);
  if (!result.success) {
    throw new BridgeProtocolError("Invalid bridge response envelope.", {
      issues: result.error.issues
    });
  }
  return result.data as BridgeResponseEnvelope;
}

export function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new BridgeProtocolError(`Invalid JSON in ${context}.`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function serializeRequest(request: BridgeRequestEnvelope): string {
  return `${JSON.stringify(request, null, 2)}\n`;
}

export function serializeLuaRequest(request: BridgeRequestEnvelope): string {
  const json = JSON.stringify(request);
  let equals = 1;
  while (json.includes(`]${"=".repeat(equals)}]`)) {
    equals += 1;
  }
  const open = `[${"=".repeat(equals)}[`;
  const close = `]${"=".repeat(equals)}]`;
  return `return ${open}${json}${close}\n`;
}

export function serializeResponse(response: BridgeResponseEnvelope): string {
  return `${JSON.stringify(response, null, 2)}\n`;
}

export function createResponse(options: {
  request: BridgeRequestEnvelope;
  status: BridgeResponseStatus;
  result?: unknown;
  error?: BridgeErrorInfo;
  startedAt: Date;
  completedAt?: Date;
  source?: "resolve" | "mock";
  meta?: BridgeResponseEnvelope["meta"];
}): BridgeResponseEnvelope {
  const completedAt = options.completedAt ?? new Date();
  const response: BridgeResponseEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: options.request.id,
    command: options.request.command,
    ok: options.status === "success",
    status: options.status,
    startedAt: options.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - options.startedAt.getTime()),
    source: options.source ?? "resolve"
  };
  if (options.result !== undefined) {
    response.result = options.result;
  }
  if (options.error !== undefined) {
    response.error = options.error;
  }
  if (options.meta !== undefined) {
    response.meta = options.meta;
  }
  return BridgeResponseSchema.parse(response) as BridgeResponseEnvelope;
}

export function isKnownMilestone1Command(command: string): command is Milestone1Command {
  return (MILESTONE_1_COMMANDS as readonly string[]).includes(command);
}

export function isKnownBridgeCommand(command: string): command is BridgeCommand {
  return (BRIDGE_COMMANDS as readonly string[]).includes(command);
}

export const COMMAND_PAYLOAD_SCHEMAS = {
  "project.inspect": z.object({
    includeProjects: z.boolean().optional()
  }).strict(),
  "media.inspect": z.object({
    includeClips: z.boolean().optional(),
    maxClips: z.number().int().min(1).max(500).optional()
  }).strict(),
  "timeline.inspect": z.object({
    timelineIndex: z.number().int().min(1).max(1000).optional(),
    includeClips: z.boolean().optional(),
    maxClips: z.number().int().min(1).max(500).optional()
  }).strict(),
  "render.inspect": z.object({
    includeJobs: z.boolean().optional(),
    includeCodecs: z.boolean().optional()
  }).strict()
} as const;

export function validateCommandPayload(
  command: BridgeCommand,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const schema = (COMMAND_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[command];
  if (!schema) {
    return payload;
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new BridgeProtocolError(`Invalid payload for ${command}.`, {
      issues: result.error.issues
    });
  }
  return result.data as Record<string, unknown>;
}

export function responseFileName(requestId: string): string {
  return `${requestId}.response.json`;
}
