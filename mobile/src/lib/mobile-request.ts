import { DEMO_TOKEN } from './demo-session';
import { ScreenError, serverErrorMessage } from './screen-error';
import { isTradeCheck, isTradeWrite, tradeWriteResult, TradeWriteUncertainError } from './trade-write';

export class SessionError extends ScreenError {}

export const serverUnavailableMessage = 'Guardian is temporarily unavailable. Please try again later.';
const connectionMessage = 'Could not reach Guardian. Check your connection and try again.';
const responseMessage = 'Guardian sent an unexpected reply. Please try again.';
const sessionMessage = 'Your session has ended. Please sign in again.';

function parseReply(body: string) {
  try { return JSON.parse(body); }
  catch { return undefined; }
}

export function createMobileRequest(apiUrl?: string) {
  return async function request(path: string, method = 'GET', data?: unknown, token?: string) {
    if (token === DEMO_TOKEN) throw new ScreenError('This action is unavailable in demo mode.');
    if (!apiUrl || !apiUrl.startsWith('https://')) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('Guardian server address is missing or invalid.');
      throw new ScreenError(serverUnavailableMessage);
    }
    const trade = isTradeWrite(path, method) || isTradeCheck(path, method);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let ok: boolean;
    let status: number | undefined;
    let body: string;
    try {
      const response = await fetch(`${apiUrl}/api/mobile/auth/${path}`, { method, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}) });
      ({ok, status} = response);
      body = await response.text();
    } catch {
      if (trade) throw new TradeWriteUncertainError();
      if (status === 401) throw new SessionError(sessionMessage);
      throw new ScreenError(controller.signal.aborted ? 'Guardian took too long to respond.' : connectionMessage);
    } finally { clearTimeout(timer); }

    if (trade) return tradeWriteResult(ok, status, parseReply(body));
    if (!ok) {
      const result = parseReply(body);
      if (status === 401) throw new SessionError(serverErrorMessage(result?.error, sessionMessage));
      throw new ScreenError(serverErrorMessage(result?.error, responseMessage));
    }
    const result = parseReply(body);
    if (!result || typeof result !== 'object') throw new ScreenError(responseMessage);
    return result;
  };
}
