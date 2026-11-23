import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileTrading, tradeInput } from '../src/mobile-trading.js';
import { MfpClient } from '../src/mfp.js';
import { SecretBox } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
import type { TradeTicket } from '../src/types.js';
const config=loadConfig({TELEGRAM_BOT_TOKEN:'test',DATABASE_URL:'postgres://localhost/test',ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),ALLOW_LIVE_TRADING:'true',DRY_RUN:'false'});
const input={marketId:'binance|BTCUSDT',side:'buy',riskUsd:65,leverage:5,stopPercent:1,rewardRisk:2};
const quickInput={...input,requestId:'quick-test-request-id-01'};
afterEach(()=>vi.restoreAllMocks());
function mocks(){
 const auth={user:vi.fn().mockResolvedValue({id:'user-a'}),connection:vi.fn().mockResolvedValue({environment:'live',encrypted_api_key:new SecretBox(config.ENCRYPTION_KEY).encrypt('fp_live_test'),selected_account_id:'account-a'}),saveTicket:vi.fn(),claimTicket:vi.fn(),ticketResult:vi.fn(),saveTicketResult:vi.fn()};
 vi.spyOn(MfpClient.prototype,'getAccount').mockResolvedValue({id:'account-a',status:'active'});
 vi.spyOn(MfpClient.prototype,'getTradingPolicy').mockResolvedValue({});
 vi.spyOn(MfpClient.prototype,'listMarkets').mockResolvedValue([{id:'binance|BTCUSDT',symbol:'BTC',size_precision:3}]);
 vi.spyOn(MfpClient.prototype,'listOpenPositions').mockResolvedValue([]);
 vi.spyOn(MfpClient.prototype,'getQuote').mockResolvedValue({bid:100,ask:101,mid:100,estimated_fill_price:101,estimated_fee:1});
 return {auth,trading:new MobileTrading(auth as never,config)};
}
async function quickMocks(){
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
  if(!record||record.submitted_at||record.payload.expiresAt<=Date.now())return;
  record.submitted_at=new Date();
  return record.payload;
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
 it('does not submit twice when a quote has already been claimed',async()=>{
  const {auth,trading}=mocks();auth.claimTicket.mockResolvedValue(undefined);auth.ticketResult.mockResolvedValue({submitted_at:new Date()});
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
 });
 it('requires opt-in before a one-tap trade can submit',async()=>{
  const {trading}=mocks();const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quick('session',quickInput)).rejects.toThrow('Enable one-tap');expect(send).not.toHaveBeenCalled();
 });
 it('submits the previewed order once and replays its result even after signing in again',async()=>{
  const {auth,trading}=await quickMocks();
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
  const {auth,trading}=await quickMocks();
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder').mockRejectedValue(new Error('Timed out'));
  const results=await Promise.allSettled([trading.quick('session',quickInput),trading.quick('session',quickInput)]);
  expect(results.map(result=>result.status)).toEqual(['rejected','rejected']);
  expect(await trading.quick('session',quickInput).catch(error=>error.message)).toBe('This request was already submitted.');
  expect(auth.saveTicket.mock.calls[0]?.[1].id).toBe(auth.saveTicket.mock.calls[1]?.[1].id);
  expect(send).toHaveBeenCalledTimes(1);
 });
 it('blocks a previewed order after one-tap trading is turned off',async()=>{
  const {auth,trading}=await quickMocks();
  await trading.quote('session',quickInput);
  auth.connection.mockResolvedValue({...await auth.connection(),personal_guards:{mode:'off',quickTradeEnabled:false}});
  const send=vi.spyOn(MfpClient.prototype,'placeProtectedMarketOrder');
  await expect(trading.quick('session',{requestId:quickInput.requestId})).rejects.toThrow('Enable one-tap');
  expect(send).not.toHaveBeenCalled();
 });
 it('treats an incomplete order receipt as uncertain and keeps the ticket claimed',async()=>{
  const {auth,trading}=await quickMocks();
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
