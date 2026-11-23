import { MobileValidationError, MobileWriteUncertainError } from './mobile-errors.js';
import { guardWarnings } from "./mobile-guards.js";
import type { Side } from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { MobileAuth } from './mobile-auth.js';
import { MfpClient, isActiveAccount } from './mfp.js';
import { SecretBox } from './crypto.js';
import { buildTicket, calculateSize, platformRuleCheck } from './risk.js';
import type { PersonalGuards } from './mobile-guards.js';
import { orderRequestRejected, reconcileOrder, submitOrder } from './mobile-order.js';

const hosts={live:'https://developers.myfundedperpetuals.com',sandbox:'https://sandbox.myfundedperpetuals.com'};
const entryClientOrderId=(id:string)=>`guardian-native-${id}`;
function checkQuickPrefs(prefs:PersonalGuards|undefined,riskUsd:number){
  if(prefs?.quickTradeEnabled!==true)throw new MobileValidationError('Enable one-tap trading in Settings first.');
  if(!(prefs.quickAmounts??[10,50,100]).includes(riskUsd))throw new MobileValidationError('Choose one of your saved quick risk amounts.');
}
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
    if(input.requestId!==undefined)return this.quickQuote(token,input,await this.quickId(token,input.requestId));
    return this.createQuote(token,input,randomUUID(),false);
  }
  private async createQuote(token:string,input:Record<string,unknown>,id:string,quick:boolean){
    const values=tradeInput(input),{connection,client}=await this.connection(token);
    if(quick)checkQuickPrefs(connection.personal_guards,values.riskUsd);
    const [account,policy,markets,positions]=await Promise.all([client.getAccount(connection.selected_account_id),client.getTradingPolicy(connection.selected_account_id),client.listMarkets(),client.listOpenPositions(connection.selected_account_id)]);
    if(!isActiveAccount(account))throw new MobileValidationError('Select an active account from Home.');
    const market=markets.find(m=>m.id===values.marketId&&m.available!==false);
    if(!market)throw new MobileValidationError('This market is currently unavailable.');
    const first=await client.getQuote(market.id);
    if(!Number.isFinite(first.mid)||first.mid<=0)throw new MobileValidationError('A valid market price is unavailable.');
    const size=calculateSize(values.riskUsd,first.mid,values.stopPercent,market.size_precision??market.quantity_precision??6);
    const quote=await client.getQuote(market.id,values.side,size);
    if(quote.fillable===false)throw new MobileValidationError('This size is not fillable at the market precision.');
    const ticket=buildTicket({id,userId:0,accountId:account.id,market,symbol:String(market.symbol??market.id.split('|').at(-1)),...values,quote,ttlSeconds:this.config.CONFIRMATION_TTL_SECONDS});
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
    const saved=quick ? await this.auth.saveTicket(token,ticket,true) : await this.auth.saveTicket(token,ticket);
    const stored=quick&&saved===false ? (await this.auth.ticketResult(token,id))?.payload : ticket;
    if(!stored)throw new Error('Could not load the saved trade.');
    return {ticket:stored,dryRun:this.config.DRY_RUN,accountName:account.name??account.id};
  }
  private async quickId(token:string,requestId:unknown){
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{20,80}$/.test(requestId))throw new MobileValidationError('Open a new one-tap order confirmation.');
    const user=await this.auth.user(token);
    return 'quick-'+createHash('sha256').update(JSON.stringify([user.id,requestId])).digest('hex').slice(0,32);
  }
  private async quickQuote(token:string,input:Record<string,unknown>,id:string){
    const previous=await this.auth.ticketResult(token,id);
    if(previous)return {ticket:previous.payload,dryRun:this.config.DRY_RUN};
    return this.createQuote(token,input,id,true);
  }
  async quick(token:string,input:Record<string,unknown>){
    const id=await this.quickId(token,input.requestId);
    const {ticket}=await this.quickQuote(token,input,id);
    const result=await this.confirm(token,id);
    return {...result,warnings:ticket.platformRules?.warnings??[]};
  }
  async confirm(token:string,id:string,checkOnly=false){
    const quick=id.startsWith('quick-');
    if(checkOnly)await this.auth.cancelUnclaimedTicket(token,id);
    const ticket=checkOnly ? undefined : await this.auth.claimTicket(token,id);
    if(!ticket){
      const previous=await this.auth.ticketResult(token,id);
      if(previous?.result?.status==='not_submitted')throw new MobileValidationError('This order was not sent. Review a new quote.');
      if(previous?.result)return previous.result;
      if(previous?.submitted_at){
        const lookup=await this.connection(token).catch(()=>undefined);
        const result=lookup&&await reconcileOrder(lookup.client,entryClientOrderId(id),previous.payload.accountId);
        if(result){await this.auth.saveTicketResult(id,result);return result;}
        throw new MobileWriteUncertainError('This request was already submitted.');
      }
      throw new MobileValidationError(quick?'Quote expired. Tap the saved amount again.':'Quote expired. Review a new quote.');
    }
    let submitted=false;
    try{
      const {connection,client}=await this.connection(token);
      if(quick)checkQuickPrefs(connection.personal_guards,ticket.riskUsd);
      if(connection.selected_account_id!==ticket.accountId)throw new MobileValidationError('Selected account changed. Review a new quote.');
      const [account,policy,markets,positions]=await Promise.all([client.getAccount(ticket.accountId),client.getTradingPolicy(ticket.accountId),client.listMarkets(),client.listOpenPositions(ticket.accountId)]);
      if(!isActiveAccount(account))throw new MobileValidationError('The account is no longer active.');
      const market=markets.find(m=>m.id===ticket.marketId&&m.available!==false);
      if(!market)throw new MobileValidationError('The market is no longer available.');
      guardWarnings(connection.personal_guards,account,ticket.riskUsd);
      const check=platformRuleCheck({account,policy,market,ticket,openPositions:positions});
      if(check.problems.length)throw new MobileValidationError(check.problems.join(' '));
      if(this.config.DRY_RUN){const result={dryRun:true,status:'validated'};await this.auth.saveTicketResult(id,result);return result;}
      if (Date.now() >= ticket.expiresAt) throw new MobileValidationError(quick?'Quote expired. Tap the saved amount again.':'Quote expired. Review a new quote.');
      submitted=true;
      const clientOrderId=entryClientOrderId(ticket.id);
      const result=await submitOrder(client,clientOrderId,ticket.accountId,()=>client.placeProtectedMarketOrder({accountId:ticket.accountId,marketId:ticket.marketId,side:ticket.side,size:ticket.size,expectedPrice:ticket.expectedPrice,leverage:ticket.leverage,stopLossPrice:ticket.stopLossPrice,takeProfitPrice:ticket.takeProfitPrice,clientOrderId,idempotencyKey:ticket.id}));
      await this.auth.saveTicketResult(id,result);return result;
    }catch(e){
      if(!submitted||orderRequestRejected(e))await this.auth.saveTicketResult(id,{status:'not_submitted'});
      throw e;
    }
  }
}
