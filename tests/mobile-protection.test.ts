import {afterEach,describe,it,expect,vi} from 'vitest';
import {MobileActivity,validateProtection} from '../src/mobile-activity.js';
import {MfpClient,MfpError,MfpTransportError} from '../src/mfp.js';
import {SecretBox} from '../src/crypto.js';
import {loadConfig} from '../src/config.js';
const config=loadConfig({TELEGRAM_BOT_TOKEN:'test',DATABASE_URL:'postgres://localhost/test',ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),ALLOW_LIVE_TRADING:'true',DRY_RUN:'false'});
afterEach(()=>vi.restoreAllMocks());
function setup(){
 const auth={
  connection:vi.fn().mockResolvedValue({environment:'live',selected_account_id:'a',encrypted_api_key:new SecretBox(config.ENCRYPTION_KEY).encrypt('key')}),
  saveClose:vi.fn(),claimClose:vi.fn(),closeTicketResult:vi.fn(),saveCloseResult:vi.fn(),
 };
 const position={id:'p',size:2,market_id:'m',side:'long',entry_price:100};
 vi.spyOn(MfpClient.prototype,'listOpenPositions').mockResolvedValue([position as never]);
 vi.spyOn(MfpClient.prototype,'listWorkingOrders').mockResolvedValue([]);
 vi.spyOn(MfpClient.prototype,'getQuote').mockResolvedValue({mid:110,bid:109,ask:111});
 const send=vi.spyOn(MfpClient.prototype,'replacePositionExits').mockResolvedValue({status:'pending'});
 return {auth,send,activity:new MobileActivity(auth as never,config)};
}
const edit={positionId:'p',takeProfitPrice:120,stopLossPrice:105};
describe('native protection',()=>{
 it('allows profitable stops relative to the current price',()=>{expect(()=>validateProtection({side:'long'},110,120,105)).not.toThrow();expect(()=>validateProtection({side:'short'},90,80,95)).not.toThrow();expect(()=>validateProtection({side:'long'},110,100,105)).toThrow();});
 it('rejects another account position',async()=>{const {activity}=setup();await expect(activity.quoteProtection('s',{positionId:'other',takeProfitPrice:120,stopLossPrice:105})).rejects.toThrow('no longer open');});
 it('claims after validation and returns the saved result on a repeated confirm',async()=>{
  const {auth,activity,send}=setup();
  const {ticket}=await activity.quoteProtection('s',edit);
  const getQuote=vi.mocked(MfpClient.prototype.getQuote);
  getQuote.mockClear();
  auth.closeTicketResult.mockResolvedValue({payload:ticket});
  auth.claimClose.mockResolvedValue(ticket);
  const result=await activity.confirmProtection('s',ticket.id);
  expect(getQuote).toHaveBeenCalledBefore(auth.claimClose);
  expect(auth.claimClose).toHaveBeenCalledBefore(send);
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.anything(),[],120,105,ticket.id);
  expect(auth.saveCloseResult).toHaveBeenCalledExactlyOnceWith(ticket.id,{dryRun:false,status:'pending'});
  auth.closeTicketResult.mockResolvedValue({payload:ticket,submitted_at:new Date(),result});
  await expect(activity.confirmProtection('s',ticket.id)).resolves.toEqual(result);
  expect(auth.claimClose).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
 });
 it('rejects changed exits before claiming and refuses an edit ticket on the close path',async()=>{
  const {auth,activity,send}=setup();
  const {ticket}=await activity.quoteProtection('s',edit);
  auth.closeTicketResult.mockResolvedValue({payload:ticket});
  vi.mocked(MfpClient.prototype.listWorkingOrders).mockResolvedValue([{id:'o',reduce_only:true,position_id:'p',group:'tp',size:2,price:125} as never]);
  await expect(activity.confirmProtection('s',ticket.id)).rejects.toThrow('exits changed');
  expect(auth.claimClose).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await expect(activity.confirmClose('s',ticket.id)).rejects.toThrow('not a close');
 });
 it('does not send if another confirm claims the edit during validation',async()=>{
  const {auth,activity,send}=setup();
  const {ticket}=await activity.quoteProtection('s',edit);
  auth.closeTicketResult.mockResolvedValueOnce({payload:ticket}).mockResolvedValue({payload:ticket,submitted_at:new Date()});
  await expect(activity.confirmProtection('s',ticket.id)).rejects.toThrow('already submitted');
  expect(send).not.toHaveBeenCalled();
 });
 it('records a definitely refused edit as not submitted',async()=>{
  const {auth,activity,send}=setup();
  const {ticket}=await activity.quoteProtection('s',edit);
  auth.closeTicketResult.mockResolvedValue({payload:ticket});
  auth.claimClose.mockResolvedValue(ticket);
  send.mockRejectedValue(new MfpError('Rate limit',429));
  await expect(activity.confirmProtection('s',ticket.id)).rejects.toThrow('This edit was not sent');
  expect(auth.saveCloseResult).toHaveBeenCalledExactlyOnceWith(ticket.id,{status:'not_submitted'});
  auth.closeTicketResult.mockResolvedValue({payload:ticket,submitted_at:new Date(),result:{status:'not_submitted'}});
  await expect(activity.confirmProtection('s',ticket.id)).rejects.toThrow('This edit was not sent');
  expect(send).toHaveBeenCalledTimes(1);
 });
 it('keeps an edit uncertain after a transport failure',async()=>{
  const {auth,activity,send}=setup();
  const {ticket}=await activity.quoteProtection('s',edit);
  auth.closeTicketResult.mockResolvedValue({payload:ticket});
  auth.claimClose.mockResolvedValue(ticket);
  send.mockRejectedValue(new MfpTransportError(true));
  await expect(activity.confirmProtection('s',ticket.id)).rejects.toThrow('too long');
  expect(auth.saveCloseResult).not.toHaveBeenCalled();
 });
 it('does not share positions outside the selected account or invent P&L',async()=>{const {activity}=setup();vi.spyOn(MfpClient.prototype,'listClosedPositions').mockResolvedValue([{id:'p'} as never]);await expect(activity.share('s','other')).rejects.toThrow('unavailable');await expect(activity.share('s','p')).rejects.toThrow('P&L is unavailable');});
});
