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
  // An issued funded account is separate from its completed evaluation. A stale
  // evaluation target in the risk snapshot must not become a funded target.
  if (String(account.stage ?? "").toLowerCase() === "funded") delete requirements.profit_target_pct;
  return requirements;
}

export function accountRuleProgress(account: ChallengeAccount, policy?: TradingPolicy) {
  const risk = accountRisk(account);
  const startingBalance = finite(account.starting_balance);
  const requirement = resolveAccountRequirements(account, policy);
  const funded = String(account.stage ?? "").toLowerCase() === "funded";
  const amountFromPercent = (percent: unknown) => {
    const pct = finite(percent);
    return startingBalance !== undefined && pct !== undefined ? startingBalance * pct / 100 : undefined;
  };
  const lossRule = (limitPct: unknown, floor: unknown, room: unknown, lockedFloor = false) => {
    const pct = finite(limitPct);
    const limitAmount = lockedFloor ? undefined : amountFromPercent(pct);
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
      lockedFloor,
    };
  };
  const profitTargetPct = finite(requirement.profit_target_pct);
  const profitTargetAmount = amountFromPercent(profitTargetPct);
  const remainingProfit = funded ? undefined : finite(
    risk.remaining_profit_equity === undefined ? risk.remaining_profit : risk.remaining_profit_equity,
  );
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
    maxDrawdown: lossRule(requirement.max_drawdown_pct, risk.max_drawdown_floor, risk.max_drawdown_room,
      funded && startingBalance !== undefined && finite(risk.max_drawdown_floor) !== undefined
        && finite(risk.max_drawdown_floor)! >= startingBalance),
  };
}

export function tradingPolicyProblems(policy: TradingPolicy, market?: Market): string[] {
  const problems: string[] = [];
  if (policy.payout_pending) problems.push("Trading is paused while your payout is pending.");
  if (policy.copy_follower_locked || policy.copy_scope_blocked) problems.push("Your copy trading setup blocks this trade.");
  if (policy.manual_trading_blocked && !problems.length) problems.push("This account is blocked from placing trades manually.");
  if (policy.restriction?.restriction === "reduce_only") problems.push("This account can only reduce or close existing positions.");
  if (policy.opening_exposure_restricted) problems.push("This account cannot open or increase positions right now.");
  if (policy.competition?.opening_exposure_restricted) problems.push("Your competition account cannot open or increase positions right now.");
  if (policy.trading_halt?.platform) problems.push("MyFundedPerps has paused opening and increasing positions.");
  if (market) {
    const normalize = (value: string) => value.trim().toLowerCase().replace(/\s*\|\s*/g, "|");
    const allowlist = policy.competition?.market_allowlist;
    const marketId = market.market_id ?? market.id;
    const identifiers = [marketId, market.symbol, market.coin ?? marketId.split("|").at(-1)]
      .filter((value): value is string => !!value).map(normalize);
    if (allowlist?.length && !allowlist.some(entry => identifiers.includes(normalize(entry)))) {
      problems.push("This market is not available in your competition.");
    }
    const halted = policy.trading_halt?.categories;
    if (halted?.length) {
      const category = market.category?.trim();
      if (!category) problems.push("MyFundedPerps has paused trading in some markets. We don't have enough information to tell if this market is affected.");
      else if (halted.some(entry => normalize(entry) === normalize(category))) {
        problems.push("MyFundedPerps has paused opening and increasing positions in this market.");
      }
    }
  }
  return problems;
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
  problems.push(...tradingPolicyProblems(policy));
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
  const problems = tradingPolicyProblems(policy, market);
  const marketProblem = marketOrderProblem(market, ticket.size, ticket.estimatedNotional);
  if (marketProblem) problems.push(marketProblem);
  const warnings = guardAccount(account, {}, ticket.riskUsd, Number.POSITIVE_INFINITY, 100, false);
  const notes: string[] = [];

  if (maxPositionNotional !== undefined && ticket.estimatedNotional > maxPositionNotional) {
    warnings.push(`Estimated position notional ${ticket.estimatedNotional.toFixed(2)} is above the published cap of ${maxPositionNotional.toFixed(2)}.`);
  }
  if (minOrderNotional !== undefined && ticket.estimatedNotional < minOrderNotional) {
    warnings.push(`Estimated position notional is below the published minimum of ${minOrderNotional.toFixed(2)}.`);
  }
  if (maxLeverage !== undefined && ticket.leverage > maxLeverage) {
    warnings.push(`Selected ${ticket.leverage}x leverage is above the published maximum of ${maxLeverage}x for this trade.`);
  }
  if (maxOpenPositions !== undefined && openPositions.length >= maxOpenPositions
    && !openPositions.some(position => position.market_id === ticket.marketId)) {
    warnings.push(`This account has ${openPositions.length} open positions, which reaches the published limit of ${maxOpenPositions}.`);
  }
  if (availableBalance !== undefined && estimatedMargin !== undefined && estimatedMargin > availableBalance) {
    warnings.push(`Estimated margin and entry fee are ${estimatedMargin.toFixed(2)}, while reported available balance is ${availableBalance.toFixed(2)}.`);
  }

  if (maxPositionNotional === undefined) notes.push("The API did not publish a numeric position cap for this account.");
  if (maxLeverage === undefined) notes.push("The API did not publish a numeric leverage cap for this market.");
  notes.push("MyFundedPerps performs the final exposure, collateral, slippage, and account-state check when the order is submitted.");

  return {
    eligible: problems.length === 0,
    problems: [...new Set(problems)],
    warnings: [...new Set(warnings)],
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

export class RiskSizingError extends Error {}

export function marketAllowsOpening(market: Market): boolean {
  return market.reduce_only !== true && (market.trading_enabled ?? market.available !== false);
}

export function roundMarketSize(size: number, market?: Market): number | undefined {
  const precision = market?.size_decimals ?? market?.size_precision ?? market?.quantity_precision;
  const step = market?.size_step ?? (precision === undefined ? undefined : 10 ** -precision);
  if (step === undefined || !Number.isFinite(step) || step <= 0 || !Number.isFinite(size) || size < 0) return;

  // Work in whole step units, preserving decimal sizes such as 0.3 for a 0.1 step.
  const [mantissa, exponent = "0"] = step.toString().split("e");
  const decimals = Math.max(0, (mantissa!.split(".")[1]?.length ?? 0) - Number(exponent));
  const factor = 10 ** decimals;
  const unitsPerStep = Math.round(step * factor);
  const steps = Math.floor(size * factor / unitsPerStep);
  if (!Number.isSafeInteger((steps + 1) * unitsPerStep)) return;
  const next = (steps + 1) * unitsPerStep / factor;
  if (next <= size) return next;
  const rounded = steps * unitsPerStep / factor;
  return rounded <= size ? rounded : (steps - 1) * unitsPerStep / factor;
}

export function marketOrderProblem(market: Market, size: number, notional?: number): string | undefined {
  if (!marketAllowsOpening(market)) return "This market is closed to new orders.";
  if (size <= 0 || (market.min_size !== undefined && size < market.min_size)) {
    return market.min_size === undefined
      ? "The order is too small for this market."
      : `This market requires an order size of at least ${market.min_size}. Increase your risk amount or choose another market.`;
  }
  const rounded = roundMarketSize(size, market);
  if (rounded === undefined) return "We could not check the allowed order size for this market.";
  if (rounded !== size) return "The allowed order size changed. Review a new quote.";
  if (notional !== undefined && !Number.isFinite(notional)) return "A valid order value is unavailable.";
  if (notional !== undefined && market.min_notional !== undefined && notional < market.min_notional) {
    return `This market requires an order worth at least $${market.min_notional}. Increase your risk amount or choose another market.`;
  }
}

export function calculateSize(
  riskUsd: number,
  entryPrice: number,
  stopPercent: number,
  market: Market,
): number {
  const stopDistance = entryPrice * (stopPercent / 100);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) throw new RiskSizingError("A valid market price is unavailable.");
  const size = roundMarketSize(riskUsd / stopDistance, market);
  if (size === undefined) throw new RiskSizingError("We could not check the allowed order size for this market.");
  const problem = marketOrderProblem(market, size);
  if (problem) throw new RiskSizingError(problem);
  return size;
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
  size?: number;
  stopPercent: number;
  rewardRisk: number;
  leverage: number;
  ttlSeconds: number;
}): TradeTicket {
  const entry = input.quote.estimated_fill_price ?? input.quote.mid;
  if (!Number.isFinite(entry) || entry <= 0) throw new RiskSizingError("A valid market price is unavailable.");
  const size = input.size ?? calculateSize(input.riskUsd, entry, input.stopPercent, input.market);
  const estimatedNotional = input.quote.estimated_notional ?? size * entry;
  const problem = marketOrderProblem(input.market, size, estimatedNotional);
  if (problem) throw new RiskSizingError(problem);
  const requestedStopDistance = entry * (input.stopPercent / 100);
  const stopDistance = input.size === undefined ? requestedStopDistance : input.riskUsd / size;
  const stopRatio = stopDistance / requestedStopDistance;
  // Allow for floating-point noise at the 10% boundary.
  if (Math.abs(stopRatio - 1) > 0.1 + Number.EPSILON) {
    throw new RiskSizingError("The available order size and entry price would move your stop loss more than 10% from the distance you chose. Adjust your risk amount or stop distance and review again.");
  }
  const direction = input.side === "buy" ? 1 : -1;
  const stopLossPrice = entry - direction * stopDistance;
  const takeProfitPrice = entry + direction * stopDistance * input.rewardRisk;
  if (![stopLossPrice, takeProfitPrice].every(price => Number.isFinite(price) && price > 0)) {
    throw new RiskSizingError("These inputs produce invalid stop loss or take profit prices.");
  }
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
    stopLossPrice,
    takeProfitPrice,
    estimatedNotional,
    estimatedFee: input.quote.estimated_fee,
    leverage: input.leverage,
    expiresAt: Date.now() + input.ttlSeconds * 1000,
  };
}
