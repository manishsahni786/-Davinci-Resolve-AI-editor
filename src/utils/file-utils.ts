import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

export async function readTextFile(target: string): Promise<string> {
  return readFile(target, "utf8");
}

export async function readJsonFile<T = unknown>(target: string): Promise<T> {
  const content = await readFile(target, "utf8");
  return JSON.parse(content) as T;
}

export async function writeTextFileAtomic(target: string, content: string): Promise<void> {
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(target, { force: true });
    await rename(temporary, target);
  }
}

export async function writeJsonFileAtomic(target: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function moveFile(source: string, destination: string): Promise<void> {
  await ensureDir(path.dirname(destination));
  try {
    await rename(source, destination);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    await rm(destination, { force: true });
    await rename(source, destination);
  }
}

export async function removeFile(target: string): Promise<void> {
  await rm(target, { force: true });
}

export async function listFiles(directory: string, extension?: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => (extension ? name.endsWith(extension) : true))
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ["EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
