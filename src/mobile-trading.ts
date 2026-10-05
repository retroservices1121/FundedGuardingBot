import { guardWarnings } from "./mobile-guards.js";
import type { Side } from './types.js';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { MobileAuth } from './mobile-auth.js';
import { MfpClient, isActiveAccount } from './mfp.js';
import { SecretBox } from './crypto.js';
import { buildTicket, calculateSize, platformRuleCheck } from './risk.js';

const hosts={live:'https://developers.myfundedperpetuals.com',sandbox:'https://sandbox.myfundedperpetuals.com'};
export function tradeInput(input: Record<string,unknown>) {
  const riskUsd=Number(input.riskUsd),leverage=Number(input.leverage),stopPercent=Number(input.stopPercent),rewardRisk=Number(input.rewardRisk);
  if(typeof input.marketId!=='string'||!input.marketId||(input.side!=='buy'&&input.side!=='sell'))throw new Error('Choose a market and direction.');
  if(!Number.isFinite(riskUsd)||riskUsd<=0)throw new Error('Enter a positive risk amount.');
  if(!Number.isInteger(leverage)||leverage<1||leverage>100)throw new Error('Enter leverage from 1x to 100x.');
  if(!Number.isFinite(stopPercent)||stopPercent<=0||stopPercent>=100)throw new Error('Stop distance must be above 0% and below 100%.');
  if(!Number.isFinite(rewardRisk)||rewardRisk<=0||rewardRisk>100)throw new Error('Enter a positive reward/risk ratio up to 100.');
  return {marketId:input.marketId,side:input.side as Side,riskUsd,leverage,stopPercent,rewardRisk};
}
export class MobileTrading {
  constructor(private auth:MobileAuth,private config:Config){}
  private async connection(token:string){
    const connection=await this.auth.connection(token);
    if(!connection)throw new Error('Connect MyFundedPerps from Home first.');
    if(connection.environment==='live'&&!this.config.ALLOW_LIVE_TRADING)throw new Error('Live trading is not enabled.');
    const client=new MfpClient(hosts[connection.environment as keyof typeof hosts],new SecretBox(this.config.ENCRYPTION_KEY).decrypt(connection.encrypted_api_key));
    return {connection,client};
  }
  async quote(token:string,input:Record<string,unknown>){
    const values=tradeInput(input),{connection,client}=await this.connection(token);
    const [account,policy,markets,positions]=await Promise.all([client.getAccount(connection.selected_account_id),client.getTradingPolicy(connection.selected_account_id),client.listMarkets(),client.listOpenPositions(connection.selected_account_id)]);
    if(!isActiveAccount(account))throw new Error('Select an active account from Home.');
    const market=markets.find(m=>m.id===values.marketId&&m.available!==false);
    if(!market)throw new Error('This market is currently unavailable.');
    const first=await client.getQuote(market.id);
    if(!Number.isFinite(first.mid)||first.mid<=0)throw new Error('A valid market price is unavailable.');
    const size=calculateSize(values.riskUsd,first.mid,values.stopPercent,market.size_precision??market.quantity_precision??6);
    const quote=await client.getQuote(market.id,values.side,size);
    if(quote.fillable===false)throw new Error('This size is not fillable at the market precision.');
    const ticket=buildTicket({id:randomUUID(),userId:0,accountId:account.id,market,symbol:String(market.symbol??market.id.split('|').at(-1)),...values,quote,ttlSeconds:this.config.CONFIRMATION_TTL_SECONDS});
    // Preserve the exact size used for MFP's size-aware quote.
    ticket.size = size;
    const direction = values.side === 'buy' ? 1 : -1;
    const distance = values.riskUsd / size;
    ticket.stopLossPrice = ticket.expectedPrice - direction * distance;
    ticket.takeProfitPrice = ticket.expectedPrice + direction * distance * values.rewardRisk;
    ticket.estimatedNotional = quote.estimated_notional ?? size * ticket.expectedPrice;
    ticket.platformRules=platformRuleCheck({account,policy,market,ticket,openPositions:positions});
    if(ticket.size<=0||!Number.isFinite(ticket.size)||!Number.isFinite(ticket.expectedPrice)||ticket.stopLossPrice<=0||ticket.takeProfitPrice<=0)throw new Error('These inputs produce invalid prices or size.');
    ticket.platformRules.warnings.push(...guardWarnings(connection.personal_guards,account,ticket.riskUsd));
    await this.auth.saveTicket(token,ticket);
    return {ticket,dryRun:this.config.DRY_RUN,accountName:account.name??account.id};
  }
  async confirm(token:string,id:string){
    const {connection,client}=await this.connection(token);
    const ticket=await this.auth.claimTicket(token,id);
    if(!ticket){const previous=await this.auth.ticketResult(token,id);if(previous?.result)return previous.result;throw new Error(previous?.submitted_at?'This request was already submitted. Check MyFundedPerps before placing another order.':'Quote expired. Review a new quote.');}
    let submitted=false;
    try{
      if(connection.selected_account_id!==ticket.accountId)throw new Error('Selected account changed. Review a new quote.');
      const [account,policy,markets,positions]=await Promise.all([client.getAccount(ticket.accountId),client.getTradingPolicy(ticket.accountId),client.listMarkets(),client.listOpenPositions(ticket.accountId)]);
      if(!isActiveAccount(account))throw new Error('The account is no longer active.');
      const market=markets.find(m=>m.id===ticket.marketId&&m.available!==false);
      if(!market)throw new Error('The market is no longer available.');
      guardWarnings(connection.personal_guards,account,ticket.riskUsd);
      const check=platformRuleCheck({account,policy,market,ticket,openPositions:positions});
      if(check.problems.length)throw new Error(check.problems.join(' '));
      if(this.config.DRY_RUN){const result={dryRun:true,status:'validated'};await this.auth.saveTicketResult(id,result);return result;}
      if (Date.now() >= ticket.expiresAt) throw new Error('Quote expired. Review a new quote.');
      submitted=true;
      const order=await client.placeProtectedMarketOrder({accountId:ticket.accountId,marketId:ticket.marketId,side:ticket.side,size:ticket.size,expectedPrice:ticket.expectedPrice,leverage:ticket.leverage,stopLossPrice:ticket.stopLossPrice,takeProfitPrice:ticket.takeProfitPrice,clientOrderId:`guardian-native-${ticket.id}`,idempotencyKey:ticket.id});
      const result={dryRun:false,status:String(order.status??'pending'),orderId:order.id};
      await this.auth.saveTicketResult(id,result);return result;
    }catch(e){
      const message=e instanceof Error?e.message:'Order submission failed.';
      if(!submitted)await this.auth.saveTicketResult(id,{status:'not_submitted',error:message});
      throw new Error(submitted?`${message} Check MyFundedPerps for this order before placing another trade.`:message);
    }
  }
}
