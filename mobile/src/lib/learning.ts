export function simulateTrade(margin:number,leverage:number,stopPercent:number,targetPercent:number){
 if([margin,leverage,stopPercent,targetPercent].some(v=>!Number.isFinite(v)||v<=0)||stopPercent>=100) return null;
 const notional=margin*leverage,loss=notional*stopPercent/100,profit=notional*targetPercent/100;
 if(![notional,loss,profit].every(Number.isFinite))return null;
 return {notional,loss,profit,marginReturnLoss:loss/margin*100,marginReturnProfit:profit/margin*100};
}
