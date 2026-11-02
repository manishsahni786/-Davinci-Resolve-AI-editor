import { stat } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function assertRequestId(value: string): string {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new ValidationError("Invalid request id. Use 1-128 characters from A-Z, a-z, 0-9, dot, underscore or dash.", {
      value
    });
  }
  return value;
}

export async function assertExistingFile(target: string): Promise<string> {
  const resolved = path.resolve(target);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new ValidationError(`File does not exist: ${resolved}`, { path: resolved });
  }
  if (!info.isFile()) {
    throw new ValidationError(`Path is not a file: ${resolved}`, { path: resolved });
  }
  return resolved;
}

export async function assertExistingDirectory(target: string): Promise<string> {
  const resolved = path.resolve(target);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new ValidationError(`Directory does not exist: ${resolved}`, { path: resolved });
  }
  if (!info.isDirectory()) {
    throw new ValidationError(`Path is not a directory: ${resolved}`, { path: resolved });
  }
  return resolved;
}

export function isSubPath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`Expected a positive integer, received "${value}"`, { value });
  }
  return parsed;
}
