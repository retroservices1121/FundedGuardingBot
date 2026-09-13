import { describe, expect, it } from "vitest";
import { buildQuotePath, normalizeMarkets } from "../src/mfp.js";

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

describe("quote request construction", () => {
  it("requests the initial quote without side or size", () => {
    expect(buildQuotePath("binance|BTCUSDT")).toBe(
      "/v1/markets/binance%7CBTCUSDT/quote",
    );
  });

  it("sends side and positive size together for a fill estimate", () => {
    expect(buildQuotePath("binance|BTCUSDT", "buy", 0.001)).toBe(
      "/v1/markets/binance%7CBTCUSDT/quote?side=buy&size=0.001",
    );
  });

  it("rejects a partial size-aware quote", () => {
    expect(() => buildQuotePath("binance|BTCUSDT", "sell")).toThrow(
      "Quote side and size must be provided together.",
    );
  });

  it("rejects a non-positive quote size", () => {
    expect(() => buildQuotePath("binance|BTCUSDT", "buy", 0)).toThrow(
      "Quote size must be positive.",
    );
  });
});
