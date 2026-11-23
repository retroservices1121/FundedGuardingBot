import { describe, expect, it } from 'vitest';
import { isTradeCheck, isTradeWrite, orderResultMessage, parseConfirmRetry, protectionResultMessage, tradeWriteResult, TradeWriteUncertainError, TradeWriteValidationError } from '../src/lib/trade-write';

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
      .toThrow(new TradeWriteValidationError('Review a new quote.'));
    expect(() => tradeWriteResult(false,422,{error:'SDK error',uncertain:false}))
      .toThrow(new TradeWriteValidationError('The request was rejected. Review the details before trying again.'));
    expect(tradeWriteResult(true,200,{dryRun:false,status:'pending'})).toEqual({dryRun:false,status:'pending'});
  });

  it('restores the original confirmation and only accepts status-check routes', () => {
    const saved = {path:'close/check',ticketId:'original-ticket',userId:'original-user'};
    expect(parseConfirmRetry(JSON.stringify(saved))).toEqual(saved);
    expect(parseConfirmRetry(JSON.stringify({...saved,path:'close/confirm'}))).toBeUndefined();
    expect(parseConfirmRetry('pending')).toBeUndefined();
    expect(isTradeCheck('trade/check','POST')).toBe(true);
    expect(isTradeWrite('trade/check','POST')).toBe(false);
  });

  it('shows the recovered outcome, including a rejected close', () => {
    expect(orderResultMessage({dryRun:false,status:'filled'})).toBe('MyFundedPerps filled the order.');
    expect(orderResultMessage({dryRun:false,status:'rejected'},true)).toBe('MyFundedPerps rejected the close order.');
  });

  it('directs legacy requests to MyFundedPerps and keeps the result uncertain', () => {
    const message = "This older request can't be checked here. Please check MyFundedPerps for its status.";
    expect(orderResultMessage({dryRun:false,status:'legacy'})).toBe(message);
    expect(orderResultMessage({dryRun:false,status:'legacy'},true)).toBe(message);
    expect(() => tradeWriteResult(true,200,{status:'legacy'})).toThrow(new TradeWriteUncertainError(message));
  });

  it('explains practice outcomes without suggesting an order was sent', () => {
    const practice = {dryRun:true,status:'validated'};
    expect(orderResultMessage(practice)).toBe('Practice order complete. No order was sent.');
    expect(orderResultMessage(practice,true)).toBe('Practice close complete. No order was sent.');
    expect(protectionResultMessage(practice)).toBe('Practice edit complete. No orders were sent.');
  });

  it('does not show raw exit-order statuses', () => {
    expect(protectionResultMessage({dryRun:false,status:'HTTP 502'})).toBe('Check MyFundedPerps for the latest on your exit orders.');
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
