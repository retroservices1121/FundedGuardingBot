import type { ChallengeAccount, Market, PlatformRuleCheck, Position, Quote, RiskSnapshot, Side, TradeTicket, TradingPolicy } from "./types.js";

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

function ruleRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = Object.entries(record).flatMap(([ruleId, item]) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    return [{ rule_id: ruleId, ...(item as Record<string, unknown>) }];
  });
  return [record, ...nested];
}

function percentFromRule(record: Record<string, unknown>) {
  const sources = [
    record,
    record.parameters,
    record.params,
    record.config,
  ].filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  for (const source of sources) {
    for (const key of ["percentage", "percent", "pct", "limit_pct", "value_pct", "value"]) {
      const value = finite(source[key]);
      if (value !== undefined) return value;
    }
    for (const key of ["basis_points", "bps", "value_bps"]) {
      const value = finite(source[key]);
      if (value !== undefined) return value / 100;
    }
  }
  return undefined;
}

export function resolveAccountRequirements(account: ChallengeAccount, policy?: TradingPolicy) {
  const requirements = { ...(accountRisk(account).requirements ?? {}) };
  const rules = ruleRecords(policy?.account_rules);
  const direct = rules[0];
  if (direct) {
    for (const key of ["daily_loss_pct", "max_drawdown_pct", "profit_target_pct", "consistency_pct"] as const) {
      const value = finite(direct[key]);
      if (value !== undefined) requirements[key] = value;
    }
  }
  for (const rule of rules) {
    const id = [rule.id, rule.rule_id, rule.slug, rule.type, rule.name].filter(Boolean).join(" ").toLowerCase().replace(/[_-]+/g, " ");
    const percent = percentFromRule(rule);
    if (percent === undefined) continue;
    if (id.includes("daily") && id.includes("loss")) requirements.daily_loss_pct = percent;
    else if ((id.includes("drawdown") || id.includes("maximum loss") || id.includes("max loss"))) requirements.max_drawdown_pct = percent;
    else if (id.includes("profit") && id.includes("target")) requirements.profit_target_pct = percent;
    else if (id.includes("consistency")) requirements.consistency_pct = percent;
  }
  return requirements;
}

export function accountRuleProgress(account: ChallengeAccount, policy?: TradingPolicy) {
  const risk = accountRisk(account);
  const startingBalance = finite(account.starting_balance);
  const requirement = resolveAccountRequirements(account, policy);
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


function finiteFrom(records: Array<Record<string, unknown> | undefined>, keys: string[]): number | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = finite(record[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

export function platformRuleCheck(input: {
  account: ChallengeAccount;
  policy: TradingPolicy;
  market: Market;
  ticket: TradeTicket;
  openPositions: Position[];
}): PlatformRuleCheck {
  const { account, policy, market, ticket, openPositions } = input;
  const limits = policy.limits as Record<string, unknown> | undefined;
  const sources = [limits, market as Record<string, unknown>, account as Record<string, unknown>];
  const maxPositionNotional = finiteFrom(sources, ["max_position_value_usd", "max_position_notional_usd", "max_notional_usd"]);
  const minOrderNotional = finiteFrom(sources, ["min_order_notional_usd", "minimum_order_notional_usd"]);
  const maxLeverage = finiteFrom(sources, ["max_leverage", "maximum_leverage"]);
  const maxOpenPositions = finiteFrom(sources, ["max_open_positions"]);
  const availableBalance = finite(accountRisk(account).available_balance);
  const estimatedMargin = ticket.leverage > 0
    ? ticket.estimatedNotional / ticket.leverage + (ticket.estimatedFee ?? 0)
    : undefined;
  const problems = guardAccount(account, policy, ticket.riskUsd, Number.POSITIVE_INFINITY, 100, false);
  const notes: string[] = [];

  if (maxPositionNotional !== undefined && ticket.estimatedNotional > maxPositionNotional) {
    problems.push(`Position notional ${ticket.estimatedNotional.toFixed(2)} exceeds the MyFundedPerps cap of ${maxPositionNotional.toFixed(2)}.`);
  }
  if (minOrderNotional !== undefined && ticket.estimatedNotional < minOrderNotional) {
    problems.push(`Position notional must be at least ${minOrderNotional.toFixed(2)}.`);
  }
  if (maxLeverage !== undefined && ticket.leverage > maxLeverage) {
    problems.push(`Selected ${ticket.leverage}x leverage exceeds the MyFundedPerps maximum of ${maxLeverage}x for this trade.`);
  }
  if (maxOpenPositions !== undefined && openPositions.length >= maxOpenPositions
    && !openPositions.some(position => position.market_id === ticket.marketId)) {
    problems.push(`This account already has ${openPositions.length} open positions, which reaches its limit of ${maxOpenPositions}.`);
  }
  if (availableBalance !== undefined && estimatedMargin !== undefined && estimatedMargin > availableBalance) {
    problems.push(`Estimated margin and entry fee require ${estimatedMargin.toFixed(2)}, but available balance is ${availableBalance.toFixed(2)}.`);
  }

  if (maxPositionNotional === undefined) notes.push("The API did not publish a numeric position cap for this account.");
  if (maxLeverage === undefined) notes.push("The API did not publish a numeric leverage cap for this market.");
  notes.push("MyFundedPerps performs the final exposure, collateral, slippage, and account-state check when the order is submitted.");

  return {
    eligible: problems.length === 0,
    problems: [...new Set(problems)],
    notes,
    requestedNotional: ticket.estimatedNotional,
    estimatedMargin,
    availableBalance,
    maxPositionNotional,
    minOrderNotional,
    maxLeverage,
    maxOpenPositions,
    openPositions: openPositions.length,
  };
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
