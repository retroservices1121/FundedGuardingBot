import { describe, expect, it } from "vitest";
import { closedPositionsMessage, positionsMessage } from "../src/format.js";

describe("positionsMessage", () => {
  it("shows an empty state", () => {
    expect(positionsMessage([])).toContain("No open positions");
  });

  it("renders a marked open position", () => {
    const message = positionsMessage([{
      id: "p1", account_id: "a1", market_id: "binance|BTCUSDT", provider: "binance",
      symbol: "BTC", coin: "BTCUSDT", side: "long", size: 0.1, entry_price: 77_000,
      leverage: 2, margin_mode: "cross", isolated_margin_extra: 0, status: "open",
      opened_at: 1, liquidation_price: 50_000, markPrice: 77_500, estimatedUnrealizedPnl: 50,
      estimatedCloseFee: 2.33,
    }]);
    expect(message).toContain("Open Positions (1)");
    expect(message).toContain("BTC");
    expect(message).toContain("$50.00");
    expect(message).toContain("Estimated close fee: $2.33");
  });
});

describe("closedPositionsMessage", () => {
  it("renders realized results and costs", () => {
    const message = closedPositionsMessage([{
      id: "p2", account_id: "a1", market_id: "binance|ETHUSDT", provider: "binance",
      symbol: "ETH", coin: "ETHUSDT", side: "short", size: 1, entry_price: 4_000,
      leverage: 2, margin_mode: "cross", isolated_margin_extra: 0, status: "closed",
      opened_at: 1, closed_at: 1_757_721_600_000, exit_price: 3_950, realized_pnl: 50,
      fees: 2.4, funding: -0.15,
    }]);
    expect(message).toContain("Recent Closed Positions");
    expect(message).toContain("Realized P&L: $50.00");
    expect(message).toContain("Total fees: $2.40");
    expect(message).toContain("Funding: -$0.15");
  });
});
