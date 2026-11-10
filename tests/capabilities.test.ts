import { describe, expect, it } from "vitest";
import {
  getCapability,
  listCapabilities,
  summarizeCapabilities
} from "../src/resolve/resolve-capabilities.js";

describe("resolve capability matrix", () => {
  it("records external scripting as restricted on Resolve Free", () => {
    const capability = getCapability("resolve.external-scripting");
    expect(capability?.status).toBe("restricted-free");
    expect(capability?.implemented).toBe(false);
  });

  it("records the internal Scripts menu as verified", () => {
    const capability = getCapability("resolve.internal-script-menu");
    expect(capability?.status).toBe("verified");
  });

  it("records read-only inspection as verified after live Resolve checks", () => {
    const capability = getCapability("resolve.inspection-readonly");
    expect(capability?.status).toBe("verified");
    expect(capability?.implemented).toBe(true);
  });

  it("records the MCP stdio server as verified", () => {
    const capability = getCapability("mcp.server");
    expect(capability?.status).toBe("verified");
    expect(capability?.implemented).toBe(true);
  });

  it("marks background polling as unsupported instead of pretending it works", () => {
    const capability = getCapability("bridge.background-polling");
    expect(capability?.status).toBe("unsupported");
  });

  it("marks milestone 5 timeline editing as verified", () => {
    const capability = getCapability("resolve.timeline-editing");
    expect(capability?.status).toBe("verified");
    expect(capability?.implemented).toBe(true);
    expect(capability?.milestone).toBe("5");
    expect(capability?.evidence).toContain("timeline.setItemProperty");
    expect(capability?.evidence).toContain("timeline.deleteClips");
    expect(capability?.evidence).toContain("Blue");
  });

  it("marks automatic bridge triggering and the reel workflow as verified", () => {
    const trigger = getCapability("bridge.auto-trigger");
    expect(trigger?.status).toBe("verified");
    expect(trigger?.implemented).toBe(true);
    expect(trigger?.evidence).toContain("UI Automation");

    const workflow = getCapability("resolve.editing-workflow");
    expect(workflow?.status).toBe("verified");
    expect(workflow?.implemented).toBe(true);
    expect(workflow?.evidence).toContain("npm run reel");
  });

  it("marks milestone 4 project and media management as verified", () => {
    const project = getCapability("resolve.project-management");
    expect(project?.status).toBe("verified");
    expect(project?.implemented).toBe(true);
    expect(project?.milestone).toBe("4");

    const media = getCapability("resolve.media-management");
    expect(media?.status).toBe("verified");
    expect(media?.implemented).toBe(true);
    expect(media?.milestone).toBe("4");
  });

  it("records the 21.1 ImportMedia calling-convention finding", () => {
    const media = getCapability("resolve.media-management");
    expect(media?.notes).toContain("ImportMedia([{clipInfo}]) returned nil");
    expect(media?.notes).toContain("ImportMedia([paths])");
  });

  it("marks the mock adapter as verified for the full command set", () => {
    const capability = getCapability("mock.management-commands");
    expect(capability?.status).toBe("verified");
    expect(capability?.implemented).toBe(true);
  });

  it("marks milestone 8 source-range editing as live-verified for single-track, multi-track and audio sequences", () => {
    const capability = getCapability("resolve.source-range-editing");
    expect(capability?.status).toBe("verified");
    expect(capability?.implemented).toBe(true);
    expect(capability?.milestone).toBe("8");
    expect(capability?.evidence).toContain("timeline.createFromRanges");
    expect(capability?.evidence).toContain("AIVE Range Live Test 2");
    expect(capability?.evidence).toContain("AIVE Audio Range Test");
    expect(capability?.notes).toContain("two-video-track and multi-source placement are live-verified");
    expect(capability?.notes).toContain("AUDIO_APPEND_FAILED");
  });

  it("returns a complete five-category summary", () => {
    const summary = summarizeCapabilities();
    expect(Object.keys(summary)).toHaveLength(5);
    expect(summary.verified).toBeGreaterThan(0);
    expect(summary["restricted-free"]).toBeGreaterThan(0);
    expect(listCapabilities().length).toBeGreaterThan(summary.verified);
  });
});
