import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, RefreshControl, StyleSheet, Text, TextInput, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused } from 'expo-router/react-navigation';
import { useSession } from '../../../App';
type Market={id:string;symbol:string;coin:string;provider:string;maxLeverage?:number};
type Stat={price?:number;change?:number;kind?:string;openInterest?:number;volume?:number};
const finite=(v:unknown)=>v!=null&&Number.isFinite(Number(v))?Number(v):undefined;
export default function Markets(){
 const {request,token}=useSession(),focused=useIsFocused();
 const [markets,setMarkets]=useState<Market[]|null>(null),[error,setError]=useState(''),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('Connecting'),[feed,setFeed]=useState<Record<string,Stat>>({}),[sort,setSort]=useState<'oi'|'change'|'name'>('oi');
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
    if(event.change24hPct!==undefined)stat.change=finite(event.change24hPct);if(event.openInterestUsd!==undefined)stat.openInterest=finite(event.openInterestUsd);if(event.dayNtlVlm!==undefined)stat.volume=finite(event.dayNtlVlm);if(stat.price===undefined&&event.markPx!=null)stat.price=finite(event.markPx);latest[key]=stat;}
    if(!flush)flush=setTimeout(()=>{if(!stopped)setFeed({...latest});flush=undefined;},500);
   }catch{/* Ignore malformed public feed frames. */}};
   socket.onclose=()=>{socket=null;if(!stopped){setStatus('Reconnecting');retry=setTimeout(connect,3000);}};socket.onerror=()=>setStatus('Feed unavailable');
  }
  connect();const listener=AppState.addEventListener('change',state=>{if(state==='active'){if(!socket)connect();}else{if(retry)clearTimeout(retry);if(socket){socket.onclose=null;socket.close();socket=null;}setStatus('Paused');}});
  return()=>{stopped=true;listener.remove();if(retry)clearTimeout(retry);if(flush)clearTimeout(flush);socket?.close();};
 },[markets,focused]);
 const key=(m:Market)=>`${m.provider.toLowerCase()}|${m.coin.toUpperCase()}`;
 const filtered=(markets??[]).filter(m=>`${m.symbol} ${m.coin} ${m.provider}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sort==='name'?a.symbol.localeCompare(b.symbol):(sort==='oi'?(feed[key(b)]?.openInterest??-1)-(feed[key(a)]?.openInterest??-1):(feed[key(b)]?.change??-Infinity)-(feed[key(a)]?.change??-Infinity))||a.id.localeCompare(b.id));
 const rows:Market[][]=[];for(let i=0;i<filtered.length;i+=2)rows.push(filtered.slice(i,i+2));
 const compact=(v?:number)=>v===undefined?'Unavailable':new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(v);
 function tileColor(change?:number){if(change===undefined)return '#172a21';const amount=Math.min(1,Math.abs(change)/8);return change>=0?`rgb(${Math.round(18+amount*10)},${Math.round(50+amount*62)},${Math.round(39+amount*40)})`:`rgb(${Math.round(52+amount*75)},${Math.round(32+amount*7)},${Math.round(38+amount*18)})`;}
 return <SafeAreaView style={styles.page} edges={['top']}>
  <View style={styles.header}><Text style={styles.heading}>Markets</Text><Text style={styles.status}>{status}</Text></View>
  <TextInput accessibilityLabel="Search markets" value={query} onChangeText={setQuery} placeholder="Search BTC, gold, forex…" placeholderTextColor="#82968b" style={styles.search} autoCorrect={false}/>
  <View style={styles.header}>{(['oi','change','name'] as const).map(value=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:sort===value}} onPress={()=>setSort(value)} style={[styles.sort,sort===value&&{backgroundColor:'#24533e'}]}><Text style={styles.provider}>{value==='oi'?'Open interest':value==='change'?'Top gainers':'A to Z'}</Text></Pressable>)}</View>
  <Text style={styles.copy}>{filtered.length} markets · Color shows 24h change. Tap to chart and trade.</Text>
  {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  {!markets&&busy?<ActivityIndicator color="#2dcc98"/>:<FlatList data={rows} keyExtractor={row=>row.map(m=>m.id).join(',')} contentContainerStyle={styles.list} refreshControl={<RefreshControl refreshing={busy} onRefresh={()=>void load()} tintColor="#2dcc98"/>} ListEmptyComponent={<Text style={styles.copy}>{markets?'No matching markets. Try another search.':'Pull down to retry loading markets.'}</Text>} renderItem={({item:row,index})=>{const weights=row.map(m=>Math.sqrt(Math.max(0,feed[key(m)]?.openInterest??0))),total=weights.reduce((a,b)=>a+b,0),share=total?Math.max(.38,Math.min(.62,weights[0]/total)):.5;return <View style={styles.row}>{row.map((item,i)=>{const stat=feed[key(item)]??{};return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.symbol}, ${item.provider}, open chart`} onPress={()=>router.push({pathname:'/trade',params:{marketId:item.id}})} style={[styles.tile,{flex:row.length===1?1:sort==='oi'?(i===0?share:1-share):1,minHeight:index===0?190:148,backgroundColor:tileColor(stat.change)}]}>
   <View style={styles.monogram}><Text style={styles.badge}>{item.symbol.slice(0,4)}</Text></View>
   <Text style={styles.symbol} adjustsFontSizeToFit minimumFontScale={.6} numberOfLines={1}>{item.symbol}</Text>
   <Text style={[styles.change,{color:stat.change===undefined?'#82968b':stat.change>=0?'#71e6b8':'#ff9c9c'}]}>{stat.change!==undefined?`${stat.change>=0?'+':''}${stat.change.toFixed(2)}%`:'24h unavailable'}</Text>
   <Text style={styles.price}>{stat.price!==undefined?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:stat.price<10?5:2}).format(stat.price):'Waiting for price'}</Text>
   <Text style={styles.provider}>OI {stat.openInterest===undefined?'unavailable':`$${compact(stat.openInterest)}`}</Text><Text style={styles.provider}>{item.provider}</Text>
  </Pressable>;})}</View>;}}/>}
 </SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e',padding:18,gap:12},header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:8},heading:{fontSize:28,fontWeight:'700',color:'#f4f8f5'},status:{color:'#2dcc98',fontSize:13},search:{padding:15,color:'#f4f8f5',backgroundColor:'#12261c',borderRadius:12,fontSize:16},sort:{padding:12,borderRadius:12,backgroundColor:'#14271e',flex:1,alignItems:'center'},row:{flexDirection:'row',gap:8},list:{gap:8,paddingBottom:24},tile:{padding:14,borderRadius:16,gap:8,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'#284237',overflow:'hidden'},monogram:{width:34,height:34,borderRadius:17,backgroundColor:'#091810',justifyContent:'center',alignItems:'center'},badge:{fontSize:10,fontWeight:'700',color:'#f4f8f5'},symbol:{fontSize:25,fontWeight:'700',color:'#f4f8f5',alignSelf:'stretch',textAlign:'center'},provider:{fontSize:11,color:'#b1c6b9'},price:{fontSize:14,color:'#f4f8f5',fontVariant:['tabular-nums']},change:{fontSize:18,fontWeight:'700',fontVariant:['tabular-nums']},copy:{color:'#a9bbb2',fontSize:12,lineHeight:18},error:{color:'#ff9c9c'}});
