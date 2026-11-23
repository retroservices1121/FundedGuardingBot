export type ActivityTick={price:number;time:number;rank:number};

export function latestActivityTick(current:ActivityTick|undefined,event:Record<string,unknown>):ActivityTick|undefined {
 const {time,kind}=event;
 const price=typeof event.price==='number'||typeof event.price==='string'?Number(event.price):NaN;
 const rank=kind==='mark'?3:kind==='mid'?2:kind==='last'?1:0;
 if(!rank||typeof time!=='number'||!Number.isFinite(time)||time<=0||!Number.isFinite(price)||price<=0)return current;
 if(current&&(time<current.time||(time===current.time&&rank<current.rank)))return current;
 return {price,time,rank};
}

export function fresherActivityTick(tick:ActivityTick|undefined,updatedAt:string,hasServerPrice:boolean):ActivityTick|undefined {
 if(!tick)return undefined;
 return !hasServerPrice||tick.time>Date.parse(updatedAt)?tick:undefined;
}
