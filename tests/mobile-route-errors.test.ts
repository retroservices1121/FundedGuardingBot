import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuardianBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { SecretBox } from '../src/crypto.js';
import type { Database } from '../src/db.js';
import { MfpClient, MfpError } from '../src/mfp.js';
import { startMiniAppServer } from '../src/mini-app-server.js';
import { MobileAuth } from '../src/mobile-auth.js';
import { MobileWriteUncertainError } from '../src/mobile-errors.js';
import { MobilePush } from '../src/mobile-push.js';
import { MobileTrading } from '../src/mobile-trading.js';
import type { Position, TradeTicket } from '../src/types.js';

const config = loadConfig({
  TELEGRAM_BOT_TOKEN:'test', DATABASE_URL:'postgres://localhost/test',
  ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'), ALLOW_LIVE_TRADING:'true', DRY_RUN:'false',
});
const apiFetch = globalThis.fetch;
const adminToken = 'test-admin-token-'.repeat(3);
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
const telegramUser = {
  telegramId:42, selectedAccountId:'account', guardianMode:'off',
  riskUsd:10, stopPercent:1, rewardRisk:2, leverage:1,
};
const telegramDb = {
  upsertUser:vi.fn(), getConnection:vi.fn(), getUser:vi.fn(), putTicket:vi.fn(), takeTicket:vi.fn(),
};

beforeAll(async () => {
  vi.spyOn(MobileAuth.prototype,'migrate').mockResolvedValue(undefined);
  vi.spyOn(MobilePush.prototype,'migrate').mockResolvedValue(undefined);
  vi.spyOn(MobilePush.prototype,'start').mockReturnValue(() => {});
  const log = vi.spyOn(console,'log').mockImplementation(() => {});
  server = startMiniAppServer({...config,PORT:0},{pool,...telegramDb} as unknown as Database);
  await once(server,'listening');
  log.mockRestore();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a listening port.');
  base = `http://127.0.0.1:${address.port}/api/mobile/auth/`;
});

beforeEach(() => {
  pool.query.mockReset().mockResolvedValue({rows:[{id:'user',provider:'apple'}]});
  vi.spyOn(MobileAuth.prototype,'ticketResult').mockResolvedValue(undefined);
  vi.spyOn(MobileAuth.prototype,'withTicketWrite').mockImplementation((_id,_close,_environment,run)=>run(pool as never));
  vi.spyOn(MfpClient.prototype,'findOrderByClientOrderId').mockResolvedValue({status:'failed'});
  vi.spyOn(MobileAuth.prototype,'connection').mockResolvedValue({
    environment:'live', selected_account_id:'account',
    encrypted_api_key:new SecretBox(config.ENCRYPTION_KEY).encrypt('test-key'),
    personal_guards:{mode:'off',quickTradeEnabled:true,quickAmounts:[10,50,100]},
  });
  vi.spyOn(MfpClient.prototype,'listOpenPositions').mockResolvedValue([position]);
  vi.spyOn(MfpClient.prototype,'listWorkingOrders').mockResolvedValue([]);
  vi.spyOn(MfpClient.prototype,'getAccount').mockResolvedValue({id:'account',status:'active'});
  vi.spyOn(MfpClient.prototype,'getTradingPolicy').mockResolvedValue({});
  vi.spyOn(MfpClient.prototype,'listMarkets').mockResolvedValue([{id:position.market_id,max_leverage:10,size_step:0.25}]);
  vi.spyOn(MfpClient.prototype,'getQuote').mockResolvedValue({mid:100,bid:99,ask:101});
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => new Promise<void>((resolve,reject) => {
  server.close(error => error ? reject(error) : resolve());
}));

function post(path: string, data: unknown, authorized = true) {
  return apiFetch(base + path, {
    method:'POST', headers:{'Content-Type':'application/json', ...(authorized ? {Authorization:'Bearer test-session'} : {})},
    body: JSON.stringify(data),
  });
}

function telegramPost(path: string, data: unknown) {
  const init = new URLSearchParams({
    auth_date:String(Math.floor(Date.now()/1000)),
    user:JSON.stringify({id:telegramUser.telegramId,first_name:'Test'}),
  });
  const signed = [...init].map(([key,value]) => `${key}=${value}`).join('\n');
  const hashKey = createHmac('sha256','WebAppData').update(config.TELEGRAM_BOT_TOKEN).digest();
  init.set('hash',createHmac('sha256',hashKey).update(signed).digest('hex'));
  return apiFetch(new URL('/api/trade/'+path,base),{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`tma ${init}`},body:JSON.stringify(data),
  });
}

it('waits for migrations and drains an admitted write while refusing new ones', async () => {
  let finishMigration!: () => void;
  let finishWrite!: () => void;
  let startWrite!: () => void;
  const migration = new Promise<void>(resolve => { finishMigration = resolve; });
  const write = new Promise<void>(resolve => { finishWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { startWrite = resolve; });
  const stopPush = vi.fn();
  vi.spyOn(MobileAuth.prototype,'migrate').mockResolvedValue(undefined);
  vi.spyOn(MobilePush.prototype,'migrate').mockReturnValue(migration);
  vi.spyOn(MobilePush.prototype,'start').mockReturnValue(stopPush);
  const quick = vi.spyOn(MobileTrading.prototype,'quick').mockImplementation(async () => {
    startWrite();
    await write;
    return {dryRun:true,status:'validated'};
  });
  const drainingServer = startMiniAppServer({...config,PORT:0},{pool,...telegramDb} as unknown as Database);
  try {
    await once(drainingServer,'listening');
    const address = drainingServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a listening port.');
    const url = `http://127.0.0.1:${address.port}`;
    expect((await apiFetch(url+'/health')).status).toBe(503);
    finishMigration();
    const accepted = apiFetch(url+'/api/mobile/auth/trade/quick',{
      method:'POST',headers:{Authorization:'Bearer test-session'},body:'{}',
    });
    await writeStarted;
    expect((await apiFetch(url+'/health')).status).toBe(200);

    let drained = false;
    const drain = drainingServer.beginShutdown().then(() => { drained = true; });
    expect(stopPush).toHaveBeenCalledOnce();
    const health = await apiFetch(url+'/health');
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ok:false});
    for (const [method,path] of [
      ['POST','/api/mobile/auth/trade/quick'], ['POST','/api/mobile/auth/trade/confirm'],
      ['POST','/api/mobile/auth/close/confirm'], ['POST','/api/mobile/auth/protection/confirm'],
      ['POST','/api/trade/confirm'], ['POST','/api/positions/position/close'],
      ['PUT','/api/positions/position/protection'], ['POST','/api/orders/order/cancel'],
    ]) {
      const response = await apiFetch(url+path,{method});
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error:'Funded Guardian is restarting, try again in a moment',uncertain:false,code:'restarting',
      });
    }
    expect((await apiFetch(url+'/api/mobile/auth/trade/check',{method:'POST'})).status).toBe(401);
    expect(quick).toHaveBeenCalledOnce();
    expect(drained).toBe(false);
    finishWrite();
    expect((await accepted).status).toBe(200);
    await drain;
  } finally {
    finishMigration();
    finishWrite();
    await new Promise<void>(resolve => drainingServer.close(() => resolve()));
  }
});

it.each([
  ['trade',trade,'placeProtectedMarketOrder'],
  ['close',{positionId:position.id,percent:100},'closePosition'],
  ['protection',edit,'replacePositionExits'],
] as const)('stops an admitted %s before sending when shutdown starts', async (kind,input,method) => {
  vi.spyOn(MobileAuth.prototype,'migrate').mockResolvedValue(undefined);
  vi.spyOn(MobilePush.prototype,'migrate').mockResolvedValue(undefined);
  vi.spyOn(MobilePush.prototype,'start').mockReturnValue(() => {});
  const log = vi.spyOn(console,'log').mockImplementation(() => {});
  const drainingServer = startMiniAppServer({...config,PORT:0},{pool} as unknown as Database);
  try {
    await once(drainingServer,'listening');
    log.mockRestore();
    const address = drainingServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a listening port.');
    const sendRequest = (path: string,data: unknown) => apiFetch(
      `http://127.0.0.1:${address.port}/api/mobile/auth/${kind}/${path}`,
      {method:'POST',headers:{Authorization:'Bearer test-session'},body:JSON.stringify(data)},
    );
    let drain: ReturnType<typeof drainingServer.beginShutdown> | undefined;
    vi.spyOn(MobileAuth.prototype,'saveTicket').mockResolvedValue(true);
    vi.spyOn(MobileAuth.prototype,'saveClose').mockResolvedValue(undefined);
    const quote = await sendRequest('quote',input);
    expect(quote.status).toBe(200);
    const {ticket} = await quote.json();
    vi.spyOn(MobileAuth.prototype,'claimTicket').mockResolvedValue(ticket);
    vi.spyOn(MobileAuth.prototype,'closeTicketResult').mockResolvedValue({payload:ticket});
    vi.spyOn(MobileAuth.prototype,'claimClose').mockImplementation(async () => {
      if (kind === 'protection') drain = drainingServer.beginShutdown();
      return ticket;
    });
    vi.mocked(MobileAuth.prototype.withTicketWrite).mockImplementation((_id,_close,_environment,run) => {
      drain = drainingServer.beginShutdown();
      return run(pool as never);
    });
    const save = vi.spyOn(MobileAuth.prototype,kind === 'trade' ? 'saveTicketResult' : 'saveCloseResult').mockResolvedValue(undefined);
    const send = vi.spyOn(MfpClient.prototype,method);
    const response = await sendRequest('confirm',{ticketId:ticket.id});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:'Funded Guardian is restarting, try again in a moment',uncertain:false,
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(ticket.id,{status:'not_submitted'});
    expect(send).not.toHaveBeenCalled();
    await drain;
  } finally {
    await new Promise<void>(resolve => drainingServer.close(() => resolve()));
  }
});

describe('mobile admin ticket routes', () => {
  const path = '/api/admin/mobile/tickets';
  const resolution = {ticketId:'ticket',kind:'close',operator:'Support',outcome:'submitted_verified',note:'Verified the close.'};
  function call(route: string, token?: string, input?: unknown) {
    return apiFetch(new URL(route,base),{
      method:input ? 'POST' : 'GET',
      headers:{'Content-Type':'application/json',...(token ? {Authorization:'Bearer '+token} : {})},
      body:input ? JSON.stringify(input) : undefined,
    });
  }

  it('requires the existing admin token on all three endpoints', async () => {
    vi.stubEnv('GUARDIAN_ADMIN_TOKEN',adminToken);
    const list = vi.spyOn(MobileAuth.prototype,'listUncertainTickets');
    const action = vi.spyOn(MobileAuth.prototype,'administerTicket');
    expect((await call(path)).status).toBe(401);
    expect((await call(path+'/check','mobile-session',resolution)).status).toBe(401);
    expect((await call(path+'/resolve',undefined,resolution)).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    vi.stubEnv('GUARDIAN_ADMIN_TOKEN','');
    expect((await call(path,adminToken)).status).toBe(401);
  });

  it('requires identity, note and an explicit outcome, and confirms only with boolean true', async () => {
    vi.stubEnv('GUARDIAN_ADMIN_TOKEN',adminToken);
    const action = vi.spyOn(MobileAuth.prototype,'administerTicket').mockResolvedValue({status:'dry_run',lookup:'failed',result:null});
    expect((await call(path+'/resolve',adminToken,{...resolution,operator:' '})).status).toBe(400);
    expect((await call(path+'/resolve',adminToken,{...resolution,note:' '})).status).toBe(400);
    expect((await call(path+'/resolve',adminToken,{...resolution,outcome:undefined})).status).toBe(400);
    expect(action).not.toHaveBeenCalled();
    for (const confirm of [undefined,'true',true]) {
      expect((await call(path+'/resolve',adminToken,{...resolution,confirm})).status).toBe(200);
      expect(action).toHaveBeenLastCalledWith('close','ticket',{
        action:'resolve',operator:'Support',outcome:'submitted_verified',note:'Verified the close.',confirm:confirm === true,
      });
    }
  });

  it('lists ticket metadata and exposes the authenticated check', async () => {
    vi.stubEnv('GUARDIAN_ADMIN_TOKEN',adminToken);
    const ticket = {id:'ticket',kind:'close',user_id:'user',account:'account',market:'market',
      submitted_at:'2026-01-01T00:00:00Z',age_seconds:61,legacy:true};
    const list = vi.spyOn(MobileAuth.prototype,'listUncertainTickets').mockResolvedValue([ticket]);
    const action = vi.spyOn(MobileAuth.prototype,'administerTicket').mockResolvedValue({status:'legacy',lookup:'legacy',result:null});
    const response = await call(path,adminToken);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({tickets:[ticket]});
    expect(list).toHaveBeenCalledOnce();
    const checked = await call(path+'/check',adminToken,{ticketId:'ticket',kind:'close',operator:'Support'});
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({status:'legacy',lookup:'legacy',result:null});
    expect(action).toHaveBeenCalledExactlyOnceWith('close','ticket',{action:'check',operator:'Support',note:''});
  });

  it('logs server failures without including error details', async () => {
    vi.stubEnv('GUARDIAN_ADMIN_TOKEN',adminToken);
    vi.spyOn(MobileAuth.prototype,'listUncertainTickets').mockRejectedValue(new Error('Database error details'));
    const log = vi.spyOn(console,'error').mockImplementation(() => {});
    const response = await call(path,adminToken);
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledExactlyOnceWith('Mobile ticket admin list failed.');
    expect(await response.text()).not.toContain('Database error details');
  });

  it('limits list, check and resolve to 120 requests per minute in total', async () => {
    vi.stubEnv('GUARDIAN_ADMIN_TOKEN',adminToken);
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+60_001);
    const list = vi.spyOn(MobileAuth.prototype,'listUncertainTickets').mockResolvedValue([]);
    const action = vi.spyOn(MobileAuth.prototype,'administerTicket').mockResolvedValue({status:'missing',lookup:'skipped',result:null});
    for (let i=0; i<119; i++) {
      const response = await call(path,adminToken);
      expect(response.status).toBe(200);
      await response.json();
    }
    expect((await call(path+'/check',adminToken,resolution)).status).toBe(200);
    expect((await call(path+'/resolve',adminToken,resolution)).status).toBe(429);
    expect(list).toHaveBeenCalledTimes(119);
    expect(action).toHaveBeenCalledOnce();
  });
});

describe('public legal pages', () => {
  const supportLink = '<a href="https://x.com/FundedGuardian">DM us on X @FundedGuardian</a>';

  it('links to the legal pages, X and the Telegram mini app from the landing page footer', async () => {
    const response = await apiFetch(new URL('/', base));
    expect(response.status).toBe(200);
    const html = await response.text();
    const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0];
    for (const route of ['/privacy', '/terms', '/support']) {
      expect(footer).toContain(`href="${route}"`);
    }
    expect(footer).toContain(supportLink);
    expect(footer).toContain('href="https://t.me/fundedguardianbot"');
    expect(html).toContain(`${supportLink} to withdraw consent or request removal.`);
  });

  it.each([
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Use'],
    ['/support', 'Support'],
  ])('serves %s and its .html alias for GET and HEAD', async (route, title) => {
    for (const path of [route, `${route}.html`]) {
      const url = new URL(path, base);
      const response = await apiFetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self';");
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none';");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      const html = await response.text();
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).toContain('href="/legal/legal.css"');
      expect(html).toContain(supportLink);
      expect(html).not.toContain('<script');

      const head = await apiFetch(url, {method:'HEAD'});
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await head.text()).toBe('');
    }
  });

  it('serves the legal stylesheet', async () => {
    const response = await apiFetch(new URL('/legal/legal.css', base));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await response.text()).toContain('.notice{');
  });

  it.each(['/unknown', '/legal/unknown.css', '/privacy/unknown', '/landing/image-0000000000000000.png'])('returns a generic 404 for %s', async path => {
    const response = await apiFetch(new URL(path, base));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({error:'Not found.'});
  });
});

describe('Telegram trading policy checks', () => {
  beforeEach(() => {
    Object.values(telegramDb).forEach(mock => mock.mockReset());
    telegramDb.upsertUser.mockResolvedValue(telegramUser);
    telegramDb.getUser.mockResolvedValue(telegramUser);
    telegramDb.getConnection.mockResolvedValue({
      environment:'live',encryptedApiKey:new SecretBox(config.ENCRYPTION_KEY).encrypt('test-key'),
    });
    vi.spyOn(MfpClient.prototype,'listAccounts').mockResolvedValue([{id:'account',status:'active'}]);
    vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([{id:trade.marketId,size_step:0.25,category:'crypto'}]);
  });

  it('blocks a mini-app quote outside the allowlist and rechecks policy at confirm', async () => {
    const policy = vi.mocked(MfpClient.prototype.getTradingPolicy);
    policy.mockResolvedValueOnce({competition:{market_allowlist:['ETH']}});
    const blocked = await telegramPost('quote',trade);
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({error:'This market is not available in your competition.'});
    expect(MfpClient.prototype.getQuote).not.toHaveBeenCalled();
    expect(telegramDb.putTicket).not.toHaveBeenCalled();

    const reviewed = await telegramPost('quote',trade);
    expect(reviewed.status).toBe(200);
    const {ticket} = await reviewed.json() as {ticket:TradeTicket};
    telegramDb.takeTicket.mockResolvedValueOnce(ticket);
    policy.mockResolvedValueOnce({trading_halt:{categories:['crypto']}});
    const send = vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
    const confirm = await telegramPost('confirm',{ticketId:ticket.id});
    expect(confirm.status).toBe(400);
    expect(await confirm.json()).toEqual({error:'MyFundedPerps has paused opening and increasing positions in this market.'});
    expect(policy).toHaveBeenLastCalledWith(ticket.accountId);
    expect(send).not.toHaveBeenCalled();
  });

  it('checks bot quotes and confirms even with personal guardrails off', async () => {
    let restarting = false;
    const bot = createGuardianBot(config,telegramDb as unknown as Database,() => restarting);
    bot.botInfo = {
      id:1,is_bot:true,first_name:'Guardian',username:'guardianbot',can_join_groups:true,
      can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:false,
      has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,
      can_manage_bots:false,supports_join_request_queries:false,
    };
    const reply = vi.fn();
    const answer = vi.fn();
    bot.api.config.use(async (_previous,method,payload) => {
      if (method === 'sendMessage' && 'text' in payload) reply(payload.text);
      if (method === 'answerCallbackQuery' && 'text' in payload) answer(payload.text);
      return {ok:true,result:true} as never;
    });
    const tap = (data:string) => bot.handleUpdate({
      update_id:1,callback_query:{
        id:'callback',chat_instance:'test',data,
        from:{id:telegramUser.telegramId,is_bot:false,first_name:'Test'},
        message:{message_id:1,date:0,chat:{id:telegramUser.telegramId,type:'private',first_name:'Test'}},
      },
    });
    const policy = vi.mocked(MfpClient.prototype.getTradingPolicy);
    policy.mockResolvedValueOnce({trading_halt:{categories:['crypto']}});
    await tap('draft:BTC:buy');
    expect(reply).toHaveBeenLastCalledWith(expect.stringContaining('paused opening and increasing positions in this market'));
    expect(MfpClient.prototype.getQuote).not.toHaveBeenCalled();

    await tap('draft:BTC:buy');
    const [ticket] = telegramDb.putTicket.mock.lastCall! as [TradeTicket];
    telegramDb.takeTicket.mockResolvedValueOnce(ticket);
    policy.mockResolvedValueOnce({payout_pending:true});
    const send = vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
    await tap('confirm:'+ticket.id);
    expect(reply).toHaveBeenLastCalledWith(expect.stringContaining('Trading is paused while your payout is pending.'));
    expect(policy).toHaveBeenLastCalledWith(ticket.accountId);
    expect(send).not.toHaveBeenCalled();

    restarting = true;
    telegramDb.takeTicket.mockClear();
    await tap('confirm:'+ticket.id);
    expect(answer).toHaveBeenLastCalledWith('Funded Guardian is restarting, try again in a moment');
    expect(telegramDb.takeTicket).not.toHaveBeenCalled();
  });
});

describe('mobile route errors', () => {
  it.each([
    [new MfpError('Rejected',422,'max_total_notional'), 'This order would put your account over its total position size limit. Try a smaller order.'],
    [new MfpError('Rejected',422,'market_closed'), 'This market is closed. Try again when it reopens.'],
    [new MfpError('Rejected',422,'market_unavailable'), 'This market is unavailable for this order.'],
    [new MfpError('Rejected',422,'account_trader_lockout_active'), 'Trader Lockout is active on your account. Wait until it ends before trying again.'],
    [new MfpError('Rejected',422,'rule_violation',null,undefined,'exit-allocation'), 'This order overlaps existing take-profit or stop-loss orders. Review those exits on MyFundedPerps before trying again.'],
    [new MfpError(' HTTP 422: Choose a smaller order. https://example.test/detail ',422), 'Choose a smaller order.'],
  ])('returns plain copy for a MyFundedPerps rejection', async (error, message) => {
    vi.mocked(MfpClient.prototype.getTradingPolicy).mockRejectedValue(error);
    const response = await post('trade/quote',trade);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error:message,uncertain:false});
  });
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

  it.each([
    [500, 500, 75],
    [0, 0, 100],
    [undefined, 1_000, 50],
    [null, undefined, undefined],
  ])('returns dashboard profit progress for an equity-based remaining amount of %s', async (equityRemaining, remaining, achievedPercent) => {
    vi.mocked(MfpClient.prototype.getAccount).mockResolvedValue({
      id:'account', stage:'evaluation', status:'active', starting_balance:25_000,
      risk:{remaining_profit:1_000,remaining_profit_equity:equityRemaining,requirements:{profit_target_pct:8}},
    });
    const response = await apiFetch(base + 'dashboard',{headers:{Authorization:'Bearer test-session'}});
    expect(response.status).toBe(200);
    const {risk,rules} = await response.json();
    expect(risk.remaining_profit_equity).toBe(equityRemaining);
    expect(rules.profit.remaining).toBe(remaining);
    expect(rules.profit.achievedPercent).toBe(achievedPercent);
  });

  it('blocks a trade when a pause may apply and the market category is missing', async () => {
    vi.mocked(MfpClient.prototype.getTradingPolicy).mockResolvedValue({trading_halt:{categories:['crypto']}});
    const response = await post('trade/quote',trade);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error:"Trade blocked. MyFundedPerps has paused trading in some markets. We don't have enough information to tell if this market is affected.",uncertain:false});
    expect(MfpClient.prototype.getQuote).not.toHaveBeenCalled();
  });

  it('lists only markets that accept new orders', async () => {
    vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([
      {id:position.market_id,trading_enabled:true,available:false},
      {id:'paused',trading_enabled:false,available:true},
      {id:'reduce-only',trading_enabled:true,reduce_only:true},
    ]);
    const response = await apiFetch(base + 'markets',{headers:{Authorization:'Bearer test-session'}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({markets:[{id:position.market_id}]});
  });

  it('returns a definite trade block when the policy changes after review', async () => {
    vi.spyOn(MobileAuth.prototype,'saveTicket').mockImplementation(async (_token,ticket) => {
      vi.spyOn(MobileAuth.prototype,'claimTicket').mockResolvedValue(ticket);
      return true;
    });
    const quote = await post('trade/quote',{...trade,requestId:undefined});
    expect(quote.status).toBe(200);
    const {ticket} = await quote.json();
    vi.mocked(MfpClient.prototype.getTradingPolicy).mockResolvedValue({payout_pending:true});
    const send = vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
    const response = await post('trade/confirm',{ticketId:ticket.id});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error:'Trade blocked. Trading is paused while your payout is pending.',uncertain:false});
    expect(send).not.toHaveBeenCalled();
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
      const record = {payload:ticket,submitted_at:null as Date | null};
      vi.spyOn(MobileAuth.prototype,'closeTicketResult').mockResolvedValue(record);
      vi.spyOn(MobileAuth.prototype,'claimClose').mockImplementationOnce(async () => {
        record.submitted_at = new Date();
        return ticket;
      });
    });
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
