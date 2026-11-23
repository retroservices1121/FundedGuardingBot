import { MobileValidationError, MobileWriteUncertainError } from './mobile-errors.js';
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
  if(typeof input.marketId!=='string'||!input.marketId||(input.side!=='buy'&&input.side!=='sell'))throw new MobileValidationError('Choose a market and direction.');
  if(!Number.isFinite(riskUsd)||riskUsd<=0)throw new MobileValidationError('Enter a positive risk amount.');
  if(!Number.isInteger(leverage)||leverage<1||leverage>100)throw new MobileValidationError('Enter leverage from 1x to 100x.');
  if(!Number.isFinite(stopPercent)||stopPercent<=0||stopPercent>=100)throw new MobileValidationError('Stop distance must be above 0% and below 100%.');
  if(!Number.isFinite(rewardRisk)||rewardRisk<=0||rewardRisk>100)throw new MobileValidationError('Enter a positive reward/risk ratio up to 100.');
  return {marketId:input.marketId,side:input.side as Side,riskUsd,leverage,stopPercent,rewardRisk};
}
export class MobileTrading {
  constructor(private auth:MobileAuth,private config:Config){}
  private async connection(token:string){
    const connection=await this.auth.connection(token);
    if(!connection)throw new MobileValidationError('Connect MyFundedPerps from Home first.');
    if(connection.environment==='live'&&!this.config.ALLOW_LIVE_TRADING)throw new MobileValidationError('Live trading is not enabled.');
    const client=new MfpClient(hosts[connection.environment as keyof typeof hosts],new SecretBox(this.config.ENCRYPTION_KEY).decrypt(connection.encrypted_api_key));
    return {connection,client};
  }
  async quote(token:string,input:Record<string,unknown>){
    const values=tradeInput(input),{connection,client}=await this.connection(token);
    const [account,policy,markets,positions]=await Promise.all([client.getAccount(connection.selected_account_id),client.getTradingPolicy(connection.selected_account_id),client.listMarkets(),client.listOpenPositions(connection.selected_account_id)]);
    if(!isActiveAccount(account))throw new MobileValidationError('Select an active account from Home.');
    const market=markets.find(m=>m.id===values.marketId&&m.available!==false);
    if(!market)throw new MobileValidationError('This market is currently unavailable.');
    const first=await client.getQuote(market.id);
    if(!Number.isFinite(first.mid)||first.mid<=0)throw new MobileValidationError('A valid market price is unavailable.');
    const size=calculateSize(values.riskUsd,first.mid,values.stopPercent,market.size_precision??market.quantity_precision??6);
    const quote=await client.getQuote(market.id,values.side,size);
    if(quote.fillable===false)throw new MobileValidationError('This size is not fillable at the market precision.');
    const ticket=buildTicket({id:randomUUID(),userId:0,accountId:account.id,market,symbol:String(market.symbol??market.id.split('|').at(-1)),...values,quote,ttlSeconds:this.config.CONFIRMATION_TTL_SECONDS});
    // Preserve the exact size used for MFP's size-aware quote.
    ticket.size = size;
    const direction = values.side === 'buy' ? 1 : -1;
    const distance = values.riskUsd / size;
    ticket.stopLossPrice = ticket.expectedPrice - direction * distance;
    ticket.takeProfitPrice = ticket.expectedPrice + direction * distance * values.rewardRisk;
    ticket.estimatedNotional = quote.estimated_notional ?? size * ticket.expectedPrice;
    ticket.platformRules=platformRuleCheck({account,policy,market,ticket,openPositions:positions});
    if(ticket.size<=0||!Number.isFinite(ticket.size)||!Number.isFinite(ticket.expectedPrice)||ticket.stopLossPrice<=0||ticket.takeProfitPrice<=0)throw new MobileValidationError('These inputs produce invalid prices or size.');
    ticket.platformRules.warnings.push(...guardWarnings(connection.personal_guards,account,ticket.riskUsd));
    await this.auth.saveTicket(token,ticket);
    return {ticket,dryRun:this.config.DRY_RUN,accountName:account.name??account.id};
  }
  async quick(token:string,input:Record<string,unknown>){
    const connection=await this.auth.connection(token);
    const prefs=connection?.personal_guards;
    if(prefs?.quickTradeEnabled!==true)throw new MobileValidationError('Enable one-tap trading in Settings first.');
    const amounts=prefs.quickAmounts??[10,50,100];
    if(!amounts.includes(Number(input.riskUsd)))throw new MobileValidationError('Choose one of your saved quick risk amounts.');
    const {ticket}=await this.quote(token,input);
    const result=await this.confirm(token,ticket.id);
    return {...result,warnings:ticket.platformRules?.warnings??[]};
  }
  async confirm(token:string,id:string){
    const {connection,client}=await this.connection(token);
    const ticket=await this.auth.claimTicket(token,id);
    if(!ticket){
      const previous=await this.auth.ticketResult(token,id);
      if(previous?.result?.status==='not_submitted')throw new MobileValidationError('This order was not sent. Review a new quote.');
      if(previous?.result)return previous.result;
      if(previous?.submitted_at)throw new MobileWriteUncertainError('This request was already submitted.');
      throw new MobileValidationError('Quote expired. Review a new quote.');
    }
    let submitted=false;
    try{
      if(connection.selected_account_id!==ticket.accountId)throw new MobileValidationError('Selected account changed. Review a new quote.');
      const [account,policy,markets,positions]=await Promise.all([client.getAccount(ticket.accountId),client.getTradingPolicy(ticket.accountId),client.listMarkets(),client.listOpenPositions(ticket.accountId)]);
      if(!isActiveAccount(account))throw new MobileValidationError('The account is no longer active.');
      const market=markets.find(m=>m.id===ticket.marketId&&m.available!==false);
      if(!market)throw new MobileValidationError('The market is no longer available.');
      guardWarnings(connection.personal_guards,account,ticket.riskUsd);
      const check=platformRuleCheck({account,policy,market,ticket,openPositions:positions});
      if(check.problems.length)throw new MobileValidationError(check.problems.join(' '));
      if(this.config.DRY_RUN){const result={dryRun:true,status:'validated'};await this.auth.saveTicketResult(id,result);return result;}
      if (Date.now() >= ticket.expiresAt) throw new MobileValidationError('Quote expired. Review a new quote.');
      submitted=true;
      const order=await client.placeProtectedMarketOrder({accountId:ticket.accountId,marketId:ticket.marketId,side:ticket.side,size:ticket.size,expectedPrice:ticket.expectedPrice,leverage:ticket.leverage,stopLossPrice:ticket.stopLossPrice,takeProfitPrice:ticket.takeProfitPrice,clientOrderId:`guardian-native-${ticket.id}`,idempotencyKey:ticket.id});
      const result={dryRun:false,status:String(order.status??'pending'),orderId:order.id};
      await this.auth.saveTicketResult(id,result);return result;
    }catch(e){
      if(!submitted)await this.auth.saveTicketResult(id,{status:'not_submitted'});
      throw e;
    }
  }
}
