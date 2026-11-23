import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileTrading, tradeInput } from '../src/mobile-trading.js';
import { MfpClient, MfpError, MfpTransportError } from '../src/mfp.js';
import { SecretBox } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
import type { Position, TradeTicket, TradingPolicy, WorkingOrder } from '../src/types.js';
const config=loadConfig({TELEGRAM_BOT_TOKEN:'test',DATABASE_URL:'postgres://localhost/test',ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),ALLOW_LIVE_TRADING:'true',DRY_RUN:'false'});
const input={marketId:'binance|BTCUSDT',side:'buy',riskUsd:65,leverage:5,stopPercent:1,rewardRisk:2};
const quickInput={...input,requestId:'quick-test-request-id-01'};
afterEach(()=>vi.restoreAllMocks());
function mocks(){
 const auth={user:vi.fn().mockResolvedValue({id:'user-a'}),connection:vi.fn().mockResolvedValue({environment:'live',encrypted_api_key:new SecretBox(config.ENCRYPTION_KEY).encrypt('fp_live_test'),selected_account_id:'account-a'}),saveTicket:vi.fn(),claimTicket:vi.fn(),cancelUnclaimedTicket:vi.fn(),ticketResult:vi.fn(),saveTicketResult:vi.fn()};
 vi.spyOn(MfpClient.prototype,'getAccount').mockResolvedValue({id:'account-a',status:'active'});
 vi.spyOn(MfpClient.prototype,'getTradingPolicy').mockResolvedValue({});
 vi.spyOn(MfpClient.prototype,'listMarkets').mockResolvedValue([{id:'binance|BTCUSDT',symbol:'BTC',coin:'BTCUSDT',category:'crypto',size_precision:3}]);
 vi.spyOn(MfpClient.prototype,'listOpenPositions').mockResolvedValue([]);
 vi.spyOn(MfpClient.prototype,'getQuote').mockResolvedValue({bid:100,ask:101,mid:100,estimated_fill_price:101,estimated_fee:1});
 vi.spyOn(MfpClient.prototype,'findOrderByClientOrderId').mockResolvedValue(undefined);
 return {auth,trading:new MobileTrading(auth as never,config)};
}
function positionWithExit(side:Position['side']='long'){
 vi.mocked(MfpClient.prototype.listOpenPositions).mockResolvedValue([{id:'position',market_id:input.marketId,side} as Position]);
 return vi.spyOn(MfpClient.prototype,'listWorkingOrders').mockResolvedValue([
  {id:'stop',position_id:'position',market_id:input.marketId,type:'stop_market',reduce_only:true} as WorkingOrder,
 ]);
}
async function storedTickets(){
 const {auth,trading}=mocks();
 auth.connection.mockResolvedValue({...await auth.connection(),personal_guards:{mode:'off',quickTradeEnabled:true,quickAmounts:[10,65,100]}});
 const records=new Map<string,{payload:TradeTicket;submitted_at?:Date;result?:unknown}>();
 auth.ticketResult.mockImplementation(async(_session,id)=>records.get(id));
 auth.saveTicket.mockImplementation(async(_session,ticket)=>{
  if(records.has(ticket.id))return false;
  records.set(ticket.id,{payload:ticket});
  return true;
 });
 auth.claimTicket.mockImplementation(async(_session,id)=>{
  const record=records.get(id);
  if(!record||record.result||record.submitted_at||record.payload.expiresAt<=Date.now())return;
  record.submitted_at=new Date();
  return record.payload;
 });
 auth.cancelUnclaimedTicket.mockImplementation(async(_session,id)=>{
  const record=records.get(id);
  if(record&&!record.submitted_at&&!record.result)record.result={status:'not_submitted'};
 });
 auth.saveTicketResult.mockImplementation(async(id,result)=>{records.get(id)!.result=result;});
 return {auth,trading};
}
describe('native trading',()=>{
 it('rejects invalid sizing before quoting',()=>{
  for(const bad of [{riskUsd:NaN},{riskUsd:0},{leverage:1.5},{stopPercent:100},{rewardRisk:-1},{side:'long'}])expect(()=>tradeInput({...input,...bad})).toThrow();
 });
 it('keeps the size-aware quoted size and computes stop risk from that size',async()=>{
  const {auth,trading}=mocks();const result=await trading.quote('session',input);
  expect(result.ticket.size).toBe(65);
  expect((result.ticket.expectedPrice-result.ticket.stopLossPrice)*result.ticket.size).toBeCloseTo(65);
  expect(auth.saveTicket).toHaveBeenCalledWith('session',result.ticket);
 });
 it('quotes and submits the same size rounded down to the official step',async()=>{
  const {auth,trading}=mocks();
  vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([
   {id:input.marketId,size_step:0.25,size_decimals:3,trading_enabled:true,available:false},
  ]);
  const {ticket}=await trading.quote('session',{...input,riskUsd:1.19});
  expect(ticket.size).toBe(1);
  expect(MfpClient.prototype.getQuote).toHaveBeenLastCalledWith(input.marketId,input.side,1);
  auth.claimTicket.mockResolvedValue(ticket);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({id:'order',status:'pending'});
  await trading.confirm('session',ticket.id);
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({size:1}));
 });
 it('rejects a rounded size below the market minimum before requesting a size-aware quote',async()=>{
  const {auth,trading}=mocks();
  vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([{id:input.marketId,size_step:0.25,min_size:1.25}]);
  await expect(trading.quote('session',{...input,riskUsd:1.19})).rejects.toThrow('order size of at least 1.25');
  expect(MfpClient.prototype.getQuote).toHaveBeenCalledExactlyOnceWith(input.marketId);
  expect(auth.saveTicket).not.toHaveBeenCalled();
 });
 it('rejects an estimated order value below the market minimum',async()=>{
  const {auth,trading}=mocks();
  vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([{id:input.marketId,size_step:0.25,min_notional:100}]);
  vi.mocked(MfpClient.prototype.getQuote).mockResolvedValue({bid:99,ask:101,mid:100,estimated_notional:99});
  await expect(trading.quote('session',{...input,riskUsd:1.19})).rejects.toThrow('worth at least $100');
  expect(auth.saveTicket).not.toHaveBeenCalled();
 });
 it('blocks new quotes and pending confirmations when the market stops accepting openings',async()=>{
  const {auth,trading}=await storedTickets();
  const {ticket}=await trading.quote('session',input);
  await trading.quote('session',quickInput);
  vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([
   {id:input.marketId,size_step:0.25,trading_enabled:false,available:true},
  ]);
  vi.mocked(MfpClient.prototype.getQuote).mockClear();
  auth.saveTicket.mockClear();
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quote('session',input)).rejects.toThrow('closed to new orders');
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('closed to new orders');
  await expect(trading.quick('session',quickInput)).rejects.toThrow('closed to new orders');
  expect(MfpClient.prototype.getQuote).not.toHaveBeenCalled();
  expect(auth.saveTicket).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
 });
 it('requires a new quote when the market step changes',async()=>{
  const {trading}=await storedTickets();
  const {ticket}=await trading.quote('session',{...input,riskUsd:1.1});
  vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([{id:input.marketId,size_step:0.25}]);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('allowed order size changed');
  expect(send).not.toHaveBeenCalled();
 });
 it('does not submit twice when a quote has already been claimed',async()=>{
  const {auth,trading}=mocks();auth.claimTicket.mockResolvedValue(undefined);auth.ticketResult.mockResolvedValue({submitted_at:new Date(),payload:{accountId:'account-a'}});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.confirm('session','ticket')).rejects.toThrow('already submitted');expect(send).not.toHaveBeenCalled();
 });
 it('refuses a quote after selected account changes',async()=>{
  const {auth,trading}=mocks();auth.claimTicket.mockResolvedValue({accountId:'different'});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.confirm('session','ticket')).rejects.toThrow('Selected account changed');expect(send).not.toHaveBeenCalled();
 });
 it('rechecks personal limits at confirmation when settings changed',async()=>{
  const {auth,trading}=mocks();const {ticket}=await trading.quote('session',input);auth.claimTicket.mockResolvedValue(ticket);
  auth.connection.mockResolvedValue({...await auth.connection(),personal_guards:{mode:'enforce',maxRiskUsd:50}});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('personal trade limit');expect(send).not.toHaveBeenCalled();
 });
 it('uses a stable idempotency key and reports pending rather than filled',async()=>{
  const {auth,trading}=mocks();const {ticket}=await trading.quote('session',input);auth.claimTicket.mockResolvedValue(ticket);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({id:'order',status:'pending'});
  expect(await trading.confirm('session',ticket.id)).toMatchObject({status:'pending',dryRun:false});
  expect(send).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:ticket.id,size:ticket.size}));
  expect(send.mock.calls[0]?.[0].replaceOverlappingExits).toBeUndefined();
 });
 it('previews replacement and submits a protected add only once',async()=>{
  const {trading}=await storedTickets();
  positionWithExit();
  const {ticket}=await trading.quote('session',{...quickInput,reviewExitReplacement:true});
  expect(ticket.exitReplacement).toEqual({positionId:'position',orderIds:['stop']});
  // The database can return JSON object keys in a different order.
  ticket.exitReplacement={orderIds:['stop'],positionId:'position'};
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({id:'order',status:'pending'});
  await trading.quick('session',{requestId:quickInput.requestId});
  await trading.quick('session',{requestId:quickInput.requestId});
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({replaceOverlappingExits:true,idempotencyKey:ticket.id}));
 });
 it('does not replace exits without a replacement review',async()=>{
  const {auth,trading}=await storedTickets();
  positionWithExit();
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quote('session',input)).rejects.toThrow('would replace your existing');
  await expect(trading.quick('session',{...quickInput,reviewExitReplacement:true})).rejects.toThrow('would replace your existing');
  expect(auth.saveTicket).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
 });
 it('does not replace exits on an opposite-side order',async()=>{
  const {trading}=await storedTickets();
  const orders=positionWithExit('short');
  const {ticket}=await trading.quote('session',{...input,reviewExitReplacement:true});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({id:'order',status:'pending'});
  await trading.confirm('session',ticket.id);
  expect(ticket.exitReplacement).toBeUndefined();
  expect(send.mock.calls[0]?.[0].replaceOverlappingExits).toBeUndefined();
  expect(orders).not.toHaveBeenCalled();
 });
 it('does not enable replacement when the add has no overlapping exit',async()=>{
  const {trading}=await storedTickets();
  positionWithExit().mockResolvedValue([
   {id:'other-exit',position_id:'other-position',market_id:input.marketId,type:'stop_market',reduce_only:true} as WorkingOrder,
   {id:'close',position_id:'position',market_id:input.marketId,type:'market',reduce_only:true} as WorkingOrder,
  ]);
  const {ticket}=await trading.quote('session',input);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({id:'order',status:'pending'});
  await trading.confirm('session',ticket.id);
  expect(ticket.exitReplacement).toBeUndefined();
  expect(send.mock.calls[0]?.[0].replaceOverlappingExits).toBeUndefined();
 });
 it('blocks confirmation when an exit appeared after the review',async()=>{
  const {trading}=await storedTickets();
  const {ticket}=await trading.quote('session',{...input,reviewExitReplacement:true});
  positionWithExit();
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('exits changed');
  expect(send).not.toHaveBeenCalled();
 });
 it('explains an exit allocation rejection without resubmitting',async()=>{
  const {trading}=await storedTickets();
  positionWithExit();
  const {ticket}=await trading.quote('session',{...input,reviewExitReplacement:true});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder')
   .mockRejectedValue(new MfpError('Rejected',422,'rule_violation',null,undefined,'exit-allocation'));
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('could not replace the existing exits');
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('order was not sent');
  expect(send).toHaveBeenCalledTimes(1);
 });
 const blockedPolicies:Array<[TradingPolicy,string]>=[
  [{manual_trading_blocked:true},'blocked from placing trades manually'],
  [{opening_exposure_restricted:true},'cannot open or increase positions'],
  [{payout_pending:true},'payout is pending'],
  [{copy_follower_locked:true},'copy trading setup'],
  [{copy_scope_blocked:true},'copy trading setup'],
  [{restriction:{restriction:'reduce_only'}},'can only reduce or close'],
  [{competition:{opening_exposure_restricted:true}},'competition account cannot open or increase positions'],
  [{competition:{market_allowlist:['ETH','bybit | BTCUSDT']}},'not available in your competition'],
  [{trading_halt:{platform:true}},'has paused opening and increasing positions'],
  [{trading_halt:{categories:['Crypto']}},'positions in this market'],
 ];
 it.each(blockedPolicies)('blocks quotes and rechecks fresh policy on confirmation (%j)',async(policy,message)=>{
  const {auth,trading}=await storedTickets();
  const {ticket}=await trading.quote('session',input);
  await trading.quote('session',quickInput);
  vi.mocked(MfpClient.prototype.getTradingPolicy).mockResolvedValue(policy);
  const price=vi.mocked(MfpClient.prototype.getQuote);
  price.mockClear();
  auth.saveTicket.mockClear();
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quote('session',input)).rejects.toThrow('Trade blocked.');
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow(message);
  await expect(trading.quick('session',{requestId:quickInput.requestId})).rejects.toThrow(message);
  expect(price).not.toHaveBeenCalled();
  expect(auth.saveTicket).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
 });
 it.each([[[]],[['btc']],[['BTCUSDT']],[['BINANCE | BTCUSDT']]])('allows matching or empty competition allowlists (%j)',async marketAllowlist=>{
  const {trading}=mocks();
  vi.mocked(MfpClient.prototype.getTradingPolicy).mockResolvedValue({
   competition:{market_allowlist:marketAllowlist},trading_halt:{categories:['stocks']},
  });
  await expect(trading.quote('session',input)).resolves.toMatchObject({ticket:{platformRules:{eligible:true}}});
 });
 it.each(['filled','rejected'])('recovers a lost order response with the real %s status',async status=>{
  const {auth,trading}=await storedTickets();
  const {ticket}=await trading.quote('session',input);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockRejectedValue(new MfpTransportError(true));
  const lookup=vi.mocked(MfpClient.prototype.findOrderByClientOrderId).mockResolvedValue({id:'order',status});
  const result={dryRun:false,status,orderId:'order'};
  await expect(trading.confirm('session',ticket.id)).resolves.toEqual(result);
  expect(lookup).toHaveBeenCalledWith(`guardian-native-${ticket.id}`,ticket.accountId);
  expect(auth.saveTicketResult).toHaveBeenCalledWith(ticket.id,result);
  await expect(trading.confirm('new-session',ticket.id,true)).resolves.toEqual(result);
  expect(send).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledTimes(1);
 });
 it('keeps a missing order uncertain and recovers it later with the same ticket',async()=>{
  const {auth,trading}=await storedTickets();
  const {ticket}=await trading.quote('session',input);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockRejectedValue(new MfpTransportError(true));
  const lookup=vi.mocked(MfpClient.prototype.findOrderByClientOrderId);
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('too long');
  await expect(trading.confirm('session',ticket.id,true)).rejects.toThrow('already submitted');
  expect(auth.saveTicketResult).not.toHaveBeenCalled();
  lookup.mockResolvedValue({order_id:'order',status:'filled'});
  await expect(trading.confirm('new-session',ticket.id,true)).resolves.toMatchObject({orderId:'order',status:'filled'});
  expect(send).toHaveBeenCalledTimes(1);
  expect(auth.saveTicket).toHaveBeenCalledTimes(1);
  for(const call of lookup.mock.calls)expect(call).toEqual([`guardian-native-${ticket.id}`,ticket.accountId]);
 });
 it('fences a confirm that never arrived before clearing the uncertain lock',async()=>{
  const {auth,trading}=await storedTickets();
  const {ticket}=await trading.quote('session',input);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.confirm('session',ticket.id,true)).rejects.toThrow('This order was not sent');
  expect(auth.cancelUnclaimedTicket).toHaveBeenCalledWith('session',ticket.id);
  await expect(trading.confirm('session',ticket.id)).rejects.toThrow('This order was not sent');
  expect(send).not.toHaveBeenCalled();
 });
 it('requires opt-in before a one-tap trade can submit',async()=>{
  const {trading}=mocks();const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quick('session',quickInput)).rejects.toThrow('Enable one-tap');expect(send).not.toHaveBeenCalled();
 });
 it('submits the previewed order once and replays its result even after signing in again',async()=>{
  const {auth,trading}=await storedTickets();
  const {ticket}=await trading.quote('session',quickInput);
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({id:'quick-order',status:'pending'});
  const result=await trading.quick('session',{requestId:quickInput.requestId});
  expect(result).toMatchObject({status:'pending',dryRun:false});
  expect(await trading.quick('new-session',quickInput)).toEqual(result);
  expect(auth.saveTicket).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
   idempotencyKey:ticket.id,clientOrderId:`guardian-native-${ticket.id}`,
   size:ticket.size,stopLossPrice:ticket.stopLossPrice,takeProfitPrice:ticket.takeProfitPrice,
  }));
 });
 it('never sends a second order for concurrent or uncertain requests with the same id',async()=>{
  const {auth,trading}=await storedTickets();
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockRejectedValue(new Error('Timed out'));
  const results=await Promise.allSettled([trading.quick('session',quickInput),trading.quick('session',quickInput)]);
  expect(results.map(result=>result.status)).toEqual(['rejected','rejected']);
  expect(await trading.quick('session',quickInput).catch(error=>error.message)).toBe('This request was already submitted.');
  expect(auth.saveTicket.mock.calls[0]?.[1].id).toBe(auth.saveTicket.mock.calls[1]?.[1].id);
  expect(send).toHaveBeenCalledTimes(1);
 });
 it('blocks a previewed order after one-tap trading is turned off',async()=>{
  const {auth,trading}=await storedTickets();
  await trading.quote('session',quickInput);
  auth.connection.mockResolvedValue({...await auth.connection(),personal_guards:{mode:'off',quickTradeEnabled:false}});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quick('session',{requestId:quickInput.requestId})).rejects.toThrow('Enable one-tap');
  expect(send).not.toHaveBeenCalled();
 });
 it('treats an incomplete order receipt as uncertain and keeps the ticket claimed',async()=>{
  const {auth,trading}=await storedTickets();
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockResolvedValue({status:'pending'});
  await expect(trading.quick('session',quickInput)).rejects.toThrow('The order could not be confirmed.');
  await expect(trading.quick('session',quickInput)).rejects.toThrow('already submitted');
  expect(auth.saveTicketResult).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
 });
 it('blocks quick trades exceeding an enforced personal limit',async()=>{
  const {auth,trading}=mocks();auth.connection.mockResolvedValue({...await auth.connection(),personal_guards:{mode:'enforce',maxRiskUsd:50,quickTradeEnabled:true,quickAmounts:[10,65,100]}});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quick('session',quickInput)).rejects.toThrow('personal trade limit');expect(send).not.toHaveBeenCalled();
 });

});
