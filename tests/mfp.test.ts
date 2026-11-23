import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuotePath, isActiveAccount, MfpClient, normalizeMarkets, orderPrice, orderRejectionReason, positionExitOrders } from "../src/mfp.js";
import { submitOrder } from "../src/mobile-order.js";
import { withinMobileWriteDeadline } from "../src/mobile-write-deadline.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const orderInput = {
  accountId: "account", marketId: "gold", side: "buy" as const, size: 1, expectedPrice: 4_000,
  leverage: 2, stopLossPrice: 3_980, takeProfitPrice: 4_040, clientOrderId: "guardian-t", idempotencyKey: "entry-key",
};

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

describe("account visibility", () => {
  it("shows only active or trading accounts", () => {
    expect([
      { id: "a", status: "active" },
      { id: "b", status: "TRADING" },
      { id: "c", status: "failed" },
      { id: "d", status: "breached" },
      { id: "e", status: "closed" },
    ].filter(account => isActiveAccount(account as never)).map(account => account.id)).toEqual(["a", "b"]);
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
    await new MfpClient("https://example.test", "secret").closePosition("position/1", 0.25, 101.5, "close-key");
    expect(request.mock.calls[0]![0]).toBe("https://example.test/v1/positions/position%2F1/close");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ client_order_id: "guardian-close-close-key", expected_price: 101.5, size: 0.25 });
    expect(request.mock.calls[0]![1].headers["Idempotency-Key"]).toBe("close-key");
  });

  it("omits size but includes the required expected price for a complete close", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { status: "pending" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    await new MfpClient("https://example.test", "secret").closePosition("position-1", undefined, 99.5, "close-all-key");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ client_order_id: "guardian-close-close-all-key", expected_price: 99.5 });
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

describe("order write recovery", () => {
  const client = new MfpClient("https://example.test", "test-key");
  const receipt = { id: "order", status: "filled" };

  it.each([
    [{ ...orderInput, replaceOverlappingExits: true }, true],
    [{ ...orderInput, replaceOverlappingExits: true, takeProfitPrice: undefined }, true],
    [{ ...orderInput, replaceOverlappingExits: true, takeProfitPrice: undefined, stopLossPrice: undefined }, undefined],
    [orderInput, undefined],
  ] as const)("only sends the exit replacement flag with explicit consent and attached protection", async (input, expected) => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: receipt }));
    vi.stubGlobal("fetch", request);
    await client.placeProtectedMarketOrder(input);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0]![1].body).replace_overlapping_exits).toBe(expected);
  });

  it("preserves the rule ID on an exit allocation rejection", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({
      error: { code: "rule_violation", rule_id: "exit-allocation", message: "Overlapping exits" },
    }, { status: 422 }));
    vi.stubGlobal("fetch", request);
    await expect(client.placeProtectedMarketOrder(orderInput)).rejects.toMatchObject({ ruleId: "exit-allocation" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("looks up the documented order page by client order ID and account only", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [receipt], next_cursor: null }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    vi.stubGlobal("fetch", request);
    await expect(client.findOrderByClientOrderId("order /1", "account")).resolves.toEqual({status:"found",order:receipt});
    expect(request.mock.calls[0]![0]).toBe("https://example.test/v1/orders?client_order_id=order+%2F1&account_id=account");
    expect(request.mock.calls[0]![1].method).toBeUndefined();
    await expect(client.findOrderByClientOrderId("missing", "account")).resolves.toEqual({status:"absent"});
  });

  it.each([{orders:[receipt]},{items:[receipt]}])("looks up an order in a wrapped list", async data => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({data})));
    await expect(client.findOrderByClientOrderId("entry","account")).resolves.toEqual({status:"found",order:receipt});
  });

  it("distinguishes an empty list from invalid responses and failed requests", async () => {
    vi.stubGlobal("fetch",vi.fn()
      .mockResolvedValueOnce(Response.json({items:[]}))
      .mockResolvedValueOnce(Response.json({data:{}}))
      .mockResolvedValueOnce(Response.json({data:[]},{status:404}))
      .mockResolvedValueOnce(Response.json({data:[]},{status:201}))
      .mockRejectedValueOnce(new Error("Connection lost")));
    await expect(client.findOrderByClientOrderId("entry","account")).resolves.toEqual({status:"absent"});
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(client.findOrderByClientOrderId("entry","account")).resolves.toEqual({status:"failed"});
    }
  });

  it.each([429, 500, 502, 503])("retries an order on %s with backoff and the identical request", async status => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json(null, { status, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(Response.json({}, { status }))
      .mockResolvedValueOnce(Response.json({ data: receipt }));
    vi.stubGlobal("fetch", request);
    const result = client.placeProtectedMarketOrder(orderInput);
    await vi.advanceTimersByTimeAsync(1_049);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(449);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(receipt);
    expect(request).toHaveBeenCalledTimes(3);
    for (const [path, init] of request.mock.calls) {
      expect(path).toBe("https://example.test/v1/orders");
      expect(init.headers["Idempotency-Key"]).toBe("entry-key");
      expect(init.body).toBe(request.mock.calls[0]![1].body);
    }
  });

  it("limits close retries and keeps both IDs and the full payload stable", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockImplementation(async () => Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", request);
    const rejected = expect(client.closePosition("position", 0.25, 100, "close-key")).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await rejected;
    expect(request).toHaveBeenCalledTimes(3);
    for (const [, init] of request.mock.calls) {
      expect(init.headers["Idempotency-Key"]).toBe("close-key");
      expect(JSON.parse(init.body)).toEqual({client_order_id:"guardian-close-close-key",expected_price:100,size:0.25});
    }
  });

  it("honors Retry-After and keeps the full exit edit and key identical", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(Response.json({ data: { status: "updated" } }));
    vi.stubGlobal("fetch", request);
    const position = { id: "p1", market_id: "gold", size: 1 } as never;
    const key = "00000000-0000-4000-8000-000000000001";
    const edit = client.replacePositionExits(position, [], 110, 95, key);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(edit).resolves.toEqual({ status: "updated" });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [path, init] of request.mock.calls) {
      expect(path).toBe("https://example.test/v1/positions/p1/exit-orders");
      expect(init).toMatchObject({ method: "PUT", headers: { "Idempotency-Key": key }, body: request.mock.calls[0]![1].body });
    }
  });

  it("shares the mobile write deadline with validation, retry waits and reconciliation", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const replyAfter = (ms: number, response: Response) => () =>
      new Promise<Response>(resolve => setTimeout(() => resolve(response), ms));
    let lookupSignal: AbortSignal | undefined;
    const request = vi.fn()
      .mockImplementationOnce(replyAfter(11_000, Response.json({ data: { id: "account" } })))
      .mockImplementationOnce(replyAfter(11_000, Response.json({}, { status: 503, headers: { "Retry-After": "4" } })))
      .mockImplementationOnce(replyAfter(11_000, Response.json({}, { status: 503 })))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockImplementationOnce((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
        lookupSignal = signal ?? undefined;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    vi.stubGlobal("fetch", request);
    const result = withinMobileWriteDeadline(async () => {
      await client.getAccount(orderInput.accountId);
      return submitOrder(client, orderInput.clientOrderId, orderInput.accountId, () => client.placeProtectedMarketOrder(orderInput));
    });
    const rejected = expect(result).rejects.toThrow("Check MyFundedPerps");
    await vi.advanceTimersByTimeAsync(39_999);
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[4]![0]).toContain("client_order_id=");
    expect(lookupSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(lookupSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("never starts a mobile order after the deadline even if validation finishes late", async () => {
    vi.useFakeTimers();
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    let lateOrder: Promise<unknown> | undefined;
    const result = withinMobileWriteDeadline(async () => {
      await new Promise(resolve => setTimeout(resolve, 41_000));
      lateOrder = client.placeProtectedMarketOrder(orderInput).catch(error => error);
      return lateOrder;
    });
    const rejected = expect(result).rejects.toThrow("Check MyFundedPerps");
    await vi.advanceTimersByTimeAsync(40_000);
    await rejected;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await lateOrder).toMatchObject({ timedOut: true });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["create","close"])("preserves the rate limit after every %s attempt returns 429", async action => {
    vi.useFakeTimers();
    const request = vi.fn().mockImplementation(async () => Response.json({}, { status: 429 }));
    vi.stubGlobal("fetch", request);
    const order = action === "create" ? client.placeProtectedMarketOrder(orderInput) : client.closePosition("position",undefined,100,"close-key");
    const rejected = expect(order).rejects.toMatchObject({ status: 429 });
    await vi.runAllTimersAsync();
    await rejected;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry earlier than a long Retry-After or resend on a timeout", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "Retry-After": "60" } }))
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    vi.stubGlobal("fetch", request);
    await expect(client.placeProtectedMarketOrder(orderInput)).rejects.toMatchObject({ status: 429 });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(client.closePosition("position", undefined, 100, "close-key")).rejects.toMatchObject({ timedOut: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([401,429])("keeps an earlier server failure ambiguous when a retry returns %s", async status => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({}, { status: 500 }))
      .mockResolvedValueOnce(Response.json({}, { status, headers: { "Retry-After": "60" } }));
    vi.stubGlobal("fetch", request);
    const rejected = expect(client.placeProtectedMarketOrder(orderInput)).rejects.toMatchObject({ status: 500 });
    await vi.runAllTimersAsync();
    await rejected;
    expect(request).toHaveBeenCalledTimes(2);
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
