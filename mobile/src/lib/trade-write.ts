import { ScreenError, serverErrorMessage } from './screen-error';

const writePaths = new Set(['trade/confirm', 'trade/quick', 'close/confirm', 'protection/confirm']);

export const isTradeWrite = (path: string, method: string) => method === 'POST' && writePaths.has(path);
export const isTradeCheck = (path: string, method: string) => method === 'POST' && (path === 'trade/check' || path === 'close/check');
export const uncertainWriteMessage = 'The result is unknown. Check MyFundedPerps before trying again.';
const legacyWriteMessage = "This older request can't be checked here. Please check MyFundedPerps for its status.";
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
  if (dryRun) return close ? 'Practice close complete. No order was sent.' : 'Practice order complete. No order was sent.';
  const action = close ? 'close order' : 'order';
  switch (status.toLowerCase()) {
    case 'legacy': return legacyWriteMessage;
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

export function protectionResultMessage({dryRun,status}: {dryRun:boolean; status:string}) {
  if (dryRun) return 'Practice edit complete. No orders were sent.';
  switch (status.toLowerCase()) {
    case 'updated': return 'Your exit orders were updated.';
    case 'rejected':
    case 'failed':
    case 'denied': return 'MyFundedPerps could not update your exit orders. Check your position there.';
    default: return 'Check MyFundedPerps for the latest on your exit orders.';
  }
}

export class TradeWriteValidationError extends ScreenError {}
export class TradeWriteUncertainError extends Error {
  constructor(message = uncertainWriteMessage) { super(message); }
}

export function tradeWriteResult(ok: boolean, status: number, body: unknown) {
  const result = body as { uncertain?: unknown; error?: unknown; code?: unknown; dryRun?: unknown; status?: unknown; warnings?: unknown } | null;
  const restarting = status === 503 && result?.code === 'restarting';
  // Older servers could send a validation status for an order that may have gone through.
  if (!ok && (status === 400 || status === 422 || restarting) && result?.uncertain === false && typeof result.error === 'string' && result.error.trim()) {
    throw new TradeWriteValidationError(serverErrorMessage(result.error, 'The request was rejected. Review the details before trying again.'));
  }
  if (ok && result?.status === 'legacy' && result.error === undefined) {
    throw new TradeWriteUncertainError(legacyWriteMessage);
  }
  if (!ok || !result || result.uncertain === true || result.error !== undefined ||
      typeof result.dryRun !== 'boolean' || typeof result.status !== 'string' || !result.status.trim() ||
      (result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.some(w => typeof w !== 'string')))) {
    throw new TradeWriteUncertainError();
  }
  return result;
}
