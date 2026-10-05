import {describe,it,expect} from 'vitest';
import {parseGuards,guardWarnings} from '../src/mobile-guards.js';
const account={id:'a',risk:{daily_loss_room:200,max_drawdown_room:500}};
describe('personal native guards',()=>{
 it('has no default restriction',()=>expect(guardWarnings({mode:'off'},account,1000)).toEqual([]));
 it('warns without blocking or enforces only chosen limits',()=>{expect(guardWarnings({mode:'warn',maxRiskUsd:50},account,65)).toHaveLength(1);expect(()=>guardWarnings({mode:'enforce',maxRiskUsd:50},account,65)).toThrow('personal trade limit');});
 it('uses the smaller room and handles unavailable data',()=>{expect(()=>guardWarnings({mode:'enforce',lossRoomPercent:30},account,65)).toThrow('$60.00');expect(()=>guardWarnings({mode:'enforce',lossRoomPercent:30},{id:'a'},10)).toThrow('unavailable');});
 it('rejects invalid settings and enabled empty limits',()=>{for(const input of [{mode:'enforce'},{mode:'warn',maxRiskUsd:-1},{mode:'warn',lossRoomPercent:101},{mode:'other'}])expect(()=>parseGuards(input)).toThrow();expect(parseGuards({mode:'off'})).toEqual({mode:'off'});});
});
