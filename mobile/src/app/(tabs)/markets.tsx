import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused } from 'expo-router/react-navigation';
import { useSession } from '../../../App';
type Market={id:string;symbol:string;coin:string;provider:string;maxLeverage?:number};
type Stat={price?:number;change?:number;kind?:string};
const finite=(v:unknown)=>v!=null&&Number.isFinite(Number(v))?Number(v):undefined;
export default function Markets(){
 const {request,token}=useSession(),focused=useIsFocused();
 const [markets,setMarkets]=useState<Market[]|null>(null),[error,setError]=useState(''),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('Connecting'),[feed,setFeed]=useState<Record<string,Stat>>({});
 const load=useCallback(async()=>{setBusy(true);try{setMarkets((await request('markets','GET',undefined,token)).markets);setError('');}catch(e){setError(e instanceof Error?e.message:'Could not load markets.');}finally{setBusy(false);}},[request,token]);
 // Asynchronous market loading updates the screen after the request resolves.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{void load();},[load]);
 useEffect(()=>{
  if(!focused||!markets?.length)return;
  let stopped=false,socket:WebSocket|null=null,retry:ReturnType<typeof setTimeout>|undefined,flush:ReturnType<typeof setTimeout>|undefined;
  const latest:Record<string,Stat>={};
  function connect(){
   if(stopped||AppState.currentState==='background')return;
   setStatus('Connecting');socket=new WebSocket('wss://api-stream.myfundedperpetuals.com/v1/market-data');
   socket.onopen=()=>{let id=100;const groups=new Map<string,string[]>();for(const m of markets!){const symbols=groups.get(m.provider)||[];if(!symbols.includes(m.coin))symbols.push(m.coin);groups.set(m.provider,symbols);}for(const [provider,symbols]of groups)for(let i=0;i<symbols.length;i+=32)for(const channel of ['ticks','marketStats'])socket?.send(JSON.stringify({op:'sub',id:id++,channel,payload:{symbols:symbols.slice(i,i+32),providers:[provider]}}));};
   socket.onmessage=message=>{try{const frame=JSON.parse(String(message.data));if(frame.op==='sub_ok')setStatus('Live');if(frame.op==='sub_err'||frame.op==='err')setStatus('Partial feed');for(const raw of frame.events||[]){const event=raw.tick||raw.marketStats||raw;if(!event.provider||!event.symbol)continue;const key=`${String(event.provider).toLowerCase()}|${String(event.symbol).toUpperCase()}`,stat=latest[key]||{};
    if(event.price!=null){const rank:Record<string,number>={last:1,mid:2,mark:3};if(!stat.kind||(rank[event.kind]||0)>=(rank[stat.kind]||0)){stat.price=finite(event.price);stat.kind=event.kind;}}
    if(event.change24hPct!==undefined)stat.change=finite(event.change24hPct);if(stat.price===undefined&&event.markPx!=null)stat.price=finite(event.markPx);latest[key]=stat;}
    if(!flush)flush=setTimeout(()=>{if(!stopped)setFeed({...latest});flush=undefined;},500);
   }catch{/* Ignore malformed public feed frames. */}};
   socket.onclose=()=>{socket=null;if(!stopped){setStatus('Reconnecting');retry=setTimeout(connect,3000);}};socket.onerror=()=>setStatus('Feed unavailable');
  }
  connect();const listener=AppState.addEventListener('change',state=>{if(state==='active'){if(!socket)connect();}else{if(retry)clearTimeout(retry);if(socket){socket.onclose=null;socket.close();socket=null;}setStatus('Paused');}});
  return()=>{stopped=true;listener.remove();if(retry)clearTimeout(retry);if(flush)clearTimeout(flush);socket?.close();};
 },[markets,focused]);
 const filtered=(markets??[]).filter(m=>`${m.symbol} ${m.coin} ${m.provider}`.toLowerCase().includes(query.toLowerCase()));
 return <SafeAreaView style={styles.page} edges={['top']}>
  <View style={styles.header}><Text style={styles.heading}>Markets</Text><Text style={styles.status}>{status}</Text></View>
  <TextInput accessibilityLabel="Search markets" value={query} onChangeText={setQuery} placeholder="Search BTC, gold, forex…" placeholderTextColor="#82968b" style={styles.search} autoCorrect={false}/>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!markets&&busy?<ActivityIndicator color="#2dcc98"/>:<FlatList data={filtered} numColumns={2} keyExtractor={m=>m.id} columnWrapperStyle={styles.row} contentContainerStyle={styles.list} refreshControl={<RefreshControl refreshing={busy} onRefresh={()=>void load()} tintColor="#2dcc98"/>} ListEmptyComponent={<Text style={styles.copy}>{markets?'No matching markets. Try another search.':'Pull down to retry loading markets.'}</Text>} renderItem={({item})=>{const stat=feed[`${item.provider.toLowerCase()}|${item.coin.toUpperCase()}`]||{};return <View style={[styles.tile,stat.change!==undefined&&{backgroundColor:stat.change>=0?'#12392a':'#392326'}]}>
   <Text style={styles.symbol} adjustsFontSizeToFit numberOfLines={1}>{item.symbol}</Text><Text style={styles.provider}>{item.provider}</Text>
   <Text style={styles.price}>{stat.price!==undefined?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:stat.price<10?5:2}).format(stat.price):'Waiting for price'}</Text>
   <Text style={[styles.change,{color:stat.change===undefined?'#82968b':stat.change>=0?'#71e6b8':'#ff9c9c'}]}>{stat.change!==undefined?`${stat.change>=0?'+':''}${stat.change.toFixed(2)}%`:'24h change unavailable'}</Text>
   {item.maxLeverage!==undefined&&<Text style={styles.provider}>Up to {item.maxLeverage}x</Text>}
  </View>}}/>}
 </SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e',padding:20,gap:16},header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},heading:{fontSize:28,fontWeight:'700',color:'#f4f8f5'},status:{color:'#2dcc98',fontSize:13},search:{padding:15,color:'#f4f8f5',backgroundColor:'#12261c',borderRadius:12,fontSize:16},row:{gap:12},list:{gap:12,paddingBottom:24},tile:{flex:1,maxWidth:'50%',minHeight:160,padding:16,borderRadius:16,gap:9,justifyContent:'center'},symbol:{fontSize:24,fontWeight:'700',color:'#f4f8f5'},provider:{fontSize:12,color:'#a9bbb2'},price:{fontSize:16,color:'#f4f8f5'},change:{fontSize:15,fontWeight:'600'},copy:{color:'#a9bbb2',fontSize:16},error:{color:'#ff9c9c'}});
