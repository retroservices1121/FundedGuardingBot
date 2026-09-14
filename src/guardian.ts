import type { ChallengeAccount } from "./types.js";
import type { UserProfile } from "./db.js";

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function accountDailyPnl(account: ChallengeAccount) {
  const risk = account.risk ?? account.risk_snapshot ?? {};
  const equity = finite(risk.equity);
  const explicitStart = finite(risk.start_of_day_equity ?? risk.daily_start_equity ?? risk.day_start_equity);
  const floor = finite(risk.daily_loss_floor);
  const allowance = finite(risk.daily_loss_allowance ?? risk.daily_loss_limit)
    ?? (finite(account.starting_balance) !== undefined ? finite(account.starting_balance)! * 0.03 : undefined);
  const start = explicitStart ?? (floor !== undefined && allowance !== undefined ? floor + allowance : undefined);
  return equity !== undefined && start !== undefined ? equity - start : undefined;
}

export function automaticLockReason(user: UserProfile, dailyPnl: number | undefined) {
  if (dailyPnl === undefined) return undefined;
  if (user.dailyProfitLockUsd !== undefined && dailyPnl >= user.dailyProfitLockUsd) return "Daily profit target reached";
  if (user.dailyLossLockUsd !== undefined && dailyPnl <= -user.dailyLossLockUsd) return "Daily loss limit reached";
  return undefined;
}

export function riskBand(account: ChallengeAccount, riskUsd: number) {
  const risk = account.risk ?? account.risk_snapshot ?? {};
  const room = Math.min(...[finite(risk.daily_loss_room), finite(risk.max_loss_room)].filter((value): value is number => value !== undefined));
  if (!Number.isFinite(room)) return "normal";
  if (room <= riskUsd) return "critical";
  if (room <= riskUsd * 2) return "warning";
  return "normal";
}
