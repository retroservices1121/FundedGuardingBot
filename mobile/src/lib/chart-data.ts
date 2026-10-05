export type Candle={time:number;open:number;high:number;low:number;close:number};
export function parseCandle(raw:Record<string,unknown>):Candle|null {
 const source=Number(raw.openTime);const time=source<1e12?source*1000:source;
 const open=Number(raw.open),high=Number(raw.high),low=Number(raw.low),close=Number(raw.close);
 if(![time,open,high,low,close].every(Number.isFinite)||time<=0||Math.min(open,high,low,close)<=0||high<Math.max(open,close)||low>Math.min(open,close)||high<low)return null;
 return {time,open,high,low,close};
}
export function mergeCandle(bars:Candle[],bar:Candle,limit=70){return [...bars.filter(b=>b.time!==bar.time),bar].sort((a,b)=>a.time-b.time).slice(-limit);}
export function chartRange(bars:Candle[],candles:boolean){const values=bars.flatMap(b=>candles?[b.high,b.low]:[b.close]);if(!values.length)return {low:0,high:1};const low=Math.min(...values),high=Math.max(...values),pad=Math.max((high-low)*0.08,high*0.00001);return {low:low-pad,high:high+pad};}
