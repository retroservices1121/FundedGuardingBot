import { describe, expect, it } from 'vitest';
import { fresherActivityTick, latestActivityTick } from '../src/lib/activity-prices';

const updatedAt='2026-11-23T14:00:00.000Z';
const snapshotTime=Date.parse(updatedAt);
const event={price:'100.75',time:snapshotTime,kind:'mark'};

describe('activity prices',()=>{
 it('uses the account snapshot for older or equally recent ticks',()=>{
  const older=latestActivityTick(undefined,{...event,time:snapshotTime-1});
  const equal=latestActivityTick(undefined,event);
  expect(fresherActivityTick(older,updatedAt,true)).toBeUndefined();
  expect(fresherActivityTick(equal,updatedAt,true)).toBeUndefined();
 });

 it('uses a newer tick, or an available tick when there is no server estimate',()=>{
  const newer=latestActivityTick(undefined,{...event,time:snapshotTime+1});
  expect(fresherActivityTick(newer,updatedAt,true)?.price).toBe(100.75);
  expect(fresherActivityTick(newer,updatedAt,false)).toBe(newer);
  expect(fresherActivityTick(undefined,updatedAt,true)).toBeUndefined();
 });

 it('ignores replayed and malformed ticks and prefers a mark on a tie',()=>{
  const mark=latestActivityTick(undefined,event);
  expect(latestActivityTick(mark,{...event,time:snapshotTime-1})).toBe(mark);
  expect(latestActivityTick(mark,{...event,kind:'mid'})).toBe(mark);
  expect(latestActivityTick(mark,{...event,time:undefined})).toBe(mark);
  expect(latestActivityTick(mark,{...event,price:'0'})).toBe(mark);
  expect(latestActivityTick(mark,{...event,kind:'mid',time:snapshotTime+1})?.time).toBe(snapshotTime+1);
 });
});
