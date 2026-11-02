import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppSettings } from "../config/settings.js";
import type { Logger } from "../utils/logger.js";
import type {
  BridgeErrorInfo,
  BridgeRequestEnvelope,
  BridgeResponseEnvelope,
  BridgeResponseStatus
} from "../types/bridge.types.js";
import {
  REQUEST_FILE_NAME,
  createResponse,
  isKnownBridgeCommand,
  parseRequest,
  responseFileName,
  serializeResponse
} from "../bridge/message-protocol.js";
import {
  ensureDir,
  isMissingFileError,
  moveFile,
  pathExists,
  readJsonFile,
  writeTextFileAtomic
} from "../utils/file-utils.js";

export interface MockResolveAdapterOptions {
  latencyMs?: number;
  pollIntervalMs?: number;
  version?: string;
  isStudio?: boolean;
  projectName?: string;
  timelineName?: string;
}

interface MockClip {
  name: string;
  uniqueId: string;
  mediaId: number;
  type: string;
  filePath: string;
  duration: string;
  frames: number;
  resolution: string;
  fps: number;
}

interface MockBin {
  name: string;
  path: string;
  clips: MockClip[];
}

interface MockTimeline {
  name: string;
  uniqueId: string;
}

interface MockProject {
  name: string;
  uniqueId: string;
}

interface MockState {
  projects: MockProject[];
  currentProject: MockProject | null;
  bins: MockBin[];
  timelines: MockTimeline[];
  saveCounter: number;
}

function createMockId(prefix: string, seed: string): string {
  return `${prefix}-mock-${seed.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
}

function createMockState(projectName: string, timelineName: string): MockState {
  const currentProject: MockProject = {
    name: projectName,
    uniqueId: createMockId("proj", projectName)
  };
  return {
    projects: [currentProject],
    currentProject,
    bins: [{ name: "Master Bin", path: "", clips: [] }],
    timelines: [{
      name: timelineName,
      uniqueId: createMockId("tl", timelineName)
    }],
    saveCounter: 0
  };
}

function findMockBin(state: MockState, binPath: string): MockBin | undefined {
  return state.bins.find((bin) => bin.path === binPath.replace(/^\/+|\/+$/g, ""));
}

function mockBinSummaries(state: MockState): Array<{
  name: string;
  path: string;
  clipCount: number;
  clips: MockClip[];
}> {
  return state.bins.map((bin) => ({
    name: bin.name,
    path: bin.path,
    clipCount: bin.clips.length,
    clips: bin.clips.map((clip) => ({ ...clip }))
  }));
}

function mockBaseResult(state: MockState, options: Required<MockResolveAdapterOptions>): {
  connected: boolean;
  resolveVersion: string;
  isStudio: boolean;
  projectName: string | null;
  scriptContext: string;
  errors: unknown[];
} {
  return {
    connected: state.currentProject !== null,
    resolveVersion: options.version,
    isStudio: options.isStudio,
    projectName: state.currentProject?.name ?? null,
    scriptContext: "mock-resolve-adapter",
    errors: []
  };
}

function mockProjectRecord(project: MockProject | null, state: MockState, options: Required<MockResolveAdapterOptions>): {
  name: string;
  uniqueId: string;
  timelineCount: number;
  currentPage: string;
} | null {
  if (project === null) {
    return null;
  }
  return {
    name: project.name,
    uniqueId: project.uniqueId,
    timelineCount: state.timelines.length,
    currentPage: "edit"
  };
}

function mockProjectList(state: MockState): string[] {
  return state.projects.map((project) => project.name);
}

class MockCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function handleMockCommand(
  command: string,
  payload: Record<string, unknown>,
  state: MockState,
  options: Required<MockResolveAdapterOptions>
): unknown {
  const payloadRecord = (payload ?? {}) as Record<string, unknown>;
  const base = () => mockBaseResult(state, options);

  switch (command) {
    case "diagnostics.ping":
      return {
        message: "pong",
        resolveConnected: state.currentProject !== null,
        isStudio: options.isStudio,
        version: options.version,
        projectName: state.currentProject?.name ?? null,
        timelineName: state.timelines[0]?.name ?? null,
        page: "edit",
        scriptContext: "mock-resolve-adapter"
      };

    case "diagnostics.snapshot":
      return {
        ...base(),
        version: { list: [], string: options.version, productName: "mock", isStudio: options.isStudio },
        currentPage: "edit",
        project: state.currentProject
          ? { name: state.currentProject.name, uniqueId: state.currentProject.uniqueId }
          : null,
        timeline: state.timelines[0]
          ? { name: state.timelines[0].name, uniqueId: state.timelines[0].uniqueId }
          : null,
        timelines: state.timelines.map((timeline, index) => ({
          index: index + 1,
          name: timeline.name,
          uniqueId: timeline.uniqueId
        })),
        mediaPool: {
          rootFolderName: "Master Bin",
          clipCount: state.bins.reduce((total, bin) => total + bin.clips.length, 0),
          clips: mockBinSummaries(state)
        },
        render: {
          formats: { mp4: "H.264/MPEG-4 AVC" },
          currentFormatAndCodec: { format: "mp4", codec: "h264" },
          presets: { "H.264": "H.264" }
        },
        mock: true
      };

    case "bridge.echo":
      return { echoed: payloadRecord, scriptContext: "mock-resolve-adapter" };

    case "bridge.health":
      return {
        mock: true,
        connected: state.currentProject !== null,
        requestsDir: "mock",
        responsesDir: "mock"
      };

    case "project.inspect": {
      if (state.currentProject === null) {
        throw new MockCommandError("PROJECT_UNAVAILABLE", "Mock: no project is open.");
      }
      return {
        ...base(),
        project: mockProjectRecord(state.currentProject, state, options),
        projectManager: {
          currentFolder: 1,
          projectCount: state.projects.length,
          projects: mockProjectList(state)
        },
        timelineCount: state.timelines.length
      };
    }

    case "media.inspect": {
      if (state.currentProject === null) {
        throw new MockCommandError("PROJECT_UNAVAILABLE", "Mock: no project is open.");
      }
      const includeClips = payloadRecord.includeClips !== false;
      const maxClips = typeof payloadRecord.maxClips === "number" ? payloadRecord.maxClips : 100;
      const bins = mockBinSummaries(state).map((bin) => ({
        ...bin,
        clips: includeClips ? bin.clips.slice(0, maxClips) : [],
        truncated: includeClips && bin.clips.length > maxClips
      }));
      return {
        ...base(),
        mediaPool: {
          rootFolderName: "Master Bin",
          folderCount: bins.length,
          clipCount: state.bins.reduce((total, bin) => total + bin.clips.length, 0),
          emittedClips: bins.reduce((total, bin) => total + bin.clips.length, 0),
          truncated: false,
          bins
        }
      };
    }

    case "timeline.inspect": {
      if (state.currentProject === null) {
        throw new MockCommandError("PROJECT_UNAVAILABLE", "Mock: no project is open.");
      }
      const requestedIndex = typeof payloadRecord.timelineIndex === "number" ? payloadRecord.timelineIndex : null;
      const timeline = requestedIndex
        ? state.timelines[requestedIndex - 1]
        : state.timelines[0];
      if (!timeline) {
        throw new MockCommandError(
          "TIMELINE_UNAVAILABLE",
          requestedIndex
            ? `Mock: no timeline exists at index ${requestedIndex}.`
            : "Mock: no current timeline is open."
        );
      }
      return {
        ...base(),
        timeline: {
          name: timeline.name,
          uniqueId: timeline.uniqueId,
          startFrame: 0,
          endFrame: 100,
          startTimecode: "01:00:00:00",
          videoTracks: 1,
          audioTracks: 1,
          subtitleTracks: 0,
          settings: {}
        },
        timelineName: timeline.name,
        tracks: {
          video: [{ index: 1, itemCount: 0, items: [], truncated: false }],
          audio: [{ index: 1, itemCount: 0, items: [], truncated: false }],
          subtitle: []
        },
        markers: [],
        emittedClips: 0,
        truncated: false,
        timelines: state.timelines.map((item, index) => ({
          index: index + 1,
          name: item.name,
          uniqueId: item.uniqueId
        }))
      };
    }

    case "render.inspect":
      return {
        ...base(),
        render: {
          currentFormatAndCodec: { format: "mp4", codec: "h264" },
          formats: { mp4: "H.264/MPEG-4 AVC" },
          presets: { "H.264 Master": "H.264 Master" },
          settings: {},
          codecs: { h264: "H.264" }
        }
      };

    case "project.create": {
      const name = typeof payloadRecord.name === "string" ? payloadRecord.name.trim() : "";
      if (!name || name.length > 120) {
        throw new MockCommandError("INVALID_PROJECT_NAME", "Mock: invalid project name.");
      }
      if (state.projects.some((project) => project.name === name)) {
        throw new MockCommandError("PROJECT_ALREADY_EXISTS", `Mock: project already exists: ${name}`);
      }
      const project: MockProject = { name, uniqueId: createMockId("proj", name) };
      state.projects.push(project);
      state.currentProject = project;
      return {
        ...base(),
        project: mockProjectRecord(project, state, options),
        projectName: project.name,
        projectManager: {
          currentFolder: 1,
          projects: mockProjectList(state)
        }
      };
    }

    case "project.open": {
      const name = typeof payloadRecord.name === "string" ? payloadRecord.name.trim() : "";
      const project = state.projects.find((item) => item.name === name);
      if (!project) {
        throw new MockCommandError("PROJECT_NOT_FOUND", `Mock: project not found: ${name}`);
      }
      state.currentProject = project;
      return {
        ...base(),
        project: mockProjectRecord(project, state, options),
        projectName: project.name,
        savedCurrent: payloadRecord.saveCurrent === true,
        projectManager: {
          currentFolder: 1,
          projects: mockProjectList(state)
        }
      };
    }

    case "project.save": {
      if (state.currentProject === null) {
        throw new MockCommandError("PROJECT_UNAVAILABLE", "Mock: no project is open.");
      }
      state.saveCounter += 1;
      return {
        ...base(),
        saved: true,
        project: mockProjectRecord(state.currentProject, state, options)
      };
    }

    case "media.createBin": {
      if (state.currentProject === null) {
        throw new MockCommandError("PROJECT_UNAVAILABLE", "Mock: no project is open.");
      }
      const name = typeof payloadRecord.name === "string" ? payloadRecord.name.trim() : "";
      const parentPath = typeof payloadRecord.parentPath === "string" ? payloadRecord.parentPath : "";
      if (!name || name.length > 120) {
        throw new MockCommandError("INVALID_BIN_NAME", "Mock: invalid bin name.");
      }
      if (findMockBin(state, name) && parentPath === "") {
        throw new MockCommandError("BIN_ALREADY_EXISTS", `Mock: bin already exists: ${name}`);
      }
      const binPath = parentPath ? `${parentPath}/${name}` : name;
      if (findMockBin(state, binPath)) {
        throw new MockCommandError("BIN_ALREADY_EXISTS", `Mock: bin already exists: ${binPath}`);
      }
      state.bins.push({ name, path: binPath, clips: [] });
      return {
        ...base(),
        bin: { name, uniqueId: createMockId("bin", binPath), path: binPath },
        binPath
      };
    }

    case "media.import": {
      if (state.currentProject === null) {
        throw new MockCommandError("PROJECT_UNAVAILABLE", "Mock: no project is open.");
      }
      const filePaths = Array.isArray(payloadRecord.filePaths)
        ? payloadRecord.filePaths.filter((item): item is string => typeof item === "string")
        : [];
      if (filePaths.length === 0) {
        throw new MockCommandError("INVALID_MEDIA_PATHS", "Mock: at least one media file path is required.");
      }
      const binPath = typeof payloadRecord.binPath === "string" && payloadRecord.binPath !== ""
        ? payloadRecord.binPath
        : "";
      const targetBin = findMockBin(state, binPath);
      if (binPath !== "" && !targetBin) {
        throw new MockCommandError("BIN_NOT_FOUND", `Mock: media pool bin not found: ${binPath}`);
      }
      const clips: MockClip[] = filePaths.map((filePath, index) => ({
        name: (filePath.split(/[\\/]/).pop() ?? `clip-${index + 1}`),
        uniqueId: createMockId("clip", `${filePath}-${index}`),
        mediaId: 1000 + index,
        type: "Video",
        filePath,
        duration: "00:00:10:00",
        frames: 300,
        resolution: "1920x1080",
        fps: 30
      }));
      const destination = binPath !== "" ? targetBin : findMockBin(state, "") ?? state.bins[0];
      if (!destination) {
        throw new MockCommandError("MEDIA_POOL_UNAVAILABLE", "Mock: no root bin is available.");
      }
      destination.clips.push(...clips);
      return {
        ...base(),
        imported: {
          count: clips.length,
          clips,
          binPath: binPath || null,
          currentFolderRestored: binPath !== ""
        }
      };
    }

    default:
      throw new MockCommandError("UNSUPPORTED_COMMAND", `Mock: command is not implemented: ${command}`);
  }
}

export class MockResolveAdapter {
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private readonly options: Required<MockResolveAdapterOptions>;
  private readonly requestPath: string;
  private readonly state: MockState;

  constructor(
    private readonly settings: AppSettings,
    private readonly logger: Logger,
    options: MockResolveAdapterOptions = {}
  ) {
    this.options = {
      latencyMs: options.latencyMs ?? 0,
      pollIntervalMs: options.pollIntervalMs ?? 100,
      version: options.version ?? "21.1.0.17-mock",
      isStudio: options.isStudio ?? false,
      projectName: options.projectName ?? "Mock Project",
      timelineName: options.timelineName ?? "Mock Timeline"
    };
    this.requestPath = path.join(settings.requestsDir, REQUEST_FILE_NAME);
    this.state = createMockState(this.options.projectName, this.options.timelineName);
  }

  async start(): Promise<void> {
    await this.ensureLayout();
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.processOnce();
    }, this.options.pollIntervalMs);
    this.logger.info("Mock Resolve adapter started", {
      requestsDir: this.settings.requestsDir,
      pollIntervalMs: this.options.pollIntervalMs
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("Mock Resolve adapter stopped");
  }

  async processOnce(): Promise<BridgeResponseEnvelope | null> {
    if (this.processing) {
      return null;
    }
    this.processing = true;
    try {
      if (!(await pathExists(this.requestPath))) {
        return null;
      }
      let request: BridgeRequestEnvelope;
      try {
        request = parseRequest(await readJsonFile(this.requestPath));
      } catch (error) {
        this.logger.warn("Mock adapter ignored an invalid request", {
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      }

      if (this.options.latencyMs > 0) {
        await sleep(this.options.latencyMs);
      }

      const startedAt = new Date();
      const response = this.buildResponse(request, startedAt);
      await writeTextFileAtomic(
        path.join(this.settings.responsesDir, responseFileName(request.id)),
        serializeResponse(response)
      );
      await this.archiveRequest(request);
      this.logger.info("Mock adapter responded", {
        requestId: request.id,
        command: request.command,
        status: response.status
      });
      return response;
    } finally {
      this.processing = false;
    }
  }

  private buildResponse(
    request: BridgeRequestEnvelope,
    startedAt: Date
  ): BridgeResponseEnvelope {
    const baseMeta = {
      resolveVersion: this.options.version,
      isStudio: this.options.isStudio,
      projectName: this.state.currentProject?.name ?? this.options.projectName,
      timelineName: this.state.timelines[0]?.name ?? this.options.timelineName,
      scriptContext: "mock-resolve-adapter"
    };

    if (!isKnownBridgeCommand(request.command)) {
      return createResponse({
        request,
        status: "unsupported",
        error: {
          code: "UNSUPPORTED_COMMAND",
          message: `Command "${request.command}" is not implemented in the mock adapter.`
        },
        startedAt,
        source: "mock",
        meta: baseMeta
      });
    }

    let status: BridgeResponseStatus;
    let result: unknown;
    let error: BridgeErrorInfo | undefined;

    try {
      result = handleMockCommand(request.command, request.payload ?? {}, this.state, this.options);
      status = "success";
    } catch (thrown) {
      if (thrown instanceof MockCommandError) {
        status = "error";
        error = { code: thrown.code, message: thrown.message };
      } else {
        status = "error";
        error = { code: "UNREACHABLE", message: "Unhandled mock command failure." };
      }
      result = undefined;
    }

    return createResponse({
      request,
      status,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      startedAt,
      source: "mock",
      meta: baseMeta
    });
  }

  private async archiveRequest(request: BridgeRequestEnvelope): Promise<void> {
    const destination = path.join(this.settings.archiveDir, `${request.id}.request.json`);
    try {
      await moveFile(this.requestPath, destination);
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.logger.warn("Mock adapter could not archive request", {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async ensureLayout(): Promise<void> {
    await Promise.all([
      ensureDir(this.settings.requestsDir),
      ensureDir(this.settings.responsesDir),
      ensureDir(this.settings.archiveDir),
      ensureDir(this.settings.logsDir)
    ]);
  }
}
