type WorkingExit={
 group?:string|null;
 exit_group?:string|null;
 type?:string|null;
 trigger_price?:number|string|null;
 limit_price?:number|string|null;
 price?:number|string|null;
};

export function workingExitPrices(orders:WorkingExit[]){
 const takeProfit=new Set<number>(),stopLoss=new Set<number>();
 for(const order of orders){
  const kind=order.group??order.exit_group??order.type??'';
  const price=Number(order.trigger_price??order.limit_price??order.price);
  if(!Number.isFinite(price)||price<=0)continue;
  if(/tp|take/i.test(kind))takeProfit.add(price);
  else if(/sl|stop/i.test(kind))stopLoss.add(price);
 }
 return {
  takeProfit:takeProfit.size===1?String([...takeProfit][0]):'',
  stopLoss:stopLoss.size===1?String([...stopLoss][0]):'',
 };
}
