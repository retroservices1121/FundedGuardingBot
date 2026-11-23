import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSize, MobileActivity } from '../src/mobile-activity.js';
import { MfpClient, MfpTransportError } from '../src/mfp.js';
import { SecretBox } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
const config=loadConfig({TELEGRAM_BOT_TOKEN:'test',DATABASE_URL:'postgres://localhost/test',ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),ALLOW_LIVE_TRADING:'true',DRY_RUN:'false'});
afterEach(()=>vi.restoreAllMocks());
function setup(){
 const position={id:'p',account_id:'a',market_id:'binance|EUR',side:'long',size:346494.3,symbol:'EUR'};
 const auth={connection:vi.fn().mockResolvedValue({environment:'live',selected_account_id:'a',encrypted_api_key:new SecretBox(config.ENCRYPTION_KEY).encrypt('fp_live_test')}),saveClose:vi.fn(),claimClose:vi.fn(),closeTicketResult:vi.fn(),saveCloseResult:vi.fn(),cancelUnclaimedTicket:vi.fn()};
 vi.spyOn(MfpClient.prototype,'listOpenPositions').mockResolvedValue([position as never]);
 vi.spyOn(MfpClient.prototype,'listMarkets').mockResolvedValue([{id:'binance|EUR',size_precision:1}]);
 vi.spyOn(MfpClient.prototype,'getQuote').mockResolvedValue({mid:1.16,bid:1.15,ask:1.16,estimated_fee:10});
 const close=vi.spyOn(MfpClient.prototype,'closePosition').mockResolvedValue({id:'close-order',status:'pending'});
 return {position,auth,close,activity:new MobileActivity(auth as never,config)};
}
describe('native position closing',()=>{
 it('rounds partial closes down and omits full-close size',()=>{
  const market={id:'a',size_step:0.25};
  expect(closeSize(10.123,25,market)).toBe(2.5);expect(closeSize(10.123,100)).toBeUndefined();
  expect(()=>closeSize(0.001,25,market)).toThrow('too small');expect(()=>closeSize(10,20,market)).toThrow();
 });
 it('rejects position IDs outside the selected account',async()=>{
  const {activity,close}=setup();await expect(activity.quoteClose('session',{positionId:'other',percent:100})).rejects.toThrow('selected account');expect(close).not.toHaveBeenCalled();
 });
 it('sends a fresh expected price and stable key on a full close',async()=>{
  const {activity,auth,close}=setup();const {ticket}=await activity.quoteClose('session',{positionId:'p',percent:100});auth.claimClose.mockResolvedValue(ticket);
  expect(await activity.confirmClose('session',ticket.id)).toMatchObject({status:'pending'});
  expect(close).toHaveBeenCalledWith('p',undefined,1.16,ticket.id);
  expect(MfpClient.prototype.listMarkets).not.toHaveBeenCalled();
 });
 it('allows a step-rounded partial close when the market is closed to new orders',async()=>{
  const {position,activity,auth,close}=setup();
  vi.mocked(MfpClient.prototype.listMarkets).mockResolvedValue([{id:position.market_id,size_step:0.25,trading_enabled:false}]);
  const {ticket}=await activity.quoteClose('session',{positionId:'p',percent:25});
  expect(ticket.size).toBe(86_623.5);
  auth.claimClose.mockResolvedValue(ticket);
  await activity.confirmClose('session',ticket.id);
  expect(close).toHaveBeenCalledExactlyOnceWith('p',86_623.5,1.16,ticket.id);
 });
 it('does not close when size changes after review',async()=>{
  const {activity,auth,close}=setup();auth.claimClose.mockResolvedValue({accountId:'a',positionId:'p',originalSize:1,expiresAt:Date.now()+10000});
  await expect(activity.confirmClose('session','ticket')).rejects.toThrow('Position size changed');expect(close).not.toHaveBeenCalled();
 });
 it('refuses already claimed or expired close tickets',async()=>{
  const {activity,auth,close}=setup();auth.claimClose.mockResolvedValue(undefined);
  await expect(activity.confirmClose('session','ticket')).rejects.toThrow('Close quote expired');expect(close).not.toHaveBeenCalled();
 });
 it('checks an uncertain close after position data changes without sending another close',async()=>{
  const {activity,auth,close}=setup();
  const {ticket}=await activity.quoteClose('session',{positionId:'p',percent:25});
  auth.claimClose.mockResolvedValueOnce(ticket);
  auth.closeTicketResult.mockResolvedValue({payload:ticket,submitted_at:new Date()});
  close.mockRejectedValue(new MfpTransportError(true));
  const lookup=vi.spyOn(MfpClient.prototype,'findOrderByClientOrderId').mockResolvedValueOnce(undefined)
   .mockResolvedValueOnce({id:'close-order',status:'filled'});
  await expect(activity.confirmClose('session',ticket.id)).rejects.toThrow('too long');
  expect(auth.saveCloseResult).not.toHaveBeenCalled();
  vi.mocked(MfpClient.prototype.listOpenPositions).mockResolvedValue([]);
  const result={dryRun:false,status:'filled',orderId:'close-order'};
  await expect(activity.confirmClose('new-session',ticket.id,true)).resolves.toEqual(result);
  expect(lookup).toHaveBeenLastCalledWith(`guardian-close-${ticket.id}`,ticket.accountId);
  expect(auth.saveCloseResult).toHaveBeenCalledWith(ticket.id,result);
  auth.closeTicketResult.mockResolvedValue({payload:ticket,submitted_at:new Date(),result});
  await expect(activity.confirmClose('new-session',ticket.id)).resolves.toEqual(result);
  expect(close).toHaveBeenCalledTimes(1);
 });
});
