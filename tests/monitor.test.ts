import { describe, expect, it } from "vitest";
import { guardianRiskAlert } from "../src/monitor.js";

describe("Guardian risk alerts", () => {
  it("uses the official max drawdown room field", () => {
    const message = guardianRiskAlert({
      id: "a",
      risk: { daily_loss_room: 177.98, max_drawdown_room: 850 },
    }, "warning");
    expect(message).toContain("Daily loss room: $177.98");
    expect(message).toContain("Maximum loss room: $850");
    expect(message).not.toContain("NaN");
  });

  it("supports the legacy maximum loss room field", () => {
    const message = guardianRiskAlert({
      id: "a",
      risk_snapshot: { daily_loss_room: 177.98, max_loss_room: 900 },
    }, "critical");
    expect(message).toContain("Maximum loss room: $900");
    expect(message).not.toContain("NaN");
  });

  it("omits a room the API does not provide", () => {
    const message = guardianRiskAlert({
      id: "a",
      risk: { daily_loss_room: 177.98 },
    }, "warning");
    expect(message).toContain("Daily loss room: $177.98");
    expect(message).not.toContain("Maximum loss room");
    expect(message).not.toContain("NaN");
  });
});
