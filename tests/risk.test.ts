import { describe, expect, it } from "vitest";
import { accountRisk, accountRuleProgress, buildTicket, calculateSize, guardAccount, platformRuleCheck, resolveAccountRequirements, roundMarketSize } from "../src/risk.js";

describe("risk sizing", () => {
  it("sizes from dollars at risk and rounds down", () => {
    expect(calculateSize(100, 100_000, 0.5, { id: "btc", size_precision: 3 })).toBe(0.2);
    expect(calculateSize(75, 2_000, 0.5, { id: "eth", size_decimals: 2 })).toBe(7.5);
  });

  it("uses the official step before precision and never rounds up", () => {
    expect(roundMarketSize(1.19, { id: "a", size_step: 0.25, size_decimals: 3 })).toBe(1);
    expect(roundMarketSize(0.3, { id: "a", size_step: 0.1 })).toBe(0.3);
    expect(roundMarketSize(0.29999999999999993, { id: "a", size_step: 0.1 })).toBe(0.2);
    expect(roundMarketSize(8e-8, { id: "a", size_step: 3e-8 })).toBe(6e-8);
    expect(roundMarketSize(1.19, { id: "a" })).toBeUndefined();
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

  it("uses equity to show pass progress, including a zero remaining amount", () => {
    const account = { id: "a", starting_balance: 25_000, risk: {
      remaining_profit: 1_000,
      remaining_profit_equity: 500,
      requirements: { profit_target_pct: 8 },
    } };
    expect(accountRuleProgress(account).profit).toMatchObject({ remaining: 500, achievedAmount: 1_500, achievedPercent: 75 });
    account.risk.remaining_profit_equity = 0;
    expect(accountRuleProgress(account).profit).toMatchObject({ remaining: 0, achievedPercent: 100 });
  });

  it("preserves unavailable equity progress and only falls back for older snapshots", () => {
    const risk = { marks_complete: false, remaining_profit: 1_000, requirements: { profit_target_pct: 8 } };
    const account = { id: "a", starting_balance: 25_000, risk: { ...risk, remaining_profit_equity: null } };
    expect(accountRuleProgress(account).profit).toMatchObject({ remaining: undefined, achievedPercent: undefined });
    expect(accountRuleProgress({ ...account, risk }).profit.remaining).toBe(1_000);
  });

  it("scales the same percentage rules to each account size", () => {
    const policy = { account_rules: [
      { rule_id: "daily-loss", parameters: { percent: 3 } },
      { rule_id: "maximum-drawdown", parameters: { percent: 5 } },
      { rule_id: "profit-target", parameters: { percent: 12 } },
    ] };
    const small = accountRuleProgress({ id: "25k", starting_balance: 25_000, risk: {} }, policy);
    const large = accountRuleProgress({ id: "100k", starting_balance: 100_000, risk: {} }, policy);
    expect(small.dailyLoss.limitAmount).toBe(750);
    expect(small.maxDrawdown.limitAmount).toBe(1_250);
    expect(small.profit.targetAmount).toBe(3_000);
    expect(large.dailyLoss.limitAmount).toBe(3_000);
    expect(large.maxDrawdown.limitAmount).toBe(5_000);
    expect(large.profit.targetAmount).toBe(12_000);
  });

  it("prefers current account policy rules over a retired risk snapshot", () => {
    const requirements = resolveAccountRequirements(
      { id: "a", risk: { requirements: { profit_target_pct: 9, max_drawdown_pct: 3 } } },
      { account_rules: {
        "profit-target": { parameters: { percentage: 10 } },
        "maximum-drawdown": { parameters: { basis_points: 600 } },
      } },
    );
    expect(requirements.profit_target_pct).toBe(10);
    expect(requirements.max_drawdown_pct).toBe(6);
  });

  it("uses funded account floors after withdrawal without reusing evaluation profit targets", () => {
    const funded = {
      id: "funded-100k", stage: "Funded", status: "active", starting_balance: 100_000,
      risk: {
        equity: 101_250, daily_loss_floor: 99_500, daily_loss_room: 1_750,
        max_drawdown_floor: 100_000, max_drawdown_room: 1_250,
        remaining_profit: 4_000,
        requirements: { profit_target_pct: 10, daily_loss_pct: 3, max_drawdown_pct: 6 },
      },
    };
    const policy = { account_rules: [{ rule_id: "profit-target", percentage: 12 }] };
    const progress = accountRuleProgress(funded, policy);
    expect(resolveAccountRequirements(funded, policy).profit_target_pct).toBeUndefined();
    expect(progress.profit.targetAmount).toBeUndefined();
    expect(progress.profit.remaining).toBeUndefined();
    expect(progress.dailyLoss).toMatchObject({ floor: 99_500, room: 1_750, limitAmount: 3_000 });
    expect(progress.maxDrawdown).toMatchObject({ floor: 100_000, room: 1_250, lockedFloor: true });
    expect(progress.maxDrawdown.limitAmount).toBeUndefined();
  });

  it("blocks excessive risk and policy restrictions", () => {
    const problems = guardAccount(
      { id: "a", status: "active", risk: { daily_loss_room: 300, max_loss_room: 1_000 } },
      { opening_exposure_restricted: true },
      100,
      100,
      20,
    );
    expect(problems).toContain("This account cannot open or increase positions right now.");
    expect(problems.some((p) => p.includes("remaining loss room"))).toBe(true);
  });

  it("allows a healthy account", () => {
    expect(guardAccount(
      { id: "a", status: "active", risk: { daily_loss_room: 2_000, max_loss_room: 3_000, marks_complete: true } },
      {}, 75, 100, 20,
    )).toEqual([]);
  });

  it("reports account-specific estimates without locally blocking the order", () => {
    const ticket = buildTicket({
      id: "t", userId: 1, accountId: "a", market: { id: "gold", max_leverage: 3, size_decimals: 6 }, symbol: "GOLD",
      side: "buy", riskUsd: 150, quote: { bid: 4287, ask: 4288, mid: 4287.5, estimated_notional: 30_000, estimated_fee: 1.5 },
      stopPercent: 0.5, rewardRisk: 2, leverage: 4, ttlSeconds: 45,
    });
    const check = platformRuleCheck({
      account: { id: "a", status: "active", risk: { available_balance: 5_000 } },
      policy: { limits: { max_position_value_usd: 25_000, max_open_positions: 1 } },
      market: { id: "gold", max_leverage: 3, size_decimals: 6 },
      ticket,
      openPositions: [{ id: "p", market_id: "btc" } as never],
    });
    expect(check.eligible).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.warnings.join(" ")).toContain("above the published cap");
    expect(check.warnings.join(" ")).toContain("maximum of 3x");
    expect(check.warnings.join(" ")).toContain("published limit of 1");
    expect(check.warnings.join(" ")).toContain("reported available balance");
  });

  it("can warn without enforcing user-configured limits", () => {
    const account = { id: "a", status: "active", risk: { daily_loss_room: 325, max_drawdown_room: 2_000 } } as const;
    expect(guardAccount(account, {}, 100, 100, 20)).toContain("Risk exceeds 20% of remaining loss room ($65.00).");
    expect(guardAccount(account, {}, 100, 100, 20, false)).toEqual([]);
  });
});
