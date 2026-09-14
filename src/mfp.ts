import { randomUUID } from "node:crypto";
import type { ChallengeAccount, Market, Position, Quote, Side, TradingPolicy, WorkingOrder } from "./types.js";

interface ApiEnvelope<T> {
  data: T;
}

type RawMarket = Omit<Market, "id"> & { id?: unknown; market_id?: unknown };

export function normalizeMarkets(markets: RawMarket[]): Market[] {
  return markets.flatMap((market) => {
    const id = typeof market.id === "string"
      ? market.id
      : typeof market.market_id === "string"
        ? market.market_id
        : undefined;
    return id ? [{ ...market, id, market_id: typeof market.market_id === "string" ? market.market_id : undefined }] : [];
  });
}

export function buildQuotePath(marketId: string, side?: Side, size?: number) {
  if ((side === undefined) !== (size === undefined)) {
    throw new Error("Quote side and size must be provided together.");
  }
  const path = `/v1/markets/${encodeURIComponent(marketId)}/quote`;
  if (side === undefined || size === undefined) return path;
  if (!Number.isFinite(size) || size <= 0) throw new Error("Quote size must be positive.");
  const query = new URLSearchParams({ side, size: String(size) });
  return `${path}?${query.toString()}`;
}

export function orderPrice(order: WorkingOrder) {
  return order.trigger_price ?? order.limit_price ?? order.price ?? undefined;
}

export function positionExitOrders(orders: WorkingOrder[], position: Position) {
  return orders.filter((order) => order.reduce_only === true
    && (order.position_id === position.id || order.target_position_id === position.id
      || (!order.position_id && !order.target_position_id && order.market_id === position.market_id)));
}

export class MfpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
  }
}

export class MfpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(12_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: T;
      error?: { code?: string; message?: string; details?: unknown } | string;
    };
    if (!response.ok) {
      const error = typeof payload.error === "object" ? payload.error : undefined;
      throw new MfpError(
        error?.message ?? `MyFundedPerps request failed (${response.status}).`,
        response.status,
        error?.code,
        response.headers.get("retry-after"),
      );
    }
    return (payload as ApiEnvelope<T>).data;
  }

  listAccounts() {
    return this.request<ChallengeAccount[]>("/v1/accounts");
  }

  getAccount(accountId: string) {
    return this.request<ChallengeAccount>(`/v1/accounts/${encodeURIComponent(accountId)}`);
  }

  getTradingPolicy(accountId: string) {
    return this.request<TradingPolicy>(
      `/v1/accounts/${encodeURIComponent(accountId)}/trading-policy`,
    );
  }

  async listMarkets() {
    const markets = await this.request<RawMarket[]>("/v1/markets");
    if (!Array.isArray(markets)) throw new Error("MyFundedPerps returned an invalid market list.");
    return normalizeMarkets(markets);
  }

  getQuote(marketId: string, side?: Side, size?: number) {
    return this.request<Quote>(buildQuotePath(marketId, side, size));
  }

  placeProtectedMarketOrder(input: {
    accountId: string;
    marketId: string;
    side: Side;
    size: number;
    expectedPrice: number;
    leverage: number;
    stopLossPrice: number;
    takeProfitPrice: number;
    clientOrderId: string;
    idempotencyKey?: string;
  }) {
    return this.request<Record<string, unknown>>("/v1/orders", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey ?? randomUUID() },
      body: JSON.stringify({
        client_order_id: input.clientOrderId,
        type: "market",
        account_id: input.accountId,
        market_id: input.marketId,
        side: input.side,
        size: input.size,
        expected_price: input.expectedPrice,
        leverage: input.leverage,
        margin_mode: "cross",
        take_profit_price: input.takeProfitPrice,
        stop_loss_price: input.stopLossPrice,
      }),
    });
  }

  listOpenPositions(accountId: string) {
    const query = new URLSearchParams({ account_id: accountId, status: "open" });
    return this.request<Position[]>(`/v1/positions?${query}`);
  }

  listClosedPositions(accountId: string, limit = 10) {
    const query = new URLSearchParams({ account_id: accountId, status: "closed", limit: String(limit) });
    return this.request<Position[]>(`/v1/positions?${query}`);
  }

  async listWorkingOrders(accountId: string) {
    const query = new URLSearchParams({ account_id: accountId, status: "working" });
    const result = await this.request<WorkingOrder[] | { orders?: WorkingOrder[]; items?: WorkingOrder[] }>(`/v1/orders?${query}`);
    if (Array.isArray(result)) return result;
    return result.orders ?? result.items ?? [];
  }

  cancelOrder(orderId: string) {
    return this.request<Record<string, unknown>>(`/v1/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
  }

  closePosition(positionId: string, size?: number, idempotencyKey: string = randomUUID()) {
    if (size !== undefined && (!Number.isFinite(size) || size <= 0)) throw new Error("Close size must be positive.");
    return this.request<Record<string, unknown>>(`/v1/positions/${encodeURIComponent(positionId)}/close`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ type: "market", ...(size === undefined ? {} : { size }), client_order_id: `guardian-close-${randomUUID().slice(0, 12)}` }),
    });
  }

  replacePositionExits(position: Position, currentOrders: WorkingOrder[], takeProfitPrice: number, stopLossPrice: number) {
    if (![takeProfitPrice, stopLossPrice].every(value => Number.isFinite(value) && value > 0)) throw new Error("TP and SL prices must be positive.");
    const exits = positionExitOrders(currentOrders, position);
    const expected = exits.flatMap((order) => {
      const price = orderPrice(order);
      return price === undefined ? [] : [{
        order_id: order.id,
        price,
        size: order.size,
      }];
    });
    const operations: Record<string, unknown>[] = exits.map(order => ({ kind: "cancel", order_id: order.id }));
    const tpIndex = operations.length;
    const slIndex = tpIndex + 1;
    operations.push(
      { kind: "place", group: "tp", execution_type: "market", price: takeProfitPrice, size: position.size, oco_pair_with_operation_index: slIndex },
      { kind: "place", group: "sl", execution_type: "market", price: stopLossPrice, size: position.size, oco_pair_with_operation_index: tpIndex },
    );
    return this.request<Record<string, unknown>>(`/v1/positions/${encodeURIComponent(position.id)}/exit-orders`, {
      method: "PUT",
      body: JSON.stringify({ expected_position_size: position.size, expected_orders: expected, operations }),
    });
  }

  async cancelAllOrders(accountId: string, idempotencyKey = randomUUID()) {
    return this.request<Record<string, unknown>>(
      `/v1/accounts/${encodeURIComponent(accountId)}/cancel-all-orders`,
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: "{}" },
    );
  }
}
