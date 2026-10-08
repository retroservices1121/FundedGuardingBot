import type {Candle} from './chart-data';
import {demoShareImage} from './demo-share-image';

export const DEMO_TOKEN = 'guardian-local-demo';
export const DEMO_USER = {id:'local-demo',provider:'demo'};
export const demoMarkets = [
 {id:'binance|BTCUSDT',symbol:'BTC',coin:'BTCUSDT',provider:'binance',maxLeverage:10,category:'crypto',price:86500,change:2.4,openInterest:420000000},
 {id:'binance|ETHUSDT',symbol:'ETH',coin:'ETHUSDT',provider:'binance',maxLeverage:10,category:'crypto',price:3250,change:-1.2,openInterest:180000000},
 {id:'binance|SOLUSDT',symbol:'SOL',coin:'SOLUSDT',provider:'binance',maxLeverage:5,category:'crypto',price:174.42,change:3.8,openInterest:95000000},
 {id:'hyperliquid|xyz:AMZN',symbol:'AMZN',coin:'xyz:AMZN',provider:'hyperliquid',maxLeverage:5,category:'stocks',price:256.78,change:.7,openInterest:12000000},
];
export function demoMarketFeed(){return Object.fromEntries(demoMarkets.map(m=>[`${m.provider}|${m.coin.toUpperCase()}`,{price:m.price,change:m.change,openInterest:m.openInterest,volume:m.openInterest*2}]));}
export function demoChart(provider:string,coin:string,interval:string,now=Date.now()){
 const market=demoMarkets.find(m=>m.provider===provider&&m.coin===coin)??demoMarkets[0];
 const duration=({'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000} as Record<string,number>)[interval]??300000;
 const end=Math.floor(now/duration)*duration;
 const bars:Candle[]=Array.from({length:70},(_,i)=>{const close=market.price*(1+Math.sin(i*.52)*.004+(i-69)*.00005),open=market.price*(1+Math.sin((i-1)*.52)*.004+(i-70)*.00005);return {time:end-(69-i)*duration,open,close,high:Math.max(open,close)*1.002,low:Math.min(open,close)*.998};});
 bars[69]={...bars[69],close:market.price,high:Math.max(bars[69].high,market.price),low:Math.min(bars[69].low,market.price)};
 return {bars,price:market.price,status:'Sample data',bid:market.price*.99999,ask:market.price*1.00001,bidSize:12.5,askSize:8.2};
}

const account={id:'demo-account',name:'Demo · $25,000 Challenge',stage:'evaluation',status:'active',starting_balance:25000,balance:25320};
const open=[{id:'demo-btc',market_id:demoMarkets[0].id,symbol:'BTC',coin:'BTCUSDT',provider:'binance',side:'long',size:.05,entry_price:85000,leverage:5,markPrice:86500,estimatedUnrealizedPnl:75,estimatedCloseFee:2.16}];
const closed=[{id:'demo-closed',market_id:demoMarkets[2].id,symbol:'SOL',coin:'SOLUSDT',provider:'binance',side:'long',size:10,entry_price:170,exit_price:174,leverage:3,realized_pnl:39.13,fees:.87,closed_at:1791399600000}];

// Local-only request adapter. Unknown routes fail; nothing falls back to the real API.
export function createDemoClient(){
 const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
 let guards:Record<string,unknown>={mode:'off',quickTradeEnabled:false,quickAmounts:[10,50,100]};
 const tickets=new Map<string,{kind:string;expiresAt:number}>();let sequence=0;
 function ticket(kind:string){const value={id:`demo-${++sequence}`,expiresAt:Date.now()+60000};tickets.set(value.id,{kind,expiresAt:value.expiresAt});return value;}
 function confirm(id:unknown,kind:string){const item=tickets.get(String(id));if(!item||item.kind!==kind||Date.now()>=item.expiresAt)throw new Error('Sample review expired or already validated. Review again.');tickets.delete(String(id));return {dryRun:true,status:'validated'};}
 function position(id:unknown){const p=open.find(p=>p.id===id);if(!p)throw new Error('Choose the sample open position.');return p;}
 async function request(path:string,method='GET',input?:unknown,_token?:string):Promise<any>{
  const data=(input??{}) as Record<string,unknown>,route=path.split('?')[0];
  if(route==='me'&&method==='GET')return {user:DEMO_USER};
  if(route==='connection'&&method==='GET')return {connected:true,accounts:[{...account}],selectedAccountId:account.id,keyLastFour:'DEMO'};
  if(route==='account-selection'&&method==='POST'){if(data.accountId!==account.id)throw new Error('Choose the sample account.');return {ok:true};}
  if(route==='dashboard'&&method==='GET')return {account:{...account},risk:{equity:25395,unrealized_pnl:75,available_balance:24530,marks_complete:true},rules:{profit:{targetAmount:2000,remaining:1605,achievedAmount:395,achievedPercent:19.75},dailyLoss:{limitPct:5,limitAmount:1250,floor:24070,room:1325,usedAmount:0,usedPercent:0},maxDrawdown:{limitPct:10,limitAmount:2500,floor:22500,room:2895,usedAmount:0,usedPercent:0}},updatedAt:new Date().toISOString(),refreshSeconds:20};
  if(route==='markets'&&method==='GET')return {markets:demoMarkets.map(m=>({...m}))};
  if(route==='activity'&&method==='GET')return {accountId:account.id,open:open.map(p=>({...p})),closed:closed.map(p=>({...p})),updatedAt:new Date().toISOString(),refreshSeconds:20};
  if(route==='guards'&&method==='GET')return copy(guards);
  if(route==='guards'&&method==='POST'){guards=copy(data);return copy(guards);}
  if(route==='pulse'&&method==='GET')return {updatedAt:new Date().toISOString(),items:[{id:'demo-news',kind:'news',title:'Sample headline · Your markets, on the go',body:'Sample headline\nExplore the Pulse layout. This is demonstration content, not current news.',sourceName:'Guardian Demo',publishedAt:'2026-10-07T12:00:00.000Z'},{id:'demo-alert',kind:'move',title:'Sample alert · BTC price move',body:'Sample alert\nA demonstration market-move notification. No real alert was generated.',sourceName:'Guardian Demo',publishedAt:'2026-10-07T11:45:00.000Z'}]};
  if(route==='protection'&&method==='POST'){const p=position(data.positionId);return {position:{...p},markPrice:p.markPrice,orders:[{id:'demo-tp',group:'tp',trigger_price:87500},{id:'demo-sl',group:'sl',trigger_price:84150}]};}
  if(route==='protection/quote'&&method==='POST'){position(data.positionId);if(![data.takeProfitPrice,data.stopLossPrice].every(v=>Number.isFinite(Number(v))&&Number(v)>0))throw new Error('Enter positive trigger prices.');return {dryRun:true,ticket:ticket('protection')};}
  if(route==='protection/confirm'&&method==='POST')return confirm(data.ticketId,'protection');
  if(route==='close/quote'&&method==='POST'){const p=position(data.positionId),percent=Number(data.percent);if(![25,50,100].includes(percent))throw new Error('Choose a sample close percentage.');return {dryRun:true,ticket:{...ticket('close'),symbol:p.symbol,percent,originalSize:p.size,size:p.size*percent/100,expectedPrice:p.markPrice,estimatedFee:p.estimatedCloseFee*percent/100}};}
  if(route==='close/confirm'&&method==='POST')return confirm(data.ticketId,'close');
  if((route==='trade/quote'||route==='trade/quick')&&method==='POST'){
   const market=demoMarkets.find(m=>m.id===data.marketId),risk=Number(data.riskUsd),stop=Number(data.stopPercent),reward=Number(data.rewardRisk),leverage=Number(data.leverage);
   if(!market||!['buy','sell'].includes(String(data.side))||![risk,stop,reward,leverage].every(v=>Number.isFinite(v)&&v>0)||stop>=100||reward>100||leverage<1||leverage>market.maxLeverage)throw new Error('Choose valid sample trade inputs.');
   if(route==='trade/quick')return {dryRun:true,status:'validated',warnings:['Demo only. No order was sent.']};
   const notional=risk/(stop/100),direction=data.side==='buy'?1:-1;
   return {dryRun:true,accountName:account.name,ticket:{...ticket('trade'),symbol:market.symbol,side:data.side,riskUsd:risk,size:notional/market.price,expectedPrice:market.price,stopLossPrice:market.price*(1-direction*stop/100),takeProfitPrice:market.price*(1+direction*stop/100*reward),estimatedNotional:notional,estimatedFee:notional*.0005,leverage,platformRules:{warnings:['Sample data. This review never submits a real order.'],estimatedMargin:notional/leverage+notional*.0005}}};
  }
  if(route==='trade/confirm'&&method==='POST')return confirm(data.ticketId,'trade');
  if(route==='share'&&method==='POST'){if(data.positionId!==closed[0].id)throw new Error('Choose the sample closed position.');return {imageBase64:demoShareImage};}
  throw new Error('This action is unavailable in demo mode. Exit demo and sign in to connect your account.');
 }
 return {request,reset(){guards={mode:'off',quickTradeEnabled:false,quickAmounts:[10,50,100]};tickets.clear();sequence=0;}};
}
