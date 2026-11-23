const writePaths = new Set(['trade/confirm', 'trade/quick', 'close/confirm', 'protection/confirm']);

export const isTradeWrite = (path: string, method: string) => method === 'POST' && writePaths.has(path);
export const uncertainWriteMessage = 'The result is unknown. Check MyFundedPerps before trying again.';

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
