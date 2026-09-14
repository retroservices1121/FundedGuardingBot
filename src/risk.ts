import type { ChallengeAccount, Market, Quote, RiskSnapshot, Side, TradeTicket, TradingPolicy } from "./types.js";

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function accountRisk(account: ChallengeAccount): RiskSnapshot {
  const risk = account.risk ?? account.risk_snapshot ?? {};
  return {
    ...risk,
    max_drawdown_floor: risk.max_drawdown_floor ?? risk.max_loss_floor,
    max_drawdown_room: risk.max_drawdown_room ?? risk.max_loss_room,
    remaining_profit: risk.remaining_profit ?? risk.remaining_profit_target,
    // Preserve the first beta field names for older sandbox responses and existing views.
    max_loss_floor: risk.max_loss_floor ?? risk.max_drawdown_floor,
    max_loss_room: risk.max_loss_room ?? risk.max_drawdown_room,
    remaining_profit_target: risk.remaining_profit_target ?? risk.remaining_profit,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function accountRuleProgress(account: ChallengeAccount) {
  const risk = accountRisk(account);
  const startingBalance = finite(account.starting_balance);
  const requirement = risk.requirements ?? {};
  const amountFromPercent = (percent: unknown) => {
    const pct = finite(percent);
    return startingBalance !== undefined && pct !== undefined ? startingBalance * pct / 100 : undefined;
  };
  const lossRule = (limitPct: unknown, floor: unknown, room: unknown) => {
    const pct = finite(limitPct);
    const limitAmount = amountFromPercent(pct);
    const currentRoom = finite(room);
    const usedAmount = limitAmount !== undefined && currentRoom !== undefined
      ? clamp(limitAmount - currentRoom, 0, limitAmount)
      : undefined;
    return {
      limitPct: pct,
      limitAmount,
      floor: finite(floor),
      room: currentRoom,
      usedAmount,
      usedPercent: limitAmount && usedAmount !== undefined ? usedAmount / limitAmount * 100 : undefined,
    };
  };
  const profitTargetPct = finite(requirement.profit_target_pct);
  const profitTargetAmount = amountFromPercent(profitTargetPct);
  const remainingProfit = finite(risk.remaining_profit);
  const achievedAmount = profitTargetAmount !== undefined && remainingProfit !== undefined
    ? clamp(profitTargetAmount - remainingProfit, 0, profitTargetAmount)
    : undefined;
  return {
    profit: {
      targetPct: profitTargetPct,
      targetAmount: profitTargetAmount,
      remaining: remainingProfit,
      achievedAmount,
      achievedPercent: profitTargetAmount && achievedAmount !== undefined ? achievedAmount / profitTargetAmount * 100 : undefined,
    },
    dailyLoss: lossRule(requirement.daily_loss_pct, risk.daily_loss_floor, risk.daily_loss_room),
    maxDrawdown: lossRule(requirement.max_drawdown_pct, risk.max_drawdown_floor, risk.max_drawdown_room),
  };
}

export function guardAccount(
  account: ChallengeAccount,
  policy: TradingPolicy,
  requestedRisk: number,
  maxRisk: number,
  maxLossRoomUsagePercent: number,
  enforceUserLimits = true,
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
  if (enforceUserLimits && requestedRisk > maxRisk) problems.push(`Requested risk $${requestedRisk} exceeds your $${maxRisk} cap.`);

  const allowed = riskAllowance(account, maxRisk, maxLossRoomUsagePercent);
  if (enforceUserLimits && allowed.limitingRoom !== undefined) {
    if (requestedRisk > allowed.allowedRisk) {
      problems.push(`Risk exceeds ${maxLossRoomUsagePercent}% of remaining loss room ($${allowed.allowedRisk.toFixed(2)}).`);
    }
  }
  return problems;
}

export function riskAllowance(account: ChallengeAccount, maxRisk: number, maxLossRoomUsagePercent: number) {
  const risk = accountRisk(account);
  const rooms = [finite(risk.daily_loss_room), finite(risk.max_drawdown_room)]
    .filter((value): value is number => value !== undefined);
  const limitingRoom = rooms.length ? Math.min(...rooms) : undefined;
  const roomAllowance = limitingRoom === undefined ? maxRisk : limitingRoom * maxLossRoomUsagePercent / 100;
  return { limitingRoom, allowedRisk: Math.max(0, Math.min(maxRisk, roomAllowance)) };
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
