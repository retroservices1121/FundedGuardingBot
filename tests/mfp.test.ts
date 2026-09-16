import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuotePath, MfpClient, normalizeMarkets, orderPrice, orderRejectionReason, positionExitOrders } from "../src/mfp.js";

afterEach(() => vi.unstubAllGlobals());

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

describe("position protection helpers", () => {
  const position = { id: "p1", market_id: "binance|BTCUSDT" } as never;
  it("finds reduction orders belonging to a position", () => {
    const orders = [
      { id: "tp", position_id: "p1", market_id: "binance|BTCUSDT", reduce_only: true },
      { id: "entry", market_id: "binance|BTCUSDT", reduce_only: false },
    ] as never;
    expect(positionExitOrders(orders, position).map((order) => order.id)).toEqual(["tp"]);
  });
  it("uses trigger price before limit or generic price", () => {
    expect(orderPrice({ trigger_price: 101, limit_price: 100, price: 99 } as never)).toBe(101);
  });
});

describe("position lifecycle requests", () => {
  it("submits a partial reduce-only position close", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { status: "pending" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    await new MfpClient("https://example.test", "secret").closePosition("position/1", 0.25, "close-key");
    expect(request.mock.calls[0]![0]).toBe("https://example.test/v1/positions/position%2F1/close");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ size: 0.25 });
    expect(request.mock.calls[0]![1].headers["Idempotency-Key"]).toBe("close-key");
  });

  it("omits all optional fields for a complete position close", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { status: "pending" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    await new MfpClient("https://example.test", "secret").closePosition("position-1", undefined, "close-all-key");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({});
  });

  it("replaces existing protection with one atomic OCO operation", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { status: "updated" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    const position = { id: "p1", market_id: "binance|BTCUSDT", size: 0.1 } as never;
    const orders = [{ id: "old-sl", position_id: "p1", market_id: "binance|BTCUSDT", reduce_only: true, trigger_price: 90, size: 0.1, execution_type: "market" }] as never;
    await new MfpClient("https://example.test", "secret").replacePositionExits(position, orders, 110, 95);
    const payload = JSON.parse(request.mock.calls[0]![1].body);
    expect(payload.expected_orders).toEqual([{ order_id: "old-sl", price: 90, size: 0.1 }]);
    expect(payload.operations).toEqual([
      { kind: "cancel", order_id: "old-sl" },
      { kind: "place", group: "tp", execution_type: "market", price: 110, size: 0.1, oco_pair_with_operation_index: 2 },
      { kind: "place", group: "sl", execution_type: "market", price: 95, size: 0.1, oco_pair_with_operation_index: 1 },
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

describe("order rejection details", () => {
  it("extracts the platform reason and support reference", () => {
    expect(orderRejectionReason({
      status: "rejected",
      rejection_reason: "Market exposure cap exceeded",
      support_reference: "ord_123",
    })).toBe("Market exposure cap exceeded Reference: ord_123");
  });

  it("throws when a successful API response contains a rejected order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { status: "rejected", reason: "Maximum position size exceeded" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(new MfpClient("https://example.test", "secret").placeProtectedMarketOrder({
      accountId: "a", marketId: "gold", side: "buy", size: 1, expectedPrice: 4_000,
      leverage: 2, stopLossPrice: 3_980, takeProfitPrice: 4_040, clientOrderId: "guardian-t",
    })).rejects.toThrow("Maximum position size exceeded");
  });
});
