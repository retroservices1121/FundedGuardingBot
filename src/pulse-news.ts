import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import type { Database } from './db.js';
export const PULSE_RSS_SOURCES=[
 {name:'CoinDesk',url:'https://www.coindesk.com/arc/outboundfeeds/rss/',host:'coindesk.com'},
 {name:'Cointelegraph',url:'https://cointelegraph.com/rss',host:'cointelegraph.com'},
 {name:'Decrypt',url:'https://decrypt.co/feed',host:'decrypt.co'},
 {name:'The Block',url:'https://www.theblock.co/rss.xml',host:'theblock.co'},
 {name:'BBC Business',url:'https://feeds.bbci.co.uk/news/business/rss.xml',host:'bbc.co.uk',additionalHosts:['bbc.com']},
 {name:'Investing.com',url:'https://www.investing.com/rss/news_25.rss',host:'investing.com'},
 {name:'Federal Reserve',url:'https://www.federalreserve.gov/feeds/press_all.xml',host:'federalreserve.gov'},
];
export function parseHeadlines(xml:string,source:{name:string;host:string;additionalHosts?:string[]},now=Date.now()) {
 const parsed=new XMLParser({processEntities:false}).parse(xml);
 const raw=parsed?.rss?.channel?.item;
 const items=Array.isArray(raw)?raw:raw?[raw]:[];
 return items.flatMap((item:any)=>{
  try {
   const link=new URL(String(item.link)),date=new Date(item.pubDate),time=date.getTime();
   if(link.protocol!=='https:'||![source.host,...source.additionalHosts??[]].some(host=>link.hostname===host||link.hostname.endsWith(`.${host}`))||!Number.isFinite(time)||time>now+300000||time<now-72*3600000)return [];
   const title=String(item.title??'').replace(/<[^>]*>/g,'').trim().slice(0,300);if(!title)return [];
   return [{id:`rss:${createHash('sha256').update(link.href).digest('hex')}`,kind:'news',title,body:'',sourceName:source.name,sourceUrl:link.href,publishedAt:date.toISOString()}];
  }catch{return [];}
 });
}
export function startPulseNews(db:Database) {
 let running=false;
 async function poll(){
  if(running)return;running=true;
  try {await Promise.all(PULSE_RSS_SOURCES.map(async source=>{
   try {
    const response=await fetch(source.url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; FundedGuardian/1.0; RSS reader)','Accept':'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const reader=response.body?.getReader();if(!reader)throw new Error('Empty feed');let bytes=0;const chunks:Uint8Array[]=[];
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2_000_000){await reader.cancel();throw new Error('Feed too large');}chunks.push(value);}
    for(const item of parseHeadlines(Buffer.concat(chunks).toString('utf8'),source))await db.savePulseItem(item);
   }catch(error){console.warn(`Pulse RSS ${source.name} unavailable:`,error instanceof Error?error.message:'Unknown error');}
  }));}finally{running=false;}
 }
 void poll();const timer=setInterval(()=>void poll(),300000);timer.unref();return ()=>clearInterval(timer);
}
