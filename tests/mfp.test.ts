import { describe, expect, it } from "vitest";
import { normalizeMarkets } from "../src/mfp.js";

describe("market response normalization", () => {
  it("maps the documented market_id field to the internal id", () => {
    expect(normalizeMarkets([
      { market_id: "binance|BTCUSDT", symbol: "BTC", available: true },
    ])).toEqual([
      { id: "binance|BTCUSDT", market_id: "binance|BTCUSDT", symbol: "BTC", available: true },
    ]);
  });

  it("keeps legacy id responses and ignores malformed entries", () => {
    expect(normalizeMarkets([
      { id: "binance|ETHUSDT", symbol: "ETH" },
      { symbol: "BROKEN" },
    ])).toEqual([
      { id: "binance|ETHUSDT", market_id: undefined, symbol: "ETH" },
    ]);
  });
});
