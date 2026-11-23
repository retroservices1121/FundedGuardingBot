import { MobileValidationError, MobileWriteUncertainError } from './mobile-errors.js';
import { createClosedPositionShareCard } from "./share-card.js";
import type { Market, Position } from "./types.js";
import { randomUUID } from 'node:crypto';
import { MobileAuth } from './mobile-auth.js';
import { closeClientOrderId, MfpClient, MfpError, positionExitOrders } from './mfp.js';
import { SecretBox } from './crypto.js';
import type { Config } from './config.js';
import { mobileOrderHosts as hosts, orderRequestRejected, submitOrder } from './mobile-order.js';
import { mobileWriteSignal } from './mobile-write-deadline.js';
import { roundMarketSize } from './risk.js';
export function closeSize(size:number,percent:number,market?:Market){
  if(![25,50,75,100].includes(percent)||!Number.isFinite(size)||size<=0)throw new MobileValidationError('Choose a valid close percentage for an open position.');
  if(percent===100)return undefined;
  const value=roundMarketSize(size*percent/100,market);
  if(value===undefined)throw new MobileValidationError('We could not check the allowed size for a partial close. Choose Close all.');
  if(value<=0)throw new MobileValidationError('This partial close is too small. Choose Close all.');
  return value;
}
export class MobileActivity {
 constructor(private auth:MobileAuth,private config:Config){}
 private async session(token:string){
  const connection=await this.auth.connection(token);if(!connection)throw new MobileValidationError('Connect MyFundedPerps from Home first.');
  const client=new MfpClient(hosts[connection.environment as keyof typeof hosts],new SecretBox(this.config.ENCRYPTION_KEY).decrypt(connection.encrypted_api_key));
  return {connection,client};
 }
 async list(token:string){
  const {connection,client}=await this.session(token);
  const [open,closed]=await Promise.all([client.listOpenPositions(connection.selected_account_id),client.listClosedPositions(connection.selected_account_id,50)]);
  const quotes=new Map<string,{price:number;fee?:number}>();
  await Promise.all(open.slice(0,10).map(async p=>{try{const q=await client.getQuote(p.market_id,p.side==='long'?'sell':'buy',Math.abs(p.size));if(Number.isFinite(q.mid)&&q.mid>0)quotes.set(p.id,{price:q.mid,fee:q.estimated_fee});}catch{/* Show positions even when a quote is unavailable. */}}));
  return {accountId:connection.selected_account_id,open:open.map(p=>({...p,markPrice:quotes.get(p.id)?.price,estimatedCloseFee:quotes.get(p.id)?.fee,estimatedUnrealizedPnl:quotes.has(p.id)?(quotes.get(p.id)!.price-p.entry_price)*Math.abs(p.size)*(p.side==='long'?1:-1):undefined})),closed,updatedAt:new Date().toISOString(),refreshSeconds:this.config.MINI_APP_REFRESH_SECONDS};
 }
 async quoteClose(token:string,input:Record<string,unknown>){
  const {connection,client}=await this.session(token);
  const positions=await client.listOpenPositions(connection.selected_account_id);
  const position=positions.find(p=>p.id===input.positionId);
  if(!position)throw new MobileValidationError('This position is no longer open on the selected account.');
  const percent=Number(input.percent);
  const market=percent===100?undefined:(await client.listMarkets()).find(m=>m.id===position.market_id);
  const size=closeSize(Math.abs(position.size),percent,market);
  const quote=await client.getQuote(position.market_id,position.side==='long'?'sell':'buy',size??Math.abs(position.size));
  if(quote.fillable===false)throw new MobileValidationError('This close size is not currently fillable.');
  if(!Number.isFinite(quote.mid)||quote.mid<=0)throw new MobileValidationError('A fresh close price is unavailable.');
  const ticket={id:randomUUID(),accountId:connection.selected_account_id,environment:connection.environment,positionId:position.id,marketId:position.market_id,symbol:position.symbol??position.coin,originalSize:Math.abs(position.size),size,percent,expectedPrice:quote.mid,estimatedFee:quote.estimated_fee,expiresAt:Date.now()+this.config.CONFIRMATION_TTL_SECONDS*1000};
  await this.auth.saveClose(token,ticket);return {ticket,dryRun:this.config.DRY_RUN};
 }
 async confirmClose(token:string,id:string,checkOnly=false){
  if(checkOnly)await this.auth.cancelUnclaimedTicket(token,id,true);
  const ticket=checkOnly ? undefined : await this.auth.claimClose(token,id);
  if(!ticket){
   const previous=await this.auth.closeTicketResult(token,id);
   if(previous?.payload.kind==='protection')throw new MobileValidationError('This is not a close quote.');
   if(previous?.result?.status==='not_submitted')throw new MobileValidationError('This close was not sent. Review a new close quote.');
   if(previous?.result)return previous.result;
   if(previous?.submitted_at){
    const result=await this.auth.reconcileTicket(token,id,true);
    if(result?.status==='not_submitted')throw new MobileValidationError('This close was not sent. Review a new close quote.');
    if(result)return result;
    throw new MobileWriteUncertainError('This close was already submitted.');
   }
   throw new MobileValidationError('Close quote expired. Review a new close quote.');
  }
  if(ticket.kind==='protection')throw new MobileValidationError('This is not a close quote.');
  let submitted=false;
  try{
   const {connection,client}=await this.session(token);
   if(connection.environment==='live'&&!this.config.ALLOW_LIVE_TRADING)throw new MobileValidationError('Live account operations are disabled.');
   if(ticket.accountId!==connection.selected_account_id||(ticket.environment&&connection.environment!==ticket.environment))throw new MobileValidationError('Account changed. Review a new close quote.');
   const positions=await client.listOpenPositions(ticket.accountId),position=positions.find(p=>p.id===ticket.positionId);
   if(!position||Math.abs(position.size)!==ticket.originalSize)throw new MobileValidationError('Position size changed. Refresh and review a new close quote.');
   const quote=await client.getQuote(position.market_id,position.side==='long'?'sell':'buy',ticket.size??Math.abs(position.size));
   if(quote.fillable===false||!Number.isFinite(quote.mid)||quote.mid<=0)throw new MobileValidationError('A fillable close quote is unavailable.');
   if(Date.now()>=ticket.expiresAt)throw new MobileValidationError('Close quote expired. Review again.');
   if(this.config.DRY_RUN){const result={dryRun:true,status:'validated'};await this.auth.saveCloseResult(id,result);return result;}
   return await this.auth.withTicketWrite(id,true,connection.environment,async locked=>{
    mobileWriteSignal()?.throwIfAborted();
    if(Date.now()>=ticket.expiresAt)throw new MobileValidationError('Close quote expired. Review again.');
    submitted=true;
    const result=await submitOrder(client,closeClientOrderId(ticket.id),ticket.accountId,()=>client.closePosition(position.id,ticket.size,quote.mid,ticket.id));
    await this.auth.saveCloseResult(id,result,locked);return result;
   });
  }catch(error){
   if(!submitted||orderRequestRejected(error))await this.auth.saveCloseResult(id,{status:'not_submitted'});
   if(submitted&&error instanceof MfpError&&error.status===429)throw new MobileValidationError('MyFundedPerps is receiving too many requests. This close was not sent. Try again shortly.');
   throw error;
  }
 }
 async share(token:string,positionId:string){
  const {connection,client}=await this.session(token);
  const position=(await client.listClosedPositions(connection.selected_account_id,50)).find(p=>p.id===positionId);
  if(!position)throw new MobileValidationError('Closed position unavailable on the selected account.');
  if(typeof position.realized_pnl!=='number'||!Number.isFinite(position.realized_pnl))throw new MobileValidationError('Realized P&L is unavailable. Refresh before sharing.');
  const image=await createClosedPositionShareCard(position);
  return {imageBase64:image.toString('base64')};
 }
 async protection(token:string,positionId:string){
  const {connection,client}=await this.session(token);
  const [positions,orders]=await Promise.all([client.listOpenPositions(connection.selected_account_id),client.listWorkingOrders(connection.selected_account_id)]);
  const position=positions.find(p=>p.id===positionId);if(!position)throw new MobileValidationError('Position is no longer open on this account.');
  const quote=await client.getQuote(position.market_id);
  return {position,markPrice:quote.mid,orders:positionExitOrders(orders,position)};
 }
 async quoteProtection(token:string,input:Record<string,unknown>){
  const {connection,client}=await this.session(token);
  const position=(await client.listOpenPositions(connection.selected_account_id)).find(p=>p.id===input.positionId);
  if(!position)throw new MobileValidationError('Position is no longer open on this account.');
  const orders=await client.listWorkingOrders(connection.selected_account_id);
  const expectedOrders=exitSnapshot(positionExitOrders(orders,position));
  const takeProfitPrice=Number(input.takeProfitPrice),stopLossPrice=Number(input.stopLossPrice);
  const quote=await client.getQuote(position.market_id);
  validateProtection(position,quote.mid,takeProfitPrice,stopLossPrice);
  const ticket={id:randomUUID(),kind:'protection' as const,expectedOrders,accountId:connection.selected_account_id,environment:connection.environment,positionId:position.id,originalSize:position.size,takeProfitPrice,stopLossPrice,expiresAt:Date.now()+this.config.CONFIRMATION_TTL_SECONDS*1000};
  await this.auth.saveClose(token,ticket);return {ticket,dryRun:this.config.DRY_RUN};
 }
 async confirmProtection(token:string,id:string){
  const previous=await this.auth.closeTicketResult(token,id);
  const savedResult=(record:typeof previous)=>{
   if(!record)throw new MobileValidationError('Edit quote expired. Review again.');
   if(record.payload.kind!=='protection')throw new MobileValidationError('This is not an exit edit quote.');
   if(record.result?.status==='not_submitted')throw new MobileValidationError('This edit was not sent. Review a new edit quote.');
   if(record.result)return record.result;
   if(record.submitted_at)throw new MobileWriteUncertainError('This edit was already submitted.');
  };
  const saved=savedResult(previous);
  if(saved)return saved;
  const ticket=previous.payload;
  if(Date.now()>=ticket.expiresAt)throw new MobileValidationError('Edit quote expired. Review again.');
  const {connection,client}=await this.session(token);
  if(connection.environment==='live'&&!this.config.ALLOW_LIVE_TRADING)throw new MobileValidationError('Live account operations are disabled.');
  if(ticket.accountId!==connection.selected_account_id||(ticket.environment&&connection.environment!==ticket.environment))throw new MobileValidationError('Account changed. Review again.');
  const [positions,orders]=await Promise.all([client.listOpenPositions(ticket.accountId),client.listWorkingOrders(ticket.accountId)]);
  const position=positions.find(p=>p.id===ticket.positionId);
  if(!position||position.size!==ticket.originalSize)throw new MobileValidationError('Position size changed. Review again.');
  if(JSON.stringify(exitSnapshot(positionExitOrders(orders,position)))!==JSON.stringify(ticket.expectedOrders))throw new MobileValidationError('Working exits changed. Refresh and review again.');
  const quote=await client.getQuote(position.market_id);
  validateProtection(position,quote.mid,ticket.takeProfitPrice,ticket.stopLossPrice);
  mobileWriteSignal()?.throwIfAborted();
  if(!await this.auth.claimClose(token,id,true)){
   const result=savedResult(await this.auth.closeTicketResult(token,id));
   if(result)return result;
   throw new MobileValidationError('Edit quote expired. Review again.');
  }
  let submitted=false;
  try{
   mobileWriteSignal()?.throwIfAborted();
   if(Date.now()>=ticket.expiresAt)throw new MobileValidationError('Edit quote expired. Review again.');
   let result={dryRun:true,status:'validated'};
   if(!this.config.DRY_RUN){
    submitted=true;
    const response=await client.replacePositionExits(position,orders,ticket.takeProfitPrice,ticket.stopLossPrice,ticket.id);
    result={dryRun:false,status:String(response.status??'submitted')};
   }
   await this.auth.saveCloseResult(id,result);
   return result;
  }catch(error){
   if(!submitted||orderRequestRejected(error))await this.auth.saveCloseResult(id,{status:'not_submitted'});
   if(submitted&&error instanceof MfpError&&error.status===429)throw new MobileValidationError('MyFundedPerps is receiving too many requests. This edit was not sent. Try again shortly.');
   throw error;
  }
 }

}

export function validateProtection(position:Pick<Position,'side'>,reference:number,tp:number,sl:number){
 if(![reference,tp,sl].every(v=>Number.isFinite(v)&&v>0))throw new MobileValidationError('Enter positive TP and SL prices. A fresh market price is required.');
 if(position.side==='long'?!(tp>reference&&sl<reference):!(tp<reference&&sl>reference))throw new MobileValidationError('TP and SL must be on opposite sides of the current market price for this direction.');
}

function exitSnapshot(orders:import('./types.js').WorkingOrder[]){return orders.map(o=>({id:o.id,size:o.size,price:o.trigger_price??o.limit_price??o.price})).sort((a,b)=>a.id.localeCompare(b.id));}
