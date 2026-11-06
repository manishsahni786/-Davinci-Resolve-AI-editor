import { describe, expect, it } from "vitest";
import {
  extractMediaClips,
  runReelWorkflow,
  selectReelClips,
  type ReelBridge,
  type ReelWorkflowResult
} from "../src/resolve/editing-workflow.js";
import type { BridgeResponseEnvelope } from "../src/types/bridge.types.js";

function ok(command: string, result: unknown, id = `${command}-id`): BridgeResponseEnvelope {
  const now = new Date().toISOString();
  return {
    protocolVersion: "1.0",
    id,
    command,
    ok: true,
    status: "success",
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    source: "resolve",
    result
  };
}

function failure(command: string, code: string, message: string): BridgeResponseEnvelope {
  const now = new Date().toISOString();
  return {
    protocolVersion: "1.0",
    id: `${command}-failed`,
    command,
    ok: false,
    status: "error",
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    source: "resolve",
    result: { failure: { code, message } },
    error: { code, message }
  };
}

class FakeReelBridge implements ReelBridge {
  calls: string[] = [];

  async inspectProject(): Promise<BridgeResponseEnvelope> {
    this.calls.push("inspectProject");
    return ok("project.inspect", {
      project: { name: "Current Project" },
      projectManager: { projects: ["Current Project"] }
    });
  }

  async openProject(payload: Record<string, unknown>): Promise<BridgeResponseEnvelope> {
    this.calls.push("openProject");
    return ok("project.open", { projectName: payload.name });
  }

  async createProject(payload: Record<string, unknown>): Promise<BridgeResponseEnvelope> {
    this.calls.push("createProject");
    return ok("project.create", { projectName: payload.name });
  }

  async createBin(payload: Record<string, unknown>): Promise<BridgeResponseEnvelope> {
    this.calls.push("createBin");
    if (payload.name === "Existing Bin") {
      return failure("media.createBin", "BIN_ALREADY_EXISTS", "Bin exists");
    }
    return ok("media.createBin", { binPath: payload.name });
  }

  async importMedia(): Promise<BridgeResponseEnvelope> {
    this.calls.push("importMedia");
    return ok("media.import", { imported: 2 });
  }

  async inspectMedia(): Promise<BridgeResponseEnvelope> {
    this.calls.push("inspectMedia");
    return ok("media.inspect", {
      projectName: "New Reel",
      mediaPool: {
        bins: [
          {
            clips: [
              { uniqueId: "clip-frost", name: "Frost Fight.mp4", filePath: "D:/media/Frost Fight.mp4" },
              { uniqueId: "clip-grenade", name: "Grenade Kill.mp4", filePath: "D:/media/Grenade Kill.mp4" }
            ]
          }
        ]
      }
    });
  }

  async createTimeline(payload: Record<string, unknown>): Promise<BridgeResponseEnvelope> {
    this.calls.push("createTimeline");
    return ok("timeline.create", { timelineName: payload.name });
  }

  async appendClips(): Promise<BridgeResponseEnvelope> {
    this.calls.push("appendClips");
    return ok("timeline.appendClips", { appended: { count: 1 } });
  }

  async saveProject(): Promise<BridgeResponseEnvelope> {
    this.calls.push("saveProject");
    return ok("project.save", { saved: true });
  }
}

describe("editing workflow helpers", () => {
  it("extracts clips from media-pool folders", () => {
    const clips = extractMediaClips(ok("media.inspect", {
      mediaPool: {
        bins: [
          { clips: [{ uniqueId: "a", name: "A.mp4" }] },
          { clips: [{ uniqueId: "b", name: "B.mp4" }] }
        ]
      }
    }));
    expect(clips.map((clip) => clip.uniqueId)).toEqual(["a", "b"]);
  });

  it("selects clips by topic and falls back with a warning", () => {
    const clips = [
      { uniqueId: "frost", name: "Frost Fight.mp4" },
      { uniqueId: "grenade", name: "Grenade Kill.mp4" }
    ];
    const matched = selectReelClips(clips, { topic: "frost" });
    expect(matched.clips.map((clip) => clip.uniqueId)).toEqual(["frost"]);

    const fallback = selectReelClips(clips, { topic: "volcano" });
    expect(fallback.clips).toHaveLength(2);
    expect(fallback.warning).toContain("No clips matched");
  });

  it("limits the number of clips", () => {
    const clips = [
      { uniqueId: "a", name: "A.mp4" },
      { uniqueId: "b", name: "B.mp4" }
    ];
    const selected = selectReelClips(clips, { maxClips: 1 });
    expect(selected.clips).toHaveLength(1);
    expect(selected.warning).toContain("Limited the timeline");
  });
});

describe("runReelWorkflow", () => {
  it("creates a project, imports media, selects topic clips and saves", async () => {
    const bridge = new FakeReelBridge();
    const result: ReelWorkflowResult = await runReelWorkflow(bridge, {
      projectName: "New Reel",
      mediaPaths: ["D:/media"],
      binName: "Existing Bin",
      topic: "frost",
      timelineName: "Frost Reel",
      platform: "instagram"
    }, 1_000);

    expect(result.ok).toBe(true);
    expect(result.projectName).toBe("New Reel");
    expect(result.timelineName).toBe("Frost Reel");
    expect(result.selectedClips.map((clip) => clip.uniqueId)).toEqual(["clip-frost"]);
    expect(result.warnings.some((warning) => warning.includes("Milestone 6"))).toBe(true);
    expect(bridge.calls).toContain("createProject");
    expect(bridge.calls).toContain("importMedia");
    expect(bridge.calls).toContain("createTimeline");
    expect(bridge.calls).toContain("saveProject");
    expect(result.steps.every((step) => step.ok)).toBe(true);
  });

  it("fails cleanly when the media pool is empty", async () => {
    const bridge = new FakeReelBridge();
    bridge.inspectMedia = async () => ok("media.inspect", { mediaPool: { folders: [] } });

    const result = await runReelWorkflow(bridge, {
      timelineName: "Empty Reel",
      save: false
    }, 1_000);

    expect(result.ok).toBe(false);
    expect(result.steps.some((step) => step.error?.code === "NO_MEDIA")).toBe(true);
  });
});
