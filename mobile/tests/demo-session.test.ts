import {afterEach,describe,expect,it,vi} from 'vitest';
import {createDemoClient,demoChart,demoMarkets,DEMO_TOKEN} from '../src/lib/demo-session';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('local demo boundary',()=>{
 it('provides account, positions, exits, feed and share card without network access',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
  const {request}=createDemoClient();
  expect((await request('connection')).keyLastFour).toBe('DEMO');
  expect((await request('dashboard')).risk.equity).toBeGreaterThan(0);
  const positions=await request('activity');
  expect((await request('protection','POST',{positionId:positions.open[0].id},DEMO_TOKEN)).orders).toHaveLength(2);
  expect((await request('pulse')).items.every((i:{title:string})=>i.title.startsWith('Sample'))).toBe(true);
  expect(Buffer.from((await request('share','POST',{positionId:positions.closed[0].id})).imageBase64,'base64').subarray(1,4).toString()).toBe('PNG');
  await expect(request('connect','POST',{apiKey:'not-a-real-key'})).rejects.toThrow('unavailable in demo mode');
  await expect(request('unexpected-route','POST')).rejects.toThrow('unavailable in demo mode');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('validates a review once without changing positions and rejects excessive leverage',async()=>{
  const {request}=createDemoClient(),inputs={marketId:demoMarkets[0].id,side:'buy',riskUsd:50,stopPercent:1,rewardRisk:2,leverage:5};
  const before=await request('activity'),quote=await request('trade/quote','POST',inputs);
  expect(quote.dryRun).toBe(true);expect(quote.ticket.estimatedNotional).toBe(5000);
  expect(await request('trade/confirm','POST',{ticketId:quote.ticket.id})).toEqual({dryRun:true,status:'validated'});
  await expect(request('trade/confirm','POST',{ticketId:quote.ticket.id})).rejects.toThrow('already validated');
  expect((await request('activity')).open).toEqual(before.open);
  await expect(request('trade/quote','POST',{...inputs,leverage:100})).rejects.toThrow('valid sample trade');
 });
 it('expires sample reviews and keeps preferences isolated between demo sessions',async()=>{
  vi.useFakeTimers();const a=createDemoClient(),b=createDemoClient();
  await a.request('guards','POST',{mode:'warn'});expect((await b.request('guards')).mode).toBe('off');
  const close=await a.request('close/quote','POST',{positionId:'demo-btc',percent:50});
  vi.advanceTimersByTime(60001);await expect(a.request('close/confirm','POST',{ticketId:close.ticket.id})).rejects.toThrow('expired');
  a.reset();expect((await a.request('guards')).mode).toBe('off');
 });
 it('creates usable sample candles for every market and timeframe',()=>{
  for(const m of demoMarkets)for(const interval of ['1m','5m','15m','30m','1h','4h']){
   const chart=demoChart(m.provider,m.coin,interval);expect(chart.status).toBe('Sample data');expect(chart.bars).toHaveLength(70);
   expect(chart.bars.every(b=>b.low<=Math.min(b.open,b.close)&&b.high>=Math.max(b.open,b.close))).toBe(true);
   expect(chart.bars.every((b,i)=>i===0||b.time>chart.bars[i-1].time)).toBe(true);
  }
 });
});
