export type BridgeResponseStatus = "success" | "error" | "unsupported";

export interface BridgeRequestEnvelope {
  protocolVersion: "1.0";
  id: string;
  command: string;
  createdAt: string;
  timeoutMs?: number;
  source: "node";
  payload: Record<string, unknown>;
}

export interface BridgeErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

export interface BridgeResponseEnvelope {
  protocolVersion: "1.0";
  id: string;
  command: string;
  ok: boolean;
  status: BridgeResponseStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  source: "resolve" | "mock";
  result?: unknown;
  error?: BridgeErrorInfo;
  meta?: {
    resolveVersion?: string;
    isStudio?: boolean;
    projectName?: string;
    timelineName?: string;
    scriptContext?: string;
  };
}

export interface BridgeHealth {
  initialized: boolean;
  requestsDir: string;
  responsesDir: string;
  archiveDir: string;
  pendingRequest: {
    id: string;
    command: string;
    createdAt: string;
    path: string;
  } | null;
  unresolvedResponseCount: number;
  resolveProcessRunning: boolean;
  externalScriptingPortListening: boolean;
  autoTriggerEnabled: boolean;
  autoTriggerScriptPath: string | null;
  manualTriggerRequired: boolean;
  fusionPrefsPath: string | null;
  fusionPrefsPresent: boolean;
  fusionBridgeStage: string | null;
  fusionLastError: string | null;
  fusionLastErrorAt: string | null;
}
