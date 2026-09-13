import { randomUUID } from "node:crypto";
import type { ChallengeAccount, Market, Quote, Side, TradingPolicy } from "./types.js";

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
    return this.request<Record<string, unknown>[]>(`/v1/positions?${query}`);
  }

  async cancelAllOrders(accountId: string, idempotencyKey = randomUUID()) {
    return this.request<Record<string, unknown>>(
      `/v1/accounts/${encodeURIComponent(accountId)}/cancel-all-orders`,
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: "{}" },
    );
  }
}
