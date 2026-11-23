import { describe, expect, it } from 'vitest';
import { isTradeWrite, tradeWriteResult, TradeWriteUncertainError, TradeWriteValidationError } from '../src/lib/trade-write';

describe('trade write responses', () => {
  it('tracks all four write paths and allows review requests', () => {
    for (const path of ['trade/quick','trade/confirm','close/confirm','protection/confirm']) {
      expect(isTradeWrite(path,'POST')).toBe(true);
    }
    expect(isTradeWrite('trade/quote','POST')).toBe(false);
    expect(isTradeWrite('protection','POST')).toBe(false);
  });

  it('preserves confirmed validation messages and valid write results', () => {
    expect(() => tradeWriteResult(false,400,{error:'Review a new quote.',uncertain:false}))
      .toThrow(TradeWriteValidationError);
    expect(tradeWriteResult(true,200,{dryRun:false,status:'pending'})).toEqual({dryRun:false,status:'pending'});
  });

  it.each([
    [false,401,{error:'Please sign in again.'}],
    [false,400,{error:'Unclassified older response.'}],
    [false,400,{error:'Check the order.',uncertain:true}],
    [false,502,{error:'Unexpected failure.',uncertain:false}],
    [true,200,{status:'pending',dryRun:false,uncertain:true}],
    [true,200,{status:'pending'}],
    [true,200,null],
  ])('rejects inconclusive responses (%s, %s)', (ok,status,body) => {
    expect(() => tradeWriteResult(ok,status,body)).toThrow(TradeWriteUncertainError);
  });
});
