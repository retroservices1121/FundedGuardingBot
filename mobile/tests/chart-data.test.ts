import {describe,it,expect} from 'vitest';
import {parseCandle,mergeCandle,chartRange} from '../src/lib/chart-data';
describe('market chart data',()=>{
 it('normalizes seconds and rejects invalid candle prices',()=>{expect(parseCandle({openTime:1700000000,open:100,high:102,low:99,close:101})?.time).toBe(1700000000000);expect(parseCandle({openTime:1700000000,open:100,high:98,low:99,close:101})).toBeNull();});
 it('merges forming candles and sorts history without duplicates',()=>{const bar={time:2,open:100,high:102,low:99,close:101};const merged=mergeCandle([bar],{...bar,close:102});expect(merged).toHaveLength(1);expect(merged[0].close).toBe(102);expect(mergeCandle(merged,{...bar,time:1}).map(b=>b.time)).toEqual([1,2]);});
 it('keeps a nonzero range for flat markets and includes wicks',()=>{const bars=[{time:1,open:100,high:110,low:90,close:100}];const range=chartRange(bars,false);expect(range.high).toBeGreaterThan(range.low);const full=chartRange(bars,true);expect(full.low).toBeLessThan(90);expect(full.high).toBeGreaterThan(110);});
});
