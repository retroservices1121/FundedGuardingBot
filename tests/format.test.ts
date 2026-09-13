import { describe, expect, it } from "vitest";
import { positionsMessage } from "../src/format.js";

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
    }]);
    expect(message).toContain("Open Positions (1)");
    expect(message).toContain("BTC");
    expect(message).toContain("$50.00");
  });
});
