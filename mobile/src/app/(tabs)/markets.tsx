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
 const [view,setView]=useState<'list'|'heatmap'>('list');
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
 const price=(v?:number)=>v===undefined?'Waiting for price':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:v<10?5:2}).format(v);
 const change=(v?:number)=>v===undefined?'Waiting':`${v>=0?'+':''}${v.toFixed(2)}%`;
 const tone=(v?:number)=>v===undefined?'#95aa9e':v>=0?'#71e6b8':'#ff9c9c';
 function open(m:Market){router.push({pathname:'/trade',params:{marketId:m.id}});}
 return <SafeAreaView style={styles.page} edges={['top']}>
 <View style={styles.header}><View><Text style={styles.heading}>Markets</Text><Text style={styles.copy}>{filtered.length} markets · Live prices</Text></View><Text style={styles.status}>{status}</Text></View>
 <TextInput accessibilityLabel="Search markets" value={query} onChangeText={setQuery} placeholder="Search markets" placeholderTextColor="#82968b" style={styles.search} autoCorrect={false}/>
 <View style={styles.header}><View style={styles.toggle}>{(['list','heatmap'] as const).map(v=><Pressable key={v} accessibilityRole="button" accessibilityState={{selected:view===v}} onPress={()=>setView(v)} style={[styles.option,view===v&&styles.selected]}><Text style={styles.label}>{v==='list'?'List':'Heatmap'}</Text></Pressable>)}</View><Pressable accessibilityRole="button" accessibilityLabel="Change market sorting" onPress={()=>setSort(sort==='oi'?'change':sort==='change'?'name':'oi')} style={styles.sort}><Text style={styles.label}>{sort==='oi'?'Open interest ↓':sort==='change'?'24h change ↓':'Name A–Z'}</Text></Pressable></View>
 {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
 {!markets&&busy?<ActivityIndicator color="#2dcc98"/>:view==='list'?<FlatList showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} data={filtered} keyExtractor={m=>m.id} refreshControl={<RefreshControl refreshing={busy} onRefresh={()=>void load()} tintColor="#2dcc98"/>} contentContainerStyle={styles.list} ListEmptyComponent={<Text style={styles.copy}>No matching markets.</Text>} renderItem={({item})=>{const stat=feed[key(item)]??{};return <Pressable accessibilityRole="button" accessibilityLabel={`${item.symbol}, open chart and trade`} onPress={()=>open(item)} style={styles.marketRow}><View style={styles.identity}><View style={[styles.dot,{backgroundColor:tone(stat.change)}]}/><View><Text style={styles.symbol}>{item.symbol}</Text><Text style={styles.copy}>{stat.openInterest!==undefined?`OI $${compact(stat.openInterest)}`:item.provider}</Text></View></View><View style={styles.quote}><Text style={styles.price}>{price(stat.price)}</Text><Text style={[styles.change,{color:tone(stat.change),backgroundColor:tileColor(stat.change)}]}>{change(stat.change)}</Text></View></Pressable>;}}/>:<FlatList showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} data={rows} keyExtractor={row=>row.map(m=>m.id).join(',')} refreshControl={<RefreshControl refreshing={busy} onRefresh={()=>void load()} tintColor="#2dcc98"/>} contentContainerStyle={styles.list} ListEmptyComponent={<Text style={styles.copy}>No matching markets.</Text>} renderItem={({item:row})=><View style={styles.row}>{row.map(item=>{const stat=feed[key(item)]??{};return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.symbol}, open chart and trade`} onPress={()=>open(item)} style={[styles.tile,{backgroundColor:tileColor(stat.change)}]}><Text style={styles.tileSymbol} numberOfLines={1} adjustsFontSizeToFit>{item.symbol}</Text><Text style={[styles.tileChange,{color:tone(stat.change)}]}>{change(stat.change)}</Text><Text style={styles.copy} numberOfLines={1}>{price(stat.price)}</Text></Pressable>;})}{row.length===1&&<View style={{flex:1}}/>}</View>}/>}
 </SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e',padding:20,gap:16},header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},heading:{fontSize:30,fontWeight:'700',color:'#f4f8f5',marginBottom:4},status:{color:'#2dcc98',fontSize:12},search:{padding:14,color:'#f4f8f5',backgroundColor:'#12231b',borderRadius:14,fontSize:16},toggle:{flexDirection:'row',padding:3,backgroundColor:'#12231b',borderRadius:12},option:{paddingHorizontal:14,paddingVertical:10,borderRadius:9},selected:{backgroundColor:'#24533e'},sort:{paddingVertical:12},label:{color:'#d7e4dc',fontSize:12,fontWeight:'600'},list:{paddingBottom:24,gap:10},marketRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:16,borderBottomWidth:1,borderBottomColor:'#1c3025',gap:10},identity:{flexDirection:'row',gap:12,alignItems:'center',flex:1},dot:{width:7,height:7,borderRadius:4},symbol:{color:'#f4f8f5',fontSize:18,fontWeight:'600',marginBottom:5},quote:{alignItems:'flex-end',gap:6},price:{color:'#f4f8f5',fontSize:16,fontVariant:['tabular-nums']},change:{fontSize:12,fontWeight:'600',paddingHorizontal:9,paddingVertical:5,borderRadius:7,fontVariant:['tabular-nums']},copy:{color:'#91a79a',fontSize:12,lineHeight:18},row:{flexDirection:'row',gap:10},tile:{flex:1,minWidth:0,minHeight:126,padding:16,borderRadius:16,gap:9,justifyContent:'center'},tileSymbol:{fontSize:21,fontWeight:'700',color:'#f4f8f5'},tileChange:{fontSize:20,fontWeight:'600',fontVariant:['tabular-nums']},error:{color:'#ff9c9c'}});
