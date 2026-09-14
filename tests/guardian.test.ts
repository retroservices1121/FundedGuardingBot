import { describe, expect, it } from "vitest";
import { accountDailyPnl, automaticLockReason, riskBand } from "../src/guardian.js";

describe("daily Guardian controls", () => {
  it("derives daily P&L from the account loss floor", () => {
    expect(accountDailyPnl({ id: "a", starting_balance: 100_000, risk: { equity: 101_200, daily_loss_floor: 97_500 } })).toBe(700);
  });
  it("detects configured profit and loss locks", () => {
    const user = { dailyProfitLockUsd: 250, dailyLossLockUsd: 200 } as never;
    expect(automaticLockReason(user, 300)).toBe("Daily profit target reached");
    expect(automaticLockReason(user, -225)).toBe("Daily loss limit reached");
  });
  it("raises risk bands as remaining room contracts", () => {
    expect(riskBand({ id: "a", risk: { daily_loss_room: 140, max_loss_room: 500 } }, 75)).toBe("warning");
    expect(riskBand({ id: "a", risk: { daily_loss_room: 70, max_loss_room: 500 } }, 75)).toBe("critical");
  });
});
