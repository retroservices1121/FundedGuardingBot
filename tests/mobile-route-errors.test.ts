import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SecretBox } from '../src/crypto.js';
import type { Database } from '../src/db.js';
import { MfpClient, MfpError } from '../src/mfp.js';
import { startMiniAppServer } from '../src/mini-app-server.js';
import { MobileAuth } from '../src/mobile-auth.js';
import { MobileWriteUncertainError } from '../src/mobile-errors.js';
import { MobilePush } from '../src/mobile-push.js';
import type { Position } from '../src/types.js';

const config = loadConfig({
  TELEGRAM_BOT_TOKEN:'test', DATABASE_URL:'postgres://localhost/test',
  ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'), ALLOW_LIVE_TRADING:'true', DRY_RUN:'false',
});
const apiFetch = globalThis.fetch;
const position: Position = {
  id:'position', account_id:'account', size:2, market_id:'binance|BTCUSDT',
  provider:'binance', symbol:'BTCUSDT', coin:'BTC', side:'long', entry_price:100,
  leverage:1, margin_mode:'cross', isolated_margin_extra:0, status:'open', opened_at:0,
};
const trade = { marketId:position.market_id, side:'buy', riskUsd:10, leverage:1, stopPercent:1, rewardRisk:2, requestId:'quick-test-request-id-01' };
const edit = { positionId:position.id, takeProfitPrice:120, stopLossPrice:95 };
let server: Server;
let base: string;
const pool = { query: vi.fn() };

beforeAll(async () => {
  vi.spyOn(MobileAuth.prototype,'migrate').mockResolvedValue(undefined);
  vi.spyOn(MobilePush.prototype,'migrate').mockResolvedValue(undefined);
  vi.spyOn(MobilePush.prototype,'start').mockReturnValue(() => {});
  const log = vi.spyOn(console,'log').mockImplementation(() => {});
  server = startMiniAppServer({...config,PORT:0},{pool} as unknown as Database);
  await once(server,'listening');
  log.mockRestore();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a listening port.');
  base = `http://127.0.0.1:${address.port}/api/mobile/auth/`;
});

beforeEach(() => {
  pool.query.mockReset().mockResolvedValue({rows:[{id:'user',provider:'apple'}]});
  vi.spyOn(MobileAuth.prototype,'ticketResult').mockResolvedValue(undefined);
  vi.spyOn(MfpClient.prototype,'findOrderByClientOrderId').mockResolvedValue(undefined);
  vi.spyOn(MobileAuth.prototype,'connection').mockResolvedValue({
    environment:'live', selected_account_id:'account',
    encrypted_api_key:new SecretBox(config.ENCRYPTION_KEY).encrypt('test-key'),
    personal_guards:{mode:'off',quickTradeEnabled:true,quickAmounts:[10,50,100]},
  });
  vi.spyOn(MfpClient.prototype,'listOpenPositions').mockResolvedValue([position]);
  vi.spyOn(MfpClient.prototype,'listWorkingOrders').mockResolvedValue([]);
  vi.spyOn(MfpClient.prototype,'getAccount').mockResolvedValue({id:'account',status:'active'});
  vi.spyOn(MfpClient.prototype,'getTradingPolicy').mockResolvedValue({});
  vi.spyOn(MfpClient.prototype,'listMarkets').mockResolvedValue([{id:position.market_id,max_leverage:10}]);
  vi.spyOn(MfpClient.prototype,'getQuote').mockResolvedValue({mid:100,bid:99,ask:101});
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => new Promise<void>((resolve,reject) => {
  server.close(error => error ? reject(error) : resolve());
}));

function post(path: string, data: unknown, authorized = true) {
  return apiFetch(base + path, {
    method:'POST', headers:{'Content-Type':'application/json', ...(authorized ? {Authorization:'Bearer test-session'} : {})},
    body: JSON.stringify(data),
  });
}

describe('mobile route errors', () => {
  it.each([
    ['trade/quick', {...trade,requestId:undefined}, 'Open a new one-tap order confirmation.'],
    ['trade/quick', {...trade,riskUsd:11}, 'Choose one of your saved quick risk amounts.'],
    ['protection', {}, 'Choose an open position.'],
    ['protection/quote', {...edit,positionId:'missing'}, 'Position is no longer open on this account.'],
    ['protection/confirm', {}, 'Review an edit first.'],
    ['share', {}, 'Choose a closed position.'],
  ])('uses a validation response for %s', async (path, data, message) => {
    const response = await post(path, data);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error:message,uncertain:false});
  });

  it('uses 401 for an invalid session and 503 for a session lookup failure', async () => {
    pool.query.mockResolvedValueOnce({rows:[]});
    expect((await post('trade/quick',trade)).status).toBe(401);
    expect((await post('trade/quick',trade,false)).status).toBe(401);
    pool.query.mockRejectedValueOnce(new Error('Lookup failed.'));
    const response = await apiFetch(base + 'me',{headers:{Authorization:'Bearer test-session'}});
    expect(response.status).toBe(503);
  });

  it.each([[500,502],[503,503],[504,504]])('maps upstream status %s to an uncertain write response with status %s', async (upstreamStatus, expectedStatus) => {
    const error = new MfpError('Upstream response',upstreamStatus);
    vi.spyOn(MobileAuth.prototype,'saveTicket').mockImplementation(async (_token,ticket) => {
      vi.spyOn(MobileAuth.prototype,'claimTicket').mockResolvedValue(ticket);
      return true;
    });
    const send = vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockRejectedValue(error);
    const response = await post('trade/quick',trade);
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({
      error:'The result is unknown. Check MyFundedPerps before trying again.', uncertain:true,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the result uncertain if saving the accepted order fails', async () => {
    vi.spyOn(MobileAuth.prototype,'saveTicket').mockImplementation(async (_token,ticket) => {
      vi.spyOn(MobileAuth.prototype,'claimTicket').mockResolvedValue(ticket);
      return true;
    });
    vi.spyOn(MobileAuth.prototype,'saveTicketResult').mockRejectedValue(new Error('Storage failed.'));
    const send = vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({id:'order',status:'pending'});
    const response = await post('trade/quick',trade);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({uncertain:true});
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['trade/quote','close/quote'])('shows the uncertain lock on %s', async path => {
    const locked = new MobileWriteUncertainError('A previous request for this market is still being checked.');
    vi.spyOn(MobileAuth.prototype,'saveTicket').mockRejectedValue(locked);
    vi.spyOn(MobileAuth.prototype,'saveClose').mockRejectedValue(locked);
    const response = await post(path,path === 'trade/quote' ? {...trade,requestId:undefined} : {positionId:position.id,percent:25});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'The result is unknown. Check MyFundedPerps before trying again.',uncertain:true});
  });

  it('turns one-tap trading off with a patch to the saved preferences', async () => {
    const guards={mode:'warn',maxRiskUsd:30,quickAmounts:[10,50,100],quickTradeEnabled:false};
    pool.query.mockImplementation(async (sql:string) => sql.startsWith('UPDATE mobile_connections')
      ? {rows:[{personal_guards:guards}],rowCount:1}
      : {rows:[{id:'user',provider:'apple'}]});
    const response=await post('guards',{quickTradeEnabled:false});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(guards);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining(`personal_guards || '{"quickTradeEnabled":false}'::jsonb`),['user']);
  });

  it.each([
    [new TypeError('Fetch failed'),502],
    [new DOMException('Timed out','TimeoutError'),504],
  ])('locks protection after a transport failure and never resends the claimed edit', async (error, expectedStatus) => {
    vi.spyOn(MobileAuth.prototype,'saveClose').mockImplementation(async (_token,ticket) => {
      vi.spyOn(MobileAuth.prototype,'claimClose').mockResolvedValueOnce(ticket).mockResolvedValue(undefined);
    });
    vi.spyOn(MobileAuth.prototype,'closeTicketSubmitted').mockResolvedValue(true);
    const quote = await post('protection/quote',edit);
    expect(quote.status).toBe(200);
    const {ticket} = await quote.json();
    const send = vi.spyOn(globalThis,'fetch').mockRejectedValue(error);
    const response = await post('protection/confirm',{ticketId:ticket.id});
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toMatchObject({uncertain:true});
    const duplicate = await post('protection/confirm',{ticketId:ticket.id});
    expect(duplicate.status).toBe(503);
    expect(await duplicate.json()).toMatchObject({uncertain:true});
    expect(send).toHaveBeenCalledTimes(1);
  });
});
