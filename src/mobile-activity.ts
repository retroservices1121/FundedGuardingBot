import { randomUUID } from 'node:crypto';
import { MobileAuth } from './mobile-auth.js';
import { MfpClient } from './mfp.js';
import { SecretBox } from './crypto.js';
import type { Config } from './config.js';
export function closeSize(size:number,percent:number,precision:number){
  if(![25,50,75,100].includes(percent)||!Number.isFinite(size)||size<=0)throw new Error('Choose a valid close percentage for an open position.');
  if(percent===100)return undefined;
  const factor=10**precision,value=Math.floor(size*percent/100*factor)/factor;
  if(!Number.isFinite(value)||value<=0)throw new Error('Partial close is below the market precision. Choose Close all.');
  return value;
}
export class MobileActivity {
 constructor(private auth:MobileAuth,private config:Config){}
 private async session(token:string){
  const connection=await this.auth.connection(token);if(!connection)throw new Error('Connect MyFundedPerps from Home first.');
  const hosts={live:'https://developers.myfundedperpetuals.com',sandbox:'https://sandbox.myfundedperpetuals.com'};
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
  if(!position)throw new Error('This position is no longer open on the selected account.');
  const percent=Number(input.percent),markets=await client.listMarkets(),market=markets.find(m=>m.id===position.market_id);
  const size=closeSize(Math.abs(position.size),percent,market?.size_precision??market?.quantity_precision??8);
  const quote=await client.getQuote(position.market_id,position.side==='long'?'sell':'buy',size??Math.abs(position.size));
  if(quote.fillable===false)throw new Error('This close size is not currently fillable.');
  if(!Number.isFinite(quote.mid)||quote.mid<=0)throw new Error('A fresh close price is unavailable.');
  const ticket={id:randomUUID(),accountId:connection.selected_account_id,positionId:position.id,marketId:position.market_id,symbol:position.symbol??position.coin,originalSize:Math.abs(position.size),size,percent,expectedPrice:quote.mid,estimatedFee:quote.estimated_fee,expiresAt:Date.now()+this.config.CONFIRMATION_TTL_SECONDS*1000};
  await this.auth.saveClose(token,ticket);return {ticket,dryRun:this.config.DRY_RUN};
 }
 async confirmClose(token:string,id:string){
  const {connection,client}=await this.session(token);
  if(connection.environment==='live'&&!this.config.ALLOW_LIVE_TRADING)throw new Error('Live account operations are disabled.');
  const ticket=await this.auth.claimClose(token,id);
  if(!ticket)throw new Error('This close quote expired or was already submitted. Refresh positions before trying again.');
  if(ticket.accountId!==connection.selected_account_id)throw new Error('Account changed. Review a new close quote.');
  const positions=await client.listOpenPositions(ticket.accountId),position=positions.find(p=>p.id===ticket.positionId);
  if(!position||Math.abs(position.size)!==ticket.originalSize)throw new Error('Position size changed. Refresh and review a new close quote.');
  const quote=await client.getQuote(position.market_id,position.side==='long'?'sell':'buy',ticket.size??Math.abs(position.size));
  if(quote.fillable===false||!Number.isFinite(quote.mid)||quote.mid<=0)throw new Error('A fillable close quote is unavailable.');
  if(Date.now()>=ticket.expiresAt)throw new Error('Close quote expired. Review again.');
  if(this.config.DRY_RUN)return {dryRun:true,status:'validated'};
  try{const result=await client.closePosition(position.id,ticket.size,quote.mid,ticket.id);return {dryRun:false,status:String(result.status??'pending')};}
  catch(e){throw new Error(`${e instanceof Error?e.message:'Close response unavailable.'} Check MyFundedPerps before attempting another close.`);}
 }
}
