import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileRequest, SessionError } from '../src/lib/mobile-request';
import { TradeWriteUncertainError, TradeWriteValidationError } from '../src/lib/trade-write';

const request = createMobileRequest('https://guardian.example');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mobile requests', () => {
  it.each([[502, '<html>Gateway error</html>'], [200, ''], [200, '{']])('handles malformed replies (%s)', async (status, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {status})));
    await expect(request('dashboard')).rejects.toThrow('Guardian sent an unexpected reply.');
  });

  it.each(['', '<html>Unauthorized</html>', '{}', '{"error":17}'])('identifies expired sessions with body %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {status:401})));
    const result = request('me');
    await expect(result).rejects.toThrow(SessionError);
    await expect(result).rejects.toThrow('Your session has ended. Please sign in again.');
  });

  it('identifies an expired session when the reply body cannot be read', async () => {
    const response = new Response('', {status:401});
    vi.spyOn(response, 'text').mockRejectedValue(new Error('Could not read body'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(request('me')).rejects.toThrow(SessionError);
  });

  it('preserves a valid success and a plain-language server error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(new Response('{"error":"Connect MyFundedPerps first."}', {status:400})));
    await expect(request('dashboard')).resolves.toEqual({ok:true});
    await expect(request('dashboard')).rejects.toThrow('Connect MyFundedPerps first.');
  });

  it('uses a friendly connection error when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network request failed')));
    await expect(request('dashboard')).rejects.toThrow('Could not reach Guardian. Check your connection and try again.');
  });

  it.each(['dashboard', 'trade/confirm'])('handles timeouts without retrying %s', async path => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, {signal}: RequestInit) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
    }));
    vi.stubGlobal('fetch', fetch);
    const check = expect(request(path, 'POST')).rejects.toThrow(path === 'dashboard'
      ? 'Guardian took too long to respond.' : TradeWriteUncertainError);
    await vi.advanceTimersByTimeAsync(15000);
    await check;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[401, '{}'], [502, '<html>Gateway error</html>'], [200, '']])('keeps an unclear trade response uncertain (%s)', async (status, body) => {
    const fetch = vi.fn().mockResolvedValue(new Response(body, {status}));
    vi.stubGlobal('fetch', fetch);
    await expect(request('close/check', 'POST')).rejects.toThrow(TradeWriteUncertainError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps confirmed validation failures distinct from uncertain writes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Review a new quote.","uncertain":false}', {status:422})));
    await expect(request('trade/confirm', 'POST')).rejects.toThrow(TradeWriteValidationError);
  });
});
