import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileTrading, tradeInput } from '../src/mobile-trading.js';
import { MfpClient } from '../src/mfp.js';
import { SecretBox } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
const config=loadConfig({TELEGRAM_BOT_TOKEN:'test',DATABASE_URL:'postgres://localhost/test',ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),ALLOW_LIVE_TRADING:'true',DRY_RUN:'false'});
const input={marketId:'binance|BTCUSDT',side:'buy',riskUsd:65,leverage:5,stopPercent:1,rewardRisk:2};
afterEach(()=>vi.restoreAllMocks());
function mocks(){
 const auth={connection:vi.fn().mockResolvedValue({environment:'live',encrypted_api_key:new SecretBox(config.ENCRYPTION_KEY).encrypt('fp_live_test'),selected_account_id:'account-a'}),saveTicket:vi.fn(),claimTicket:vi.fn(),ticketResult:vi.fn(),saveTicketResult:vi.fn()};
 vi.spyOn(MfpClient.prototype,'getAccount').mockResolvedValue({id:'account-a',status:'active'});
 vi.spyOn(MfpClient.prototype,'getTradingPolicy').mockResolvedValue({});
 vi.spyOn(MfpClient.prototype,'listMarkets').mockResolvedValue([{id:'binance|BTCUSDT',symbol:'BTC',size_precision:3}]);
 vi.spyOn(MfpClient.prototype,'listOpenPositions').mockResolvedValue([]);
 vi.spyOn(MfpClient.prototype,'getQuote').mockResolvedValue({bid:100,ask:101,mid:100,estimated_fill_price:101,estimated_fee:1});
 return {auth,trading:new MobileTrading(auth as never,config)};
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
});
