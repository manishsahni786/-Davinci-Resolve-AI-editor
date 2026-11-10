import { describe, expect, it } from "vitest";
import {
  FrameTimingError,
  frameToSeconds,
  parseFrameRate,
  planSegmentFrames,
  secondsToFrame,
  secondsToFrameCapacity
} from "../src/planning/frame-timing.js";

describe("frame timing", () => {
  it("parses integer and NTSC frame rates as exact rationals", () => {
    expect(parseFrameRate(30)).toEqual({ numerator: 30, denominator: 1 });
    expect(parseFrameRate("24")).toEqual({ numerator: 24, denominator: 1 });
    expect(parseFrameRate(23.976)).toEqual({ numerator: 24000, denominator: 1001 });
    expect(parseFrameRate(29.97)).toEqual({ numerator: 30000, denominator: 1001 });
    expect(parseFrameRate(59.94)).toEqual({ numerator: 60000, denominator: 1001 });
    expect(parseFrameRate(24000 / 1001)).toEqual({ numerator: 24000, denominator: 1001 });
  });

  it("rejects invalid frame rates", () => {
    expect(() => parseFrameRate(0)).toThrow(FrameTimingError);
    expect(() => parseFrameRate(Number.NaN)).toThrow(FrameTimingError);
  });

  it("converts seconds to frame indices and capacity", () => {
    const ntsc = parseFrameRate(29.97);
    expect(secondsToFrame(1, ntsc)).toBe(30);
    expect(secondsToFrame(10, ntsc)).toBe(300);
    expect(secondsToFrameCapacity(10, ntsc)).toBe(299);
    expect(secondsToFrameCapacity(10.01, ntsc)).toBe(300);
    expect(frameToSeconds(300, ntsc)).toBeCloseTo(10.01, 4);
  });

  it("plans source ranges, timeline record frames and durations", () => {
    const plan = planSegmentFrames({
      sourceStartSeconds: 15.5,
      sourceEndSeconds: 50.5,
      timelineStartSeconds: 15,
      sourceFrameRate: 30,
      timelineFrameRate: 30
    });
    expect(plan.sourceStartFrame).toBe(465);
    expect(plan.sourceEndFrameExclusive).toBe(1515);
    expect(plan.durationFrames).toBe(1050);
    expect(plan.recordFrame).toBe(450);
  });

  it("handles NTSC source and timeline rates without drift", () => {
    const plan = planSegmentFrames({
      sourceStartSeconds: 10,
      sourceEndSeconds: 20,
      timelineStartSeconds: 30,
      sourceFrameRate: 29.97,
      timelineFrameRate: 29.97
    });
    expect(plan.sourceStartFrame).toBe(300);
    expect(plan.sourceEndFrameExclusive).toBe(599);
    expect(plan.durationFrames).toBe(299);
    expect(plan.recordFrame).toBe(899);
  });

  it("rejects ranges shorter than a frame and inverted ranges", () => {
    expect(() => planSegmentFrames({
      sourceStartSeconds: 1,
      sourceEndSeconds: 1.01,
      timelineStartSeconds: 0,
      sourceFrameRate: 30,
      timelineFrameRate: 30
    })).toThrow(/shorter than one frame/);
    expect(() => planSegmentFrames({
      sourceStartSeconds: 5,
      sourceEndSeconds: 4,
      timelineStartSeconds: 0,
      sourceFrameRate: 30,
      timelineFrameRate: 30
    })).toThrow(/greater than source start/);
  });
});
