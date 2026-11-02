export type CapabilityStatus =
  | "verified"
  | "supported-untested"
  | "restricted-free"
  | "unsupported"
  | "requires-manual-interaction";

export interface Capability {
  id: string;
  name: string;
  status: CapabilityStatus;
  implemented: boolean;
  milestone: string;
  evidence: string;
  notes?: string;
}

export interface ResolveProcessInfo {
  running: boolean;
  pid?: number;
  executablePath?: string;
  fileVersion?: string;
  productVersion?: string;
}

export interface ResolveInstallInfo {
  installDir: string;
  executablePath: string;
  resolveExePresent: boolean;
  fusionscriptPath: string;
  fusionscriptPresent: boolean;
  fuscriptPath: string;
  fuscriptPresent: boolean;
  resolvePythonPath: string;
  resolvePythonPresent: boolean;
  source: "settings" | "process" | "start-menu" | "common-path";
}

export interface ScriptDirectories {
  userFusionScripts: string;
  userUtilityScripts: string;
  allUsersFusionScripts: string;
  allUsersUtilityScripts: string;
  userUtilityExists: boolean;
  allUsersUtilityExists: boolean;
}

export interface EnvironmentSnapshot {
  generatedAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  cwd: string;
  projectRoot: string;
  resolveProcess: ResolveProcessInfo;
  resolveInstall: ResolveInstallInfo | null;
  scriptDirectories: ScriptDirectories;
  externalScriptingPort: {
    port: number;
    listening: boolean;
    note: string;
  };
  bridge: {
    dataDir: string;
    requestsDir: string;
    responsesDir: string;
    logsDir: string;
  };
  externalScripting: {
    apiPath: string;
    apiPathPresent: boolean;
    libPath: string;
    libPathPresent: boolean;
  };
  python: {
    executable: string;
    note: string;
  };
  ffmpeg: {
    onPath: boolean;
    note: string;
  };
}
