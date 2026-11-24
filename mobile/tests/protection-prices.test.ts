import { describe, expect, it } from 'vitest';
import { workingExitPrices } from '../src/lib/protection-prices';

describe('working exit prices',()=>{
 it('leaves both prices blank when there are no recognizable exits',()=>{
  const blank={takeProfit:'',stopLoss:''};
  expect(workingExitPrices([])).toEqual(blank);
  expect(workingExitPrices([{type:'limit',price:110},{group:'sl',trigger_price:0}])).toEqual(blank);
 });

 it('loads the matching exit price and leaves the missing price blank',()=>{
  const takeProfit={exit_group:'tp',trigger_price:'110.25',limit_price:111};
  expect(workingExitPrices([takeProfit])).toEqual({takeProfit:'110.25',stopLoss:''});
  expect(workingExitPrices([takeProfit,{type:'stop_market',trigger_price:95}])).toEqual({takeProfit:'110.25',stopLoss:'95'});
 });

 it('leaves a field blank when its working exits use different prices',()=>{
  expect(workingExitPrices([{group:'tp',price:110},{group:'tp',price:120},{group:'sl',price:95}])).toEqual({takeProfit:'',stopLoss:'95'});
 });
});
