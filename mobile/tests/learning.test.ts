import {describe,it,expect} from 'vitest';
import {simulateTrade} from '../src/lib/learning.js';
describe('learning scenarios',()=>{
 it('distinguishes margin, exposure and risk',()=>expect(simulateTrade(500,5,1,2)).toMatchObject({notional:2500,loss:25,profit:50,marginReturnLoss:5}));
 it('rejects blank or invalid scenarios',()=>{expect(simulateTrade(0,5,1,2)).toBeNull();expect(simulateTrade(500,5,100,2)).toBeNull();});
});
