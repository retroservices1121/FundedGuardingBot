import type { ChallengeAccount, Market, Quote, Side, TradeTicket, TradingPolicy } from "./types.js";

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function accountRisk(account: ChallengeAccount) {
  return account.risk ?? account.risk_snapshot ?? {};
}

export function guardAccount(
  account: ChallengeAccount,
  policy: TradingPolicy,
  requestedRisk: number,
  maxRisk: number,
  maxLossRoomUsagePercent: number,
): string[] {
  const problems: string[] = [];
  const risk = accountRisk(account);
  if (account.status && !["active", "trading"].includes(account.status.toLowerCase())) {
    problems.push(`Account status is ${account.status}.`);
  }
  if (risk.marks_complete === false) problems.push("Fresh marks are incomplete.");
  if (policy.manual_trading_blocked) problems.push("Trading is blocked by account policy.");
  if (policy.opening_exposure_restricted) problems.push("Opening exposure is restricted.");
  if (policy.payout_pending) problems.push("A payout lock is active.");
  if (policy.copy_follower_locked || policy.copy_scope_blocked) problems.push("Copy-trading policy blocks this order.");
  if (policy.trading_halt?.platform) problems.push("The platform is under a trading halt.");
  if (policy.restriction?.restriction === "reduce_only") problems.push("Account is reduce-only.");
  if (requestedRisk > maxRisk) problems.push(`Requested risk $${requestedRisk} exceeds your $${maxRisk} cap.`);

  const dailyRoom = finite(risk.daily_loss_room);
  const maxRoom = finite(risk.max_loss_room);
  const limitingRoom = Math.min(dailyRoom ?? Infinity, maxRoom ?? Infinity);
  if (Number.isFinite(limitingRoom)) {
    const allowed = limitingRoom * (maxLossRoomUsagePercent / 100);
    if (requestedRisk > allowed) {
      problems.push(`Risk exceeds ${maxLossRoomUsagePercent}% of remaining loss room ($${allowed.toFixed(2)}).`);
    }
  }
  return problems;
}

export function calculateSize(
  riskUsd: number,
  entryPrice: number,
  stopPercent: number,
  precision: number,
): number {
  const stopDistance = entryPrice * (stopPercent / 100);
  if (stopDistance <= 0) throw new Error("Stop distance must be positive.");
  const rawSize = riskUsd / stopDistance;
  const factor = 10 ** precision;
  return Math.floor(rawSize * factor) / factor;
}

export function buildTicket(input: {
  id: string;
  userId: number;
  accountId: string;
  market: Market;
  symbol: string;
  side: Side;
  riskUsd: number;
  quote: Quote;
  stopPercent: number;
  rewardRisk: number;
  leverage: number;
  ttlSeconds: number;
}): TradeTicket {
  const entry = input.quote.estimated_fill_price ?? input.quote.mid;
  const precision = input.market.size_precision ?? input.market.quantity_precision ?? 6;
  const size = calculateSize(input.riskUsd, entry, input.stopPercent, precision);
  if (size <= 0) throw new Error("Calculated size is below the market minimum precision.");
  const stopDistance = entry * (input.stopPercent / 100);
  const direction = input.side === "buy" ? 1 : -1;
  return {
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    marketId: input.market.id,
    symbol: input.symbol,
    side: input.side,
    riskUsd: input.riskUsd,
    size,
    expectedPrice: entry,
    stopLossPrice: entry - direction * stopDistance,
    takeProfitPrice: entry + direction * stopDistance * input.rewardRisk,
    estimatedNotional: input.quote.estimated_notional ?? size * entry,
    estimatedFee: input.quote.estimated_fee,
    leverage: input.leverage,
    expiresAt: Date.now() + input.ttlSeconds * 1000,
  };
}
