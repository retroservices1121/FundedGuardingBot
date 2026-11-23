const writePaths = new Set(['trade/confirm', 'trade/quick', 'close/confirm', 'protection/confirm']);

export const isTradeWrite = (path: string, method: string) => method === 'POST' && writePaths.has(path);
export const isTradeCheck = (path: string, method: string) => method === 'POST' && (path === 'trade/check' || path === 'close/check');
export const uncertainWriteMessage = 'The result is unknown. Check MyFundedPerps before trying again.';
export type ConfirmRetry = { path: 'trade/check' | 'close/check'; ticketId: string; userId: string };

export function parseConfirmRetry(value: string | null): ConfirmRetry | undefined {
  if (!value?.startsWith('{')) return;
  try {
    const data = JSON.parse(value);
    if (isTradeCheck(data?.path, 'POST') && typeof data.ticketId === 'string' && data.ticketId &&
        typeof data.userId === 'string' && data.userId) return data;
  } catch { /* Older lock values have no saved ticket. */ }
}

export function orderResultMessage({dryRun,status}: {dryRun:boolean; status:string}, close = false) {
  if (dryRun) return close ? 'Dry run checked. The position was left open.' : 'Dry run checked. No order was sent.';
  const action = close ? 'close order' : 'order';
  switch (status.toLowerCase()) {
    case 'filled': return `MyFundedPerps filled the ${action}.`;
    case 'rejected':
    case 'failed':
    case 'denied': return `MyFundedPerps rejected the ${action}.`;
    case 'canceled': return `MyFundedPerps reports that the ${action} was canceled.`;
    case 'expired': return `MyFundedPerps reports that the ${action} expired.`;
    case 'pending':
    case 'resting': return `The ${action} is pending. Check MyFundedPerps for the latest status.`;
    default: return `MyFundedPerps received the ${action}. Check its status there.`;
  }
}

export class TradeWriteValidationError extends Error {}
export class TradeWriteUncertainError extends Error {
  constructor() { super(uncertainWriteMessage); }
}

export function tradeWriteResult(ok: boolean, status: number, body: unknown) {
  const result = body as { uncertain?: unknown; error?: unknown; dryRun?: unknown; status?: unknown; warnings?: unknown } | null;
  // Older servers could send a validation status for an order that may have gone through.
  if (!ok && (status === 400 || status === 422) && result?.uncertain === false && typeof result.error === 'string' && result.error.trim()) {
    throw new TradeWriteValidationError(result.error);
  }
  if (!ok || !result || result.uncertain === true || result.error !== undefined ||
      typeof result.dryRun !== 'boolean' || typeof result.status !== 'string' || !result.status.trim() ||
      (result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.some(w => typeof w !== 'string')))) {
    throw new TradeWriteUncertainError();
  }
  return result;
}
