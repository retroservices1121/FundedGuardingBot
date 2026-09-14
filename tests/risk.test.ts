import { describe, expect, it } from "vitest";
import { accountRisk, accountRuleProgress, buildTicket, calculateSize, guardAccount } from "../src/risk.js";

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
  it("normalizes official drawdown and profit field names", () => {
    const risk = accountRisk({ id: "a", risk: { max_drawdown_room: 4_500, remaining_profit: 2_000 } });
    expect(risk.max_loss_room).toBe(4_500);
    expect(risk.remaining_profit_target).toBe(2_000);
  });

  it("calculates each account rule against its own requirements", () => {
    const progress = accountRuleProgress({
      id: "a",
      starting_balance: 100_000,
      risk: {
        remaining_profit: 4_580,
        daily_loss_floor: 98_000,
        daily_loss_room: 1_500,
        max_drawdown_floor: 94_000,
        max_drawdown_room: 4_500,
        requirements: { profit_target_pct: 8, daily_loss_pct: 3, max_drawdown_pct: 6 },
      },
    });
    expect(progress.profit).toMatchObject({ targetAmount: 8_000, achievedAmount: 3_420, achievedPercent: 42.75 });
    expect(progress.dailyLoss).toMatchObject({ limitAmount: 3_000, usedAmount: 1_500, usedPercent: 50 });
    expect(progress.maxDrawdown).toMatchObject({ limitAmount: 6_000, usedAmount: 1_500, usedPercent: 25 });
  });

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

  it("can warn without enforcing user-configured limits", () => {
    const account = { id: "a", status: "active", risk: { daily_loss_room: 325, max_drawdown_room: 2_000 } } as const;
    expect(guardAccount(account, {}, 100, 100, 20)).toContain("Risk exceeds 20% of remaining loss room ($65.00).");
    expect(guardAccount(account, {}, 100, 100, 20, false)).toEqual([]);
  });
});
