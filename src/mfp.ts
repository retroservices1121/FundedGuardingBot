import { randomUUID } from "node:crypto";
import type { ChallengeAccount, Market, Position, Quote, Side, TradingPolicy, WorkingOrder } from "./types.js";

interface ApiEnvelope<T> {
  data: T;
}
type OrderList<T> = T[] | { orders?: T[]; items?: T[] };

function orderList<T>(result: OrderList<T> | undefined) {
  const orders = Array.isArray(result) ? result : result?.orders ?? result?.items;
  return Array.isArray(orders) ? orders : undefined;
}

type OrderLookup = { status: "found"; order: Record<string, unknown> } | { status: "absent" | "failed" };

type RawMarket = Omit<Market, "id"> & { id?: unknown; market_id?: unknown };

export function isActiveAccount(account: ChallengeAccount) {
  return ["active", "trading"].includes(String(account.status ?? "").trim().toLowerCase());
}

export function isPassedAccount(account: ChallengeAccount) {
  return String(account.status ?? "").trim().toLowerCase() === "passed"
    && String(account.stage ?? "").trim().toLowerCase() === "evaluation";
}

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

function detailText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["rejection_reason", "reject_reason", "reason", "message", "detail", "issue"]) {
    const text = detailText(record[key]);
    if (text) return text;
  }
  return undefined;
}

export function orderRejectionReason(result: Record<string, unknown>): string | undefined {
  const reason = detailText(result);
  const reference = ["support_reference", "support_ref", "reference"]
    .map(key => result[key]).find(value => typeof value === "string");
  if (!reason && !reference) return undefined;
  return [reason, reference ? `Reference: ${reference}` : undefined].filter(Boolean).join(" ");
}

export class MfpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: string | null,
    readonly details?: unknown,
    readonly ruleId?: string,
  ) {
    super(message);
  }
}

export class MfpTransportError extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? "MyFundedPerps took too long to respond." : "Could not reach MyFundedPerps.");
  }
}

export const closeClientOrderId = (key: string) => `guardian-close-${key}`;

export class MfpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, allowBareList = false): Promise<T> {
    const signal = AbortSignal.timeout(12_000);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal,
    }).catch(error => {
      throw new MfpTransportError(signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError");
    });
    const payload = (await response.json().catch(error => {
      if (signal.aborted) throw new MfpTransportError(true);
      if (!(error instanceof SyntaxError)) throw new MfpTransportError(false);
      return {};
    })) as {
      data?: T;
      error?: { code?: string; message?: string; details?: unknown; rule_id?: string } | string;
    };
    if (!response.ok) {
      const error = typeof payload?.error === "object" ? payload.error : undefined;
      const baseMessage = typeof payload?.error === "string"
        ? payload.error
        : error?.message ?? detailText(error?.details) ?? `MyFundedPerps request failed (${response.status}).`;
      const fieldDetail = Array.isArray(error?.details)
        ? error.details.map((item) => {
          if (!item || typeof item !== "object") return detailText(item);
          const detail = item as Record<string, unknown>;
          const field = typeof detail.field === "string" ? detail.field : undefined;
          const issue = detailText(detail.issue ?? detail);
          return [field, issue].filter(Boolean).join(": ");
        }).filter(Boolean).join("; ")
        : undefined;
      const message = fieldDetail && !baseMessage.includes(fieldDetail) ? `${baseMessage} ${fieldDetail}` : baseMessage;
      throw new MfpError(
        message,
        response.status,
        error?.code,
        response.headers.get("retry-after"),
        error?.details,
        error?.rule_id,
      );
    }
    if (allowBareList) {
      if (response.status !== 200 || payload?.error) throw new MfpError("Could not check the order with MyFundedPerps.", response.status);
      return (payload as ApiEnvelope<T>)?.data ?? payload as T;
    }
    return (payload as ApiEnvelope<T>)?.data;
  }

  private async orderWrite(path: string, init: RequestInit) {
    let ambiguous: MfpError | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<Record<string, unknown>>(path, init);
      } catch (error) {
        if (!(error instanceof MfpError) || ![429, 500, 502, 503].includes(error.status)) {
          // A later refusal cannot prove an earlier attempt did not go through.
          throw ambiguous ?? error;
        }
        if (error.status !== 429) ambiguous = error;
        if (attempt === 2) throw ambiguous ?? error;
        const retryAfter = error.retryAfter?.trim();
        const wait = !retryAfter ? 0 : /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now();
        const delay = Math.max(Number.isNaN(wait) ? 0 : wait, 200 * 2 ** attempt) + Math.random() * 100;
        // Let the caller reconcile if the requested pause exceeds our retry budget.
        if (delay > 5_000) throw ambiguous ?? error;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
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

  async placeProtectedMarketOrder(input: {
    accountId: string;
    marketId: string;
    side: Side;
    size: number;
    expectedPrice: number;
    leverage: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    replaceOverlappingExits?: boolean;
    clientOrderId: string;
    idempotencyKey?: string;
  }) {
    const result = await this.orderWrite("/v1/orders", {
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
        ...((input.takeProfitPrice != null || input.stopLossPrice != null) && input.replaceOverlappingExits === true
          ? { replace_overlapping_exits: true } : {}),
      }),
    });
    const status = String(result?.status ?? "").toLowerCase();
    if (["rejected", "failed", "denied"].includes(status)) {
      throw new MfpError(orderRejectionReason(result) ?? "The order was rejected by the trading rules.", 422, typeof result.code === "string" ? result.code : undefined, null, result, typeof result.rule_id === "string" ? result.rule_id : undefined);
    }
    return result;
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
    const result = await this.request<OrderList<WorkingOrder>>(`/v1/orders?${query}`);
    if (Array.isArray(result)) return result;
    return result.orders ?? result.items ?? [];
  }

  async findOrderByClientOrderId(clientOrderId: string, accountId: string): Promise<OrderLookup> {
    const query = new URLSearchParams({ client_order_id: clientOrderId, account_id: accountId });
    const result = await this.request<OrderList<Record<string, unknown>>>(`/v1/orders?${query}`, {}, true).catch(() => undefined);
    const orders = orderList(result);
    if (orders?.length === 0) return { status: "absent" };
    if (orders?.length === 1 && orders[0] && typeof orders[0] === "object") {
      const order = orders[0];
      if ((order.client_order_id === undefined || order.client_order_id === clientOrderId) &&
          (order.account_id === undefined || order.account_id === accountId)) return { status: "found", order };
    }
    return { status: "failed" };
  }

  cancelOrder(orderId: string) {
    return this.request<Record<string, unknown>>(`/v1/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
  }

  closePosition(positionId: string, size: number | undefined, expectedPrice: number, idempotencyKey: string = randomUUID()) {
    if (size !== undefined && (!Number.isFinite(size) || size <= 0)) throw new Error("Close size must be positive.");
    if (!Number.isFinite(expectedPrice) || expectedPrice <= 0) throw new Error("Expected close price must be positive.");
    return this.orderWrite(`/v1/positions/${encodeURIComponent(positionId)}/close`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ client_order_id: closeClientOrderId(idempotencyKey), expected_price: expectedPrice, ...(size === undefined ? {} : { size }) }),
    });
  }

  replacePositionExits(position: Position, currentOrders: WorkingOrder[], takeProfitPrice: number, stopLossPrice: number, idempotencyKey = randomUUID()) {
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
      headers: { "Idempotency-Key": idempotencyKey },
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
