import { describe, expect, it } from "vitest";
import { percentMove, spreadBps, volumeMultiple } from "../src/pulse.js";

describe("Pulse market calculations", () => {
  it("calculates directional percentage moves", () => {
    expect(percentMove(100, 101)).toBeCloseTo(1);
    expect(percentMove(100, 98.5)).toBeCloseTo(-1.5);
    expect(percentMove(0, 100)).toBe(0);
  });

  it("calculates spread in basis points", () => {
    expect(spreadBps(99.95, 100.05)).toBeCloseTo(10);
    expect(spreadBps(101, 100)).toBe(0);
  });

  it("compares candle volume with a clean positive baseline", () => {
    expect(volumeMultiple(300, [100, 100, 100])).toBe(3);
    expect(volumeMultiple(300, [0, Number.NaN])).toBe(0);
  });
});
