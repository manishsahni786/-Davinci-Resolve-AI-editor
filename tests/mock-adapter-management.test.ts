import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeManager } from "../src/bridge/bridge-manager.js";
import { FileBridge } from "../src/bridge/file-bridge.js";
import { FusionPrefsChannel } from "../src/bridge/fusion-prefs.js";
import type { AppSettings } from "../src/config/settings.js";
import { createRequest } from "../src/bridge/message-protocol.js";
import { MockResolveAdapter } from "../src/resolve/mock-resolve-adapter.js";
import { Logger } from "../src/utils/logger.js";
import { createTestSettings } from "./helpers/test-settings.js";

describe("Mock Resolve management commands", () => {
  let settings: AppSettings;
  let logger: Logger;
  let bridge: FileBridge;
  let manager: BridgeManager;
  let adapter: MockResolveAdapter | null = null;

  beforeEach(async () => {
    settings = await createTestSettings();
    logger = new Logger({ logDir: settings.logsDir, level: "error", console: false });
    const prefsChannel = new FusionPrefsChannel(settings.fusionPrefsPath, logger, 10);
    bridge = new FileBridge(settings, logger, prefsChannel);
    await bridge.initialize();
    manager = new BridgeManager(bridge, logger);
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
  });

  async function startAdapter(): Promise<void> {
    adapter = new MockResolveAdapter(settings, logger, { pollIntervalMs: 5 });
    await adapter.start();
  }

  it("responds to diagnostics.ping", async () => {
    await startAdapter();
    const { response } = await manager.execute("diagnostics.ping", {}, { timeoutMs: 2000 });
    expect(response.ok).toBe(true);
    expect(response.status).toBe("success");
    expect((response.result as Record<string, unknown>).resolveConnected).toBe(true);
  });

  it("creates, opens and saves projects", async () => {
    await startAdapter();
    const created = await manager.execute("project.create", { name: "Test Reel" }, { timeoutMs: 2000 });
    expect(created.response.ok).toBe(true);
    expect((created.response.result as Record<string, unknown>).projectName).toBe("Test Reel");

    const opened = await manager.execute("project.open", { name: "Mock Project" }, { timeoutMs: 2000 });
    expect(opened.response.ok).toBe(true);
    expect((opened.response.result as Record<string, unknown>).projectName).toBe("Mock Project");

    const saved = await manager.execute("project.save", {}, { timeoutMs: 2000 });
    expect(saved.response.ok).toBe(true);
    expect((saved.response.result as Record<string, unknown>).saved).toBe(true);
  });

  it("refuses duplicate project creation and unknown projects", async () => {
    await startAdapter();
    await manager.execute("project.create", { name: "Duplicate" }, { timeoutMs: 2000 });
    const duplicate = await manager.execute("project.create", { name: "Duplicate" }, { timeoutMs: 2000 });
    expect(duplicate.response.ok).toBe(false);
    expect(duplicate.response.error?.code).toBe("PROJECT_ALREADY_EXISTS");

    const missing = await manager.execute("project.open", { name: "Does Not Exist" }, { timeoutMs: 2000 });
    expect(missing.response.ok).toBe(false);
    expect(missing.response.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("creates bins and imports media into them", async () => {
    await startAdapter();
    const bin = await manager.execute("media.createBin", { name: "Footage" }, { timeoutMs: 2000 });
    expect(bin.response.ok).toBe(true);
    expect((bin.response.result as Record<string, unknown>).binPath).toBe("Footage");

    await manager.execute("media.createBin", { name: "Angle A", parentPath: "Footage" }, { timeoutMs: 2000 });

    const duplicate = await manager.execute("media.createBin", { name: "Footage" }, { timeoutMs: 2000 });
    expect(duplicate.response.ok).toBe(false);
    expect(duplicate.response.error?.code).toBe("BIN_ALREADY_EXISTS");

    const importResult = await manager.execute(
      "media.import",
      { filePaths: ["C:/Media/a.mp4", "C:/Media/b.mp4"], binPath: "Footage/Angle A" },
      { timeoutMs: 2000 }
    );
    expect(importResult.response.ok).toBe(true);
    const imported = (importResult.response.result as Record<string, unknown>).imported as Record<string, unknown>;
    expect(imported.count).toBe(2);
    expect(imported.binPath).toBe("Footage/Angle A");

    const invalidTarget = await manager.execute(
      "media.import",
      { filePaths: ["C:/Media/a.mp4"], binPath: "Missing Bin" },
      { timeoutMs: 2000 }
    );
    expect(invalidTarget.response.ok).toBe(false);
    expect(invalidTarget.response.error?.code).toBe("BIN_NOT_FOUND");
  });

  it("inspects media pool after imports", async () => {
    await startAdapter();
    await manager.execute("media.import", { filePaths: ["C:/Media/clip1.mp4"] }, { timeoutMs: 2000 });
    const inspected = await manager.execute("media.inspect", {}, { timeoutMs: 2000 });
    expect(inspected.response.ok).toBe(true);
    const pool = (inspected.response.result as Record<string, unknown>).mediaPool as Record<string, unknown>;
    expect(pool.clipCount).toBe(1);
    expect(pool.rootFolderName).toBe("Master Bin");
  });

  it("inspects the project, timeline and render settings", async () => {
    await startAdapter();
    for (const command of ["project.inspect", "timeline.inspect", "render.inspect"] as const) {
      const { response } = await manager.execute(command, {}, { timeoutMs: 2000 });
      expect(response.ok).toBe(true);
      expect(response.command).toBe(command);
    }
  });

  it("rejects malformed payloads before queueing", async () => {
    await startAdapter();
    await expect(
      manager.execute("project.create", { name: "bad/name" }, { timeoutMs: 2000 })
    ).rejects.toThrow();
    await expect(
      manager.execute("media.import", { filePaths: [] }, { timeoutMs: 2000 })
    ).rejects.toThrow();
  });

  it("creates timelines, appends clips, sets properties and deletes items", async () => {
    await startAdapter();

    const importResult = await manager.execute(
      "media.import",
      { filePaths: ["C:/Media/a.mp4", "C:/Media/b.mp4"] },
      { timeoutMs: 2000 }
    );
    expect(importResult.response.ok).toBe(true);
    const imported = (importResult.response.result as Record<string, unknown>).imported as {
      clips: Array<{ uniqueId: string }>;
    };
    const mediaIds = imported.clips.map((clip) => clip.uniqueId);

    const created = await manager.execute(
      "timeline.create",
      { name: "Milestone 5 Reel", mediaIds: [mediaIds[0]] },
      { timeoutMs: 2000 }
    );
    expect(created.response.ok).toBe(true);
    expect((created.response.result as Record<string, unknown>).timelineName).toBe("Milestone 5 Reel");

    const appended = await manager.execute(
      "timeline.appendClips",
      { mediaIds: [mediaIds[1]] },
      { timeoutMs: 2000 }
    );
    expect(appended.response.ok).toBe(true);
    expect(((appended.response.result as Record<string, unknown>).appended as { count: number }).count).toBe(1);

    const setProperty = await manager.execute(
      "timeline.setItemProperty",
      {
        target: { trackType: "video", trackIndex: 1, itemIndex: 1 },
        properties: { Color: "Blue" }
      },
      { timeoutMs: 2000 }
    );
    expect(setProperty.response.ok).toBe(true);
    expect(((setProperty.response.result as Record<string, unknown>).applied as Array<{ key: string }>)).toEqual([
      { key: "Color", applied: true }
    ]);

    const deleted = await manager.execute(
      "timeline.deleteClips",
      { targets: [{ trackType: "video", trackIndex: 1, itemIndices: [2] }] },
      { timeoutMs: 2000 }
    );
    expect(deleted.response.ok).toBe(true);
    expect(((deleted.response.result as Record<string, unknown>).deleted as { count: number }).count).toBe(1);

    const missing = await manager.execute(
      "timeline.deleteClips",
      { targets: [{ trackType: "video", trackIndex: 1, itemIndices: [9] }] },
      { timeoutMs: 2000 }
    );
    expect(missing.response.ok).toBe(false);
    expect(missing.response.error?.code).toBe("TIMELINE_ITEM_NOT_FOUND");
  });

  it("rejects unknown media ids when creating or appending timeline clips", async () => {
    await startAdapter();
    const created = await manager.execute(
      "timeline.create",
      { name: "Missing Clip Timeline", mediaIds: ["missing-clip"] },
      { timeoutMs: 2000 }
    );
    expect(created.response.ok).toBe(false);
    expect(created.response.error?.code).toBe("TIMELINE_CLIP_NOT_FOUND");

    const appended = await manager.execute(
      "timeline.appendClips",
      { mediaIds: ["missing-clip"] },
      { timeoutMs: 2000 }
    );
    expect(appended.response.ok).toBe(false);
    expect(appended.response.error?.code).toBe("TIMELINE_CLIP_NOT_FOUND");
  });

  it("reports unsupported commands honestly", async () => {
    await startAdapter();
    const response = await bridge.send(createRequest("milestone6.render"), { timeoutMs: 2000 });
    expect(response.ok).toBe(false);
    expect(response.status).toBe("unsupported");
    expect(response.error?.code).toBe("UNSUPPORTED_COMMAND");
  });
});
