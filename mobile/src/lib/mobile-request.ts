import { DEMO_TOKEN } from './demo-session';
import { isTradeCheck, isTradeWrite, tradeWriteResult, TradeWriteUncertainError } from './trade-write';

export class SessionError extends Error {}

const connectionMessage = 'Could not reach Guardian. Check your connection and try again.';
const responseMessage = 'Guardian sent an unexpected reply. Please try again.';
const sessionMessage = 'Your session has ended. Please sign in again.';

function parseReply(body: string) {
  try { return JSON.parse(body); }
  catch { return undefined; }
}

export function createMobileRequest(apiUrl?: string) {
  return async function request(path: string, method = 'GET', data?: unknown, token?: string) {
    if (token === DEMO_TOKEN) throw new Error('Demo requests must stay on this device.');
    if (!apiUrl || !apiUrl.startsWith('https://')) throw new Error('The app server is not configured yet.');
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
      throw new Error(controller.signal.aborted ? 'Guardian took too long to respond.' : connectionMessage);
    } finally { clearTimeout(timer); }

    if (trade) return tradeWriteResult(ok, status, parseReply(body));
    if (!ok) {
      const result = parseReply(body);
      const message = typeof result?.error === 'string' && result.error.trim() ? result.error : undefined;
      if (status === 401) throw new SessionError(message ?? sessionMessage);
      throw new Error(message ?? responseMessage);
    }
    const result = parseReply(body);
    if (!result || typeof result !== 'object') throw new Error(responseMessage);
    return result;
  };
}
