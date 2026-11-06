import type { BridgeResponseEnvelope } from "../types/bridge.types.js";

export interface ReelWorkflowInput {
  projectName?: string;
  mediaPaths?: string[];
  binName?: string;
  clipIds?: string[];
  timelineName?: string;
  topic?: string;
  platform?: "instagram" | "youtube";
  maxClips?: number;
  save?: boolean;
}

export interface ReelWorkflowStep {
  step: string;
  ok: boolean;
  command?: string;
  requestId?: string;
  error?: { code?: string; message?: string };
  detail?: unknown;
}

export interface MediaClipSummary {
  uniqueId: string;
  name: string;
  filePath?: string;
}

export interface ReelWorkflowResult {
  ok: boolean;
  steps: ReelWorkflowStep[];
  projectName: string | null;
  timelineName: string | null;
  selectedClips: MediaClipSummary[];
  warnings: string[];
  platform: string | null;
}

export interface ReelBridge {
  inspectProject(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  openProject(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  createProject(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  createBin(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  importMedia(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  inspectMedia(payload?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  createTimeline(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  appendClips(payload: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponseEnvelope>;
  saveProject(timeoutMs?: number): Promise<BridgeResponseEnvelope>;
}

function firstFailure(response: BridgeResponseEnvelope): { code?: string; message?: string } | null {
  if (response.ok) {
    return null;
  }
  const result = response.result as
    | { failure?: { code?: string; message?: string } }
    | undefined;
  const error = response.error ?? result?.failure;
  return {
    ...(error?.code !== undefined ? { code: error.code } : {}),
    message: error?.message ?? "Resolve reported an unspecified failure."
  };
}

export function extractMediaClips(response: BridgeResponseEnvelope): MediaClipSummary[] {
  const result = response.result as
    | {
        mediaPool?: {
          bins?: Array<{ clips?: Array<Record<string, unknown>> }>;
          folders?: Array<{ clips?: Array<Record<string, unknown>> }>;
        };
      }
    | undefined;
  const bins = result?.mediaPool?.bins ?? result?.mediaPool?.folders ?? [];
  const clips: MediaClipSummary[] = [];
  for (const folder of bins) {
    for (const clip of folder.clips ?? []) {
      const uniqueId = typeof clip.uniqueId === "string" ? clip.uniqueId : null;
      if (!uniqueId) {
        continue;
      }
      const name = typeof clip.name === "string" ? clip.name : uniqueId;
      const filePath = typeof clip.filePath === "string" ? clip.filePath : undefined;
      clips.push({
        uniqueId,
        name,
        ...(filePath !== undefined ? { filePath } : {})
      });
    }
  }
  return clips;
}

function tokenizeTopic(topic: string | undefined): string[] {
  if (!topic) {
    return [];
  }
  return topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

export function selectReelClips(
  clips: MediaClipSummary[],
  input: ReelWorkflowInput
): { clips: MediaClipSummary[]; warning?: string } {
  const maxClips = input.maxClips ?? 20;
  let selected = clips;
  let warning: string | undefined;

  if (input.clipIds && input.clipIds.length > 0) {
    const byId = new Map(clips.map((clip) => [clip.uniqueId, clip]));
    const requested = input.clipIds
      .map((id) => byId.get(id))
      .filter((clip): clip is MediaClipSummary => clip !== undefined);
    if (requested.length === 0) {
      warning = "None of the requested clipIds were found; using all media-pool clips instead.";
      selected = clips;
    } else {
      selected = requested;
    }
  } else {
    const tokens = tokenizeTopic(input.topic);
    if (tokens.length > 0) {
      const matched = clips.filter((clip) => {
        const haystack = `${clip.name} ${clip.filePath ?? ""}`.toLowerCase();
        return tokens.some((token) => haystack.includes(token));
      });
      if (matched.length > 0) {
        selected = matched;
      } else {
        warning = `No clips matched topic "${input.topic}"; using all media-pool clips instead.`;
      }
    }
  }

  if (selected.length > maxClips) {
    const limitNote = `Limited the timeline to ${maxClips} clips (${selected.length} available).`;
    warning = warning ? `${warning} ${limitNote}` : limitNote;
    selected = selected.slice(0, maxClips);
  }

  return { clips: selected, ...(warning !== undefined ? { warning } : {}) };
}

export async function runReelWorkflow(
  bridge: ReelBridge,
  input: ReelWorkflowInput,
  timeoutMs: number
): Promise<ReelWorkflowResult> {
  const steps: ReelWorkflowStep[] = [];
  const warnings: string[] = [];
  const platform = input.platform ?? null;
  let projectName: string | null = input.projectName ?? null;
  let timelineName: string | null = input.timelineName ?? null;
  let selectedClips: MediaClipSummary[] = [];

  const finish = (ok: boolean): ReelWorkflowResult => ({
    ok,
    steps,
    projectName,
    timelineName,
    selectedClips,
    warnings,
    platform
  });

  const addStep = (step: string, response: BridgeResponseEnvelope, command: string): boolean => {
    const failure = firstFailure(response);
    steps.push({
      step,
      ok: failure === null,
      command,
      requestId: response.id,
      ...(failure ? { error: failure } : {})
    });
    return failure === null;
  };

  if (input.projectName) {
    const inspect = await bridge.inspectProject({ includeProjects: true }, timeoutMs);
    if (!addStep("inspect-project", inspect, "project.inspect")) {
      return finish(false);
    }
    const inspectResult = inspect.result as
      | { project?: { name?: string }; projectManager?: { projects?: string[] } }
      | undefined;
    const currentName = inspectResult?.project?.name;
    const projects = inspectResult?.projectManager?.projects ?? [];

    if (currentName !== input.projectName) {
      const exists = projects.includes(input.projectName);
      let response = exists
        ? await bridge.openProject({ name: input.projectName, saveCurrent: true }, timeoutMs)
        : await bridge.createProject({ name: input.projectName }, timeoutMs);
      let command = exists ? "project.open" : "project.create";

      if (!response.ok && firstFailure(response)?.code === "PROJECT_ALREADY_EXISTS") {
        response = await bridge.openProject({ name: input.projectName, saveCurrent: true }, timeoutMs);
        command = "project.open";
      } else if (!response.ok && firstFailure(response)?.code === "PROJECT_NOT_FOUND") {
        response = await bridge.createProject({ name: input.projectName }, timeoutMs);
        command = "project.create";
      }

      if (!addStep(exists ? "open-project" : "create-project", response, command)) {
        return finish(false);
      }
    } else {
      steps.push({ step: "project", ok: true, detail: { reused: input.projectName } });
    }
    projectName = input.projectName;
  }

  if (input.mediaPaths && input.mediaPaths.length > 0) {
    const binName = input.binName ?? "Reel Footage";
    const binResponse = await bridge.createBin({ name: binName }, timeoutMs);
    const binFailure = firstFailure(binResponse);
    if (binFailure && binFailure.code !== "BIN_ALREADY_EXISTS") {
      addStep("create-bin", binResponse, "media.createBin");
      return finish(false);
    }
    steps.push({
      step: "create-bin",
      ok: true,
      command: "media.createBin",
      requestId: binResponse.id,
      detail: binFailure ? { reused: binName } : { created: binName }
    });

    const importResponse = await bridge.importMedia(
      { filePaths: input.mediaPaths, binPath: binName },
      timeoutMs
    );
    if (!addStep("import-media", importResponse, "media.import")) {
      return finish(false);
    }
  }

  const mediaResponse = await bridge.inspectMedia({ includeClips: true, maxClips: 500 }, timeoutMs);
  if (!addStep("inspect-media", mediaResponse, "media.inspect")) {
    return finish(false);
  }
  const mediaResult = mediaResponse.result as { projectName?: string } | undefined;
  projectName = projectName ?? mediaResult?.projectName ?? null;

  const allClips = extractMediaClips(mediaResponse);
  if (allClips.length === 0) {
    steps.push({
      step: "select-clips",
      ok: false,
      error: { code: "NO_MEDIA", message: "The media pool has no clips." }
    });
    warnings.push("Import media first or pass mediaPaths when creating the reel.");
    return finish(false);
  }

  const selection = selectReelClips(allClips, input);
  selectedClips = selection.clips;
  if (selection.warning) {
    warnings.push(selection.warning);
  }
  steps.push({ step: "select-clips", ok: true, detail: { count: selectedClips.length } });
  if (selectedClips.length === 0) {
    return finish(false);
  }

  const timelineLabel = input.timelineName
    ?? (input.topic ? `${input.topic} Reel` : `Reel ${new Date().toISOString().slice(0, 10)}`);
  const mediaIds = selectedClips.map((clip) => clip.uniqueId);

  let timelineResponse = await bridge.createTimeline({ name: timelineLabel, mediaIds }, timeoutMs);
  if (!timelineResponse.ok) {
    warnings.push(
      "Creating the timeline from clips failed; an empty timeline was created and clips were appended instead."
    );
    timelineResponse = await bridge.createTimeline({ name: timelineLabel }, timeoutMs);
    if (!addStep("create-timeline", timelineResponse, "timeline.create")) {
      return finish(false);
    }
    const appendResponse = await bridge.appendClips({ mediaIds }, timeoutMs);
    if (!addStep("append-clips", appendResponse, "timeline.appendClips")) {
      return finish(false);
    }
  } else {
    addStep("create-timeline", timelineResponse, "timeline.create");
  }
  timelineName = timelineLabel;

  if (input.save !== false) {
    const saveResponse = await bridge.saveProject(timeoutMs);
    if (!addStep("save-project", saveResponse, "project.save")) {
      return finish(false);
    }
  }

  if (platform === "instagram") {
    warnings.push(
      "Instagram Reel target: 1080x1920 (9:16). Rendering/export is Milestone 6 and is not implemented yet."
    );
  } else if (platform === "youtube") {
    warnings.push(
      "YouTube target: 1920x1080 (16:9). Rendering/export is Milestone 6 and is not implemented yet."
    );
  }

  return finish(true);
}
