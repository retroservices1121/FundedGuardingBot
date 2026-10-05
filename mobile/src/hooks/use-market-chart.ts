import {useEffect,useState} from 'react';
import {AppState} from 'react-native';
import {useIsFocused} from 'expo-router/react-navigation';
import {Candle,mergeCandle,parseCandle} from '../lib/chart-data';
export function useMarketChart(provider?:string,coin?:string,interval='5m'){
 const focused=useIsFocused();const [data,setData]=useState<{bars:Candle[];price?:number;status:string;bid?:number;ask?:number}>({bars:[],status:'Choose a market'});
 useEffect(()=>{
  if(!focused||!provider||!coin)return;
  let stopped=false,socket:WebSocket|null=null,retry:ReturnType<typeof setTimeout>|undefined,flush:ReturnType<typeof setTimeout>|undefined,lastEvent=0,bars:Candle[]=[],price:number|undefined,bid:number|undefined,ask:number|undefined;
  function update(status='Live'){if(stopped)return;setData({bars:[...bars],price,status,bid,ask});}
  function connect(){if(stopped||AppState.currentState==='background')return;update('Connecting');socket=new WebSocket('wss://api-stream.myfundedperpetuals.com/v1/market-data');
   socket.onopen=()=>{const identity={providers:[provider],symbols:[coin]};for(const [id,channel] of ['ticks','books','candles'].entries())socket?.send(JSON.stringify({op:'sub',id:id+1,channel,payload:channel==='candles'?{...identity,intervals:[interval],historyLimit:70}:identity}));};
   socket.onmessage=message=>{try{const frame=JSON.parse(String(message.data));if(frame.op==='sub_err'||frame.op==='err'){update('Feed error');return;}let changed=false;for(const wrapper of frame.events??[]){const raw=wrapper.candle??wrapper.tick??wrapper.book??wrapper;if(raw.provider&&String(raw.provider).toLowerCase()!==provider!.toLowerCase()||raw.symbol&&String(raw.symbol).toUpperCase()!==coin!.toUpperCase())continue;
    if(raw.openTime!=null){if(raw.interval&&raw.interval!==interval)continue;const bar=parseCandle(raw);if(!bar)continue;bars=mergeCandle(bars,bar);if(bar.time===bars.at(-1)?.time)price=bar.close;changed=true;}
    else if(Array.isArray(raw.bids)&&Array.isArray(raw.asks)){const b=Number(raw.bids[0]?.px??raw.bids[0]?.price??raw.bids[0]?.[0]),a=Number(raw.asks[0]?.px??raw.asks[0]?.price??raw.asks[0]?.[0]);if(Number.isFinite(b)&&b>0)bid=b;if(Number.isFinite(a)&&a>0)ask=a;changed=true;}
    else if(raw.price!=null){const value=Number(raw.price);if(!Number.isFinite(value)||value<=0)continue;price=value;changed=true;}
   }if(changed){lastEvent=Date.now();if(!flush)flush=setTimeout(()=>{update();flush=undefined;},300);}}catch{/* Ignore malformed frames. */}};
   socket.onclose=()=>{socket=null;if(!stopped){update('Reconnecting');retry=setTimeout(connect,2500);}};socket.onerror=()=>update('Feed unavailable');
  }
  const watchdog=setInterval(()=>{if(lastEvent&&Date.now()-lastEvent>30000&&AppState.currentState==='active')update('Price may be stale');},5000);
  connect();const listener=AppState.addEventListener('change',state=>{if(state==='active'){if(!socket)connect();}else{if(retry)clearTimeout(retry);if(socket){socket.onclose=null;socket.close();socket=null;}update('Paused');}});
  return()=>{stopped=true;listener.remove();clearInterval(watchdog);if(retry)clearTimeout(retry);if(flush)clearTimeout(flush);if(socket){socket.onclose=null;socket.close();}};
 },[provider,coin,interval,focused]);return data;
}
