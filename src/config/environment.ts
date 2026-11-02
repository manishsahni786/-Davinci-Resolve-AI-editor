import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type {
  EnvironmentSnapshot,
  ResolveInstallInfo,
  ResolveProcessInfo,
  ScriptDirectories
} from "../types/resolve.types.js";
import type { AppSettings } from "./settings.js";

const execFileAsync = promisify(execFile);
const RESOLVE_PORT = 1144;

async function runPowerShell(script: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 15_000 }
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getResolveProcessInfo(): Promise<ResolveProcessInfo> {
  const output = await runPowerShell(
    "$p = Get-Process -Name Resolve -ErrorAction SilentlyContinue | Select-Object -First 1; "
      + "if ($p) { Write-Output $p.Id; Write-Output $p.Path }"
  );
  if (output === "") {
    return { running: false };
  }
  const [pidLine, ...pathLines] = output.split(/\r?\n/);
  const pid = Number(pidLine);
  const executablePath = pathLines.join("\n").trim();
  if (!Number.isInteger(pid)) {
    return { running: false };
  }
  const info: ResolveProcessInfo = {
    running: true,
    pid
  };
  if (executablePath !== "") {
    info.executablePath = executablePath;
    const versions = await getFileVersions(executablePath);
    if (versions.fileVersion) {
      info.fileVersion = versions.fileVersion;
    }
    if (versions.productVersion) {
      info.productVersion = versions.productVersion;
    }
  }
  return info;
}

async function getFileVersions(executablePath: string): Promise<{
  fileVersion?: string;
  productVersion?: string;
}> {
  const escaped = executablePath.replace(/'/g, "''");
  const output = await runPowerShell(
    `$v = (Get-Item -LiteralPath '${escaped}').VersionInfo; `
      + "Write-Output $v.FileVersion; Write-Output $v.ProductVersion"
  );
  if (output === "") {
    return {};
  }
  const [fileVersion, productVersion] = output.split(/\r?\n/).map((line) => line.trim());
  return {
    ...(fileVersion ? { fileVersion } : {}),
    ...(productVersion ? { productVersion } : {})
  };
}

function asInstallDir(candidate: string | undefined): string | null {
  if (!candidate) {
    return null;
  }
  const resolved = path.resolve(candidate);
  if (path.basename(resolved).toLowerCase() === "resolve.exe") {
    return path.dirname(resolved);
  }
  return resolved;
}

async function getStartMenuInstallDir(): Promise<string | null> {
  const shortcut = path.join(
    process.env.ProgramData ?? "C:\\ProgramData",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Blackmagic Design",
    "DaVinci Resolve",
    "DaVinci Resolve.lnk"
  );
  if (!existsSync(shortcut)) {
    return null;
  }
  const escaped = shortcut.replace(/'/g, "''");
  const output = await runPowerShell(
    "$sh = New-Object -ComObject WScript.Shell; "
      + `$l = $sh.CreateShortcut('${escaped}'); `
      + "if ($l.TargetPath) { Write-Output $l.TargetPath }"
  );
  if (output === "") {
    return null;
  }
  return path.dirname(output.trim());
}

export async function detectResolveInstall(settings: AppSettings): Promise<ResolveInstallInfo | null> {
  const candidates: Array<{ dir: string; source: ResolveInstallInfo["source"] }> = [];

  const configured = asInstallDir(settings.resolveInstallDir);
  if (configured) {
    candidates.push({ dir: configured, source: "settings" });
  }

  const processInfo = await getResolveProcessInfo();
  if (processInfo.executablePath) {
    candidates.push({ dir: path.dirname(processInfo.executablePath), source: "process" });
  }

  const startMenuDir = await getStartMenuInstallDir();
  if (startMenuDir) {
    candidates.push({ dir: startMenuDir, source: "start-menu" });
  }

  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  for (const dir of [
    path.join(programFiles, "Blackmagic Design", "DaVinci Resolve"),
    path.join(programFilesX86, "Blackmagic Design", "DaVinci Resolve")
  ]) {
    candidates.push({ dir, source: "common-path" });
  }

  for (const candidate of candidates) {
    const executablePath = path.join(candidate.dir, "Resolve.exe");
    if (!existsSync(executablePath)) {
      continue;
    }
    const fusionscriptPath = path.join(candidate.dir, "fusionscript.dll");
    const fuscriptPath = path.join(candidate.dir, "fuscript.exe");
    const resolvePythonPath = path.join(candidate.dir, "ResolvePython", "ResolvePython.exe");
    return {
      installDir: candidate.dir,
      executablePath,
      resolveExePresent: true,
      fusionscriptPath,
      fusionscriptPresent: existsSync(fusionscriptPath),
      fuscriptPath,
      fuscriptPresent: existsSync(fuscriptPath),
      resolvePythonPath,
      resolvePythonPresent: existsSync(resolvePythonPath),
      source: candidate.source
    };
  }

  return null;
}

export function getScriptDirectories(): ScriptDirectories {
  const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Roaming");
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  const userFusionScripts = path.join(
    appData,
    "Blackmagic Design",
    "DaVinci Resolve",
    "Support",
    "Fusion",
    "Scripts"
  );
  const allUsersFusionScripts = path.join(
    programData,
    "Blackmagic Design",
    "DaVinci Resolve",
    "Fusion",
    "Scripts"
  );
  const userUtilityScripts = path.join(userFusionScripts, "Utility");
  const allUsersUtilityScripts = path.join(allUsersFusionScripts, "Utility");
  return {
    userFusionScripts,
    userUtilityScripts,
    allUsersFusionScripts,
    allUsersUtilityScripts,
    userUtilityExists: existsSync(userUtilityScripts),
    allUsersUtilityExists: existsSync(allUsersUtilityScripts)
  };
}

export async function probeTcpPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 750
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function whereExecutable(name: string): Promise<{ found: boolean; path: string }> {
  try {
    const { stdout } = await execFileAsync("where.exe", [name], {
      windowsHide: true,
      timeout: 5_000
    });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
    return { found: first !== "", path: first };
  } catch {
    return { found: false, path: "" };
  }
}

export async function getEnvironmentSnapshot(settings: AppSettings): Promise<EnvironmentSnapshot> {
  const [resolveProcess, resolveInstall, python, ffmpeg, listening] = await Promise.all([
    getResolveProcessInfo(),
    detectResolveInstall(settings),
    whereExecutable("python.exe"),
    whereExecutable("ffmpeg.exe"),
    probeTcpPort(RESOLVE_PORT)
  ]);

  const scriptingApiPath = path.join(
    process.env.ProgramData ?? "C:\\ProgramData",
    "Blackmagic Design",
    "DaVinci Resolve",
    "Support",
    "Developer",
    "Scripting"
  );
  const libPath = resolveInstall?.fusionscriptPath ?? "";

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    cwd: process.cwd(),
    projectRoot: settings.projectRoot,
    resolveProcess,
    resolveInstall,
    scriptDirectories: getScriptDirectories(),
    externalScriptingPort: {
      port: RESOLVE_PORT,
      listening,
      note: listening
        ? "A listener is present. External scripting may be enabled."
        : "Port 1144 is closed. On DaVinci Resolve Free, external scripting is restricted; the file bridge requires a manual Lua trigger."
    },
    bridge: {
      dataDir: settings.dataDir,
      requestsDir: settings.requestsDir,
      responsesDir: settings.responsesDir,
      logsDir: settings.logsDir
    },
    externalScripting: {
      apiPath: scriptingApiPath,
      apiPathPresent: existsSync(scriptingApiPath),
      libPath,
      libPathPresent: libPath !== "" && existsSync(libPath)
    },
    python: {
      executable: python.found ? python.path : "not found on PATH",
      note: python.found
        ? "Python is available for independent media-analysis workers."
        : "Python was not found on PATH. The media-analysis worker will not start."
    },
    ffmpeg: {
      onPath: ffmpeg.found,
      note: ffmpeg.found
        ? "ffmpeg is available on PATH."
        : "ffmpeg/ffprobe are not on PATH. Media analysis will need an imageio-ffmpeg or bundled FFmpeg dependency."
    }
  };
}
