import {useSession} from '../../App';
import {demoChart} from '../lib/demo-session';
import {useEffect,useState} from 'react';
import {AppState} from 'react-native';
import {useIsFocused} from 'expo-router/react-navigation';
import {Candle,mergeCandle,parseCandle,applyTick} from '../lib/chart-data';
export function useMarketChart(provider?:string,coin?:string,interval='5m'){
 const {demo}=useSession();const focused=useIsFocused();const [data,setData]=useState<{bars:Candle[];price?:number;status:string;bid?:number;ask?:number;bidSize?:number;askSize?:number}>({bars:[],status:'Choose a market'});
 useEffect(()=>{
  if(!focused||!provider||!coin)return;
  if(demo){const timer=setTimeout(()=>setData(demoChart(provider,coin,interval)),0);return()=>clearTimeout(timer);}
  let stopped=false,socket:WebSocket|null=null,retry:ReturnType<typeof setTimeout>|undefined,flush:ReturnType<typeof setTimeout>|undefined,lastEvent=0,lastPrice: number|undefined,lastPriceAt=0,bars:Candle[]=[],price:number|undefined,bid:number|undefined,ask:number|undefined,bidSize:number|undefined,askSize:number|undefined;
  function update(status=lastEvent&&Date.now()-lastEvent<=30000?'Live':'Waiting for price'){if(stopped)return;setData({bars:[...bars],price,status,bid,ask,bidSize,askSize});}
  function connect(){if(stopped||AppState.currentState==='background')return;update('Connecting');socket=new WebSocket('wss://api-stream.myfundedperpetuals.com/v1/market-data');
   socket.onopen=()=>{const identity={providers:[provider],symbols:[coin]};for(const [id,channel] of ['ticks','books','candles','marketStats'].entries())socket?.send(JSON.stringify({op:'sub',id:id+1,channel,payload:channel==='candles'?{...identity,intervals:[interval],historyLimit:70}:identity}));};
   socket.onmessage=message=>{try{const frame=JSON.parse(String(message.data));if(frame.op==='sub_err'||frame.op==='err'){update('Feed error');return;}let changed=false;for(const wrapper of frame.events??[]){const raw=wrapper.candle??wrapper.tick??wrapper.book??wrapper.marketStats??wrapper;if(raw.provider&&String(raw.provider).toLowerCase()!==provider!.toLowerCase()||raw.symbol&&String(raw.symbol).toUpperCase()!==coin!.toUpperCase())continue;
    if(raw.openTime!=null){if(raw.interval&&raw.interval!==interval)continue;const bar=parseCandle(raw);if(!bar)continue;bars=mergeCandle(bars,bar);if(lastPrice!==undefined)bars=applyTick(bars,lastPrice,lastPriceAt,interval);if(bar.time===bars.at(-1)?.time){price=bars.at(-1)!.close;lastEvent=Date.now();}changed=true;}
    else if(Array.isArray(raw.bids)&&Array.isArray(raw.asks)){const b=Number(raw.bids[0]?.px??raw.bids[0]?.price??raw.bids[0]?.p??raw.bids[0]?.[0]),a=Number(raw.asks[0]?.px??raw.asks[0]?.price??raw.asks[0]?.p??raw.asks[0]?.[0]);if(Number.isFinite(b)&&b>0)bid=b;if(Number.isFinite(a)&&a>0)ask=a;const bs=Number(raw.bids[0]?.sz??raw.bids[0]?.size??raw.bids[0]?.[1]),as=Number(raw.asks[0]?.sz??raw.asks[0]?.size??raw.asks[0]?.[1]);bidSize=Number.isFinite(bs)&&bs>=0?bs:undefined;askSize=Number.isFinite(as)&&as>=0?as:undefined;changed=true;}
    else if(raw.price!=null||raw.markPx!=null){const value=Number(raw.price??raw.markPx);if(!Number.isFinite(value)||value<=0)continue;price=value;lastPrice=value;lastPriceAt=Date.now();lastEvent=lastPriceAt;bars=applyTick(bars,value,lastPriceAt,interval);changed=true;}
   }if(changed){if(!flush)flush=setTimeout(()=>{update();flush=undefined;},100);}}catch{/* Ignore malformed frames. */}};
   socket.onclose=()=>{socket=null;if(!stopped){update('Reconnecting');retry=setTimeout(connect,2500);}};socket.onerror=()=>update('Feed unavailable');
  }
  const watchdog=setInterval(()=>{if(lastEvent&&Date.now()-lastEvent>30000&&AppState.currentState==='active')update('Price may be stale');},5000);
  connect();const listener=AppState.addEventListener('change',state=>{if(state==='active'){if(!socket)connect();}else{if(retry)clearTimeout(retry);if(socket){socket.onclose=null;socket.close();socket=null;}update('Paused');}});
  return()=>{stopped=true;listener.remove();clearInterval(watchdog);if(retry)clearTimeout(retry);if(flush)clearTimeout(flush);if(socket){socket.onclose=null;socket.close();}};
 },[provider,coin,interval,focused,demo]);return data;
}
