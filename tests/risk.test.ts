import { describe, expect, it } from "vitest";
import { buildTicket, calculateSize, guardAccount } from "../src/risk.js";

describe("risk sizing", () => {
  it("sizes from dollars at risk and rounds down", () => {
    expect(calculateSize(100, 100_000, 0.5, 3)).toBe(0.2);
    expect(calculateSize(75, 2_000, 0.5, 2)).toBe(7.5);
  });

  it("builds correct long and short exits", () => {
    const base = {
      id: "abc", userId: 1, accountId: "acct", market: { id: "binance|BTCUSDT", size_precision: 3 },
      symbol: "BTC", riskUsd: 100, quote: { bid: 99_990, ask: 100_010, mid: 100_000 },
      stopPercent: 0.5, rewardRisk: 2, leverage: 2, ttlSeconds: 45,
    } as const;
    const long = buildTicket({ ...base, side: "buy" });
    const short = buildTicket({ ...base, side: "sell" });
    expect(long.stopLossPrice).toBe(99_500);
    expect(long.takeProfitPrice).toBe(101_000);
    expect(short.stopLossPrice).toBe(100_500);
    expect(short.takeProfitPrice).toBe(99_000);
  });
});

describe("guardian", () => {
  it("blocks excessive risk and policy restrictions", () => {
    const problems = guardAccount(
      { id: "a", status: "active", risk: { daily_loss_room: 300, max_loss_room: 1_000 } },
      { opening_exposure_restricted: true },
      100,
      100,
      20,
    );
    expect(problems).toContain("Opening exposure is restricted.");
    expect(problems.some((p) => p.includes("remaining loss room"))).toBe(true);
  });

  it("allows a healthy account", () => {
    expect(guardAccount(
      { id: "a", status: "active", risk: { daily_loss_room: 2_000, max_loss_room: 3_000, marks_complete: true } },
      {}, 75, 100, 20,
    )).toEqual([]);
  });
});
