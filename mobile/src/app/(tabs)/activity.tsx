import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused } from 'expo-router/react-navigation';
import { useSession } from '../../../App';
type Position={id:string;symbol:string;coin:string;provider:string;side:'long'|'short';size:number;entry_price:number;leverage:number;markPrice?:number;estimatedCloseFee?:number;estimatedUnrealizedPnl?:number;realized_pnl?:number;exit_price?:number;closed_at?:number;fees?:number};
type Data={accountId:string;open:Position[];closed:Position[];updatedAt:string;refreshSeconds:number};
type Quote={id:string;symbol:string;percent:number;size?:number;originalSize:number;expectedPrice:number;estimatedFee?:number;expiresAt:number};
const money=(v?:number)=>typeof v==='number'&&Number.isFinite(v)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v):'Unavailable';
export default function Activity(){
 const {token,request}=useSession(),focused=useIsFocused();
 const [data,setData]=useState<Data|null>(null),[tab,setTab]=useState<'open'|'closed'>('open'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[action,setAction]=useState(false),[notice,setNotice]=useState(''),[feed,setFeed]=useState<Record<string,number>>({}),[live,setLive]=useState(false);
 const refresh=useRef<(()=>Promise<void>)|null>(null),pending=useRef(false);
 useEffect(()=>{
  if(!focused)return;let mounted=true,inFlight=false,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){if(inFlight||!mounted||AppState.currentState==='background')return;inFlight=true;setBusy(true);try{const result=await request('activity','GET',undefined,token);if(mounted){setData(result);setError('');}}catch(e){if(mounted)setError(e instanceof Error?e.message:'Could not refresh positions.');}finally{inFlight=false;if(mounted){setBusy(false);if(timer)clearTimeout(timer);timer=setTimeout(()=>void load(),20000);}}}
  refresh.current=load;void load();const listener=AppState.addEventListener('change',state=>{if(state==='active')void load();else if(timer)clearTimeout(timer);});
  return()=>{mounted=false;refresh.current=null;listener.remove();if(timer)clearTimeout(timer);};
 },[focused,token,request]);
 const subscriptions=JSON.stringify(data?.open.map(p=>({provider:p.provider,coin:p.coin}))??[]);
 useEffect(()=>{
  if(!focused||tab!=='open')return;
  const positions: {provider:string;coin:string}[]=JSON.parse(subscriptions);if(!positions.length)return;
  let stopped=false,socket:WebSocket|null=null,retry:ReturnType<typeof setTimeout>|undefined,flush:ReturnType<typeof setTimeout>|undefined;
  const prices:Record<string,number>={},ranks:Record<string,number>={};
  function connect(){if(stopped||AppState.currentState==='background')return;socket=new WebSocket('wss://api-stream.myfundedperpetuals.com/v1/market-data');
   socket.onopen=()=>{let id=500;const groups=new Map<string,string[]>();for(const p of positions){if(!p.provider||!p.coin)continue;const symbols=groups.get(p.provider)??[];if(!symbols.includes(p.coin))symbols.push(p.coin);groups.set(p.provider,symbols);}for(const [provider,symbols]of groups)for(let i=0;i<symbols.length;i+=32)socket?.send(JSON.stringify({op:'sub',id:id++,channel:'ticks',payload:{symbols:symbols.slice(i,i+32),providers:[provider]}}));};
   socket.onmessage=message=>{try{const frame=JSON.parse(String(message.data));let changed=false;for(const raw of frame.events??[]){const e=raw.tick??raw;if(!e.provider||!e.symbol||e.price==null||!Number.isFinite(Number(e.price)))continue;const key=`${String(e.provider).toLowerCase()}|${String(e.symbol).toUpperCase()}`,rank=({last:1,mid:2,mark:3} as Record<string,number>)[e.kind]??0;if(rank<(ranks[key]??0))continue;prices[key]=Number(e.price);ranks[key]=rank;changed=true;}
    if(changed&&!flush)flush=setTimeout(()=>{if(!stopped){setFeed({...prices});setLive(true);}flush=undefined;},500);
   }catch{/* Ignore malformed public frames. */}};
   socket.onclose=()=>{socket=null;if(!stopped){setLive(false);retry=setTimeout(connect,3000);}};socket.onerror=()=>setLive(false);
  }
  connect();const listener=AppState.addEventListener('change',state=>{if(state==='active'){if(!socket)connect();}else{if(retry)clearTimeout(retry);if(socket){socket.onclose=null;socket.close();socket=null;}setLive(false);}});
  return()=>{stopped=true;listener.remove();if(retry)clearTimeout(retry);if(flush)clearTimeout(flush);socket?.close();};
 },[focused,tab,subscriptions]);
 async function prepareClose(position:Position,percent:number){
  if(pending.current)return;pending.current=true;setAction(true);setError('');setNotice('');
  try{const result=await request('close/quote','POST',{positionId:position.id,percent},token),ticket:Quote=result.ticket;
   Alert.alert(`${result.dryRun?'Dry run: ':''}Close ${percent}% of ${ticket.symbol}?`,`Size: ${ticket.size??ticket.originalSize}\nEstimated price: ${money(ticket.expectedPrice)}\nEstimated close fee: ${money(ticket.estimatedFee)}\n\n${result.dryRun?'No order will be sent.':'This sends a reduce-only market close. MFP may resize or cancel working TP/SL orders.'}`,[{text:'Keep position',style:'cancel'},{text:result.dryRun?'Validate':'Confirm close',style:'destructive',onPress:()=>void confirmClose(ticket)}]);
  }catch(e){setError(e instanceof Error?e.message:'Could not quote close.');}
  finally{pending.current=false;setAction(false);}
 }
 async function confirmClose(ticket:Quote){
  // The clock check runs only when the user confirms the close.
  // eslint-disable-next-line react-hooks/purity
  if(pending.current)return;if(Date.now()>=ticket.expiresAt){setError('Close quote expired. Review a new close quote.');return;}
  pending.current=true;setAction(true);setError('');
  try{const result=await request('close/confirm','POST',{ticketId:ticket.id},token);setNotice(result.dryRun?'Dry run validated. Position remains open.':`Close submitted. Status: ${result.status}. Awaiting MFP confirmation.`);await refresh.current?.();}
  catch(e){setError(`${e instanceof Error?e.message:'Could not confirm close.'} Check MyFundedPerps before attempting another close.`);}
  finally{pending.current=false;setAction(false);}
 }
 const positions=data?.[tab]??[];
 return <SafeAreaView style={styles.page} edges={['top']}><ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={busy} onRefresh={()=>void refresh.current?.()} tintColor="#2dcc98"/>}>
  <Text style={styles.heading}>Activity</Text><View style={styles.row}>{(['open','closed'] as const).map(value=><Pressable accessibilityRole="button" accessibilityState={{selected:tab===value}} key={value} onPress={()=>setTab(value)} style={[styles.toggle,tab===value&&styles.selected]}><Text style={styles.value}>{value==='open'?'Open positions':'Closed positions'}</Text></Pressable>)}</View>
  {!!notice&&<Text accessibilityRole="alert" style={styles.green}>{notice}</Text>}{!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}{data?' Showing last received data.':''}</Text>}
  {!data&&busy&&<ActivityIndicator color="#2dcc98"/>}
  {data&&!positions.length&&<Text style={styles.copy}>{tab==='open'?'No open positions on this account.':'No closed positions returned for this account.'}</Text>}
  {positions.map(p=>{const mark=feed[`${p.provider?.toLowerCase()}|${p.coin?.toUpperCase()}`]??p.markPrice,pnl=tab==='closed'?p.realized_pnl:mark!==undefined?(mark-p.entry_price)*Math.abs(p.size)*(p.side==='long'?1:-1):p.estimatedUnrealizedPnl;return <View key={p.id} style={styles.card}>
   <View style={styles.row}><Text style={styles.symbol}>{p.symbol??p.coin}</Text><Text style={styles.copy}>{p.side.toUpperCase()} · {p.leverage}x</Text></View>
   <Text style={[styles.pnl,{color:pnl===undefined?'#a9bbb2':pnl>=0?'#71e6b8':'#ff9c9c'}]}>{money(pnl)}</Text>
   <Text style={styles.small}>{tab==='closed'?'MFP reported realized P&L':live?'Estimated P&L from live market prices':'Estimated P&L from last received price'}</Text>
   <View style={styles.row}><Text style={styles.copy}>Entry</Text><Text style={styles.value}>{money(p.entry_price)}</Text></View>
   <View style={styles.row}><Text style={styles.copy}>{tab==='open'?'Mark / mid':'Exit'}</Text><Text style={styles.value}>{money(tab==='open'?mark:p.exit_price)}</Text></View>
   <View style={styles.row}><Text style={styles.copy}>{tab==='open'?'Estimated close fee':'Reported fees'}</Text><Text style={styles.value}>{money(tab==='open'?p.estimatedCloseFee:p.fees)}</Text></View>
   <Text style={styles.small}>Size {p.size}</Text>
   <Pressable accessibilityRole="button" disabled={action} onPress={()=>router.push({pathname:tab==='open'?'/protection':'/share-card',params:{positionId:p.id}})}><Text style={styles.green}>{tab==='open'?'Edit TP/SL':'Create share card'}</Text></Pressable>
   {tab==='open'?<View style={styles.row}>{[25,50,100].map(percent=><Pressable key={percent} accessibilityRole="button" disabled={action||busy} style={styles.close} onPress={()=>void prepareClose(p,percent)}><Text style={styles.value}>{percent===100?'Close all':`Close ${percent}%`}</Text></Pressable>)}</View>:p.closed_at!=null&&<Text style={styles.small}>{new Date(p.closed_at<1e10?p.closed_at*1000:p.closed_at).toLocaleString()}</Text>}
  </View>})}
  {data&&<Text style={styles.small}>{tab==='closed'?'Latest 50 closed positions. ':''}Account data updated {new Date(data.updatedAt).toLocaleTimeString()}.</Text>}
  {action&&<ActivityIndicator color="#2dcc98"/>}<Pressable accessibilityRole="button" disabled={busy} onPress={()=>void refresh.current?.()}><Text style={styles.green}>Refresh positions</Text></Pressable>
 </ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e'},content:{padding:20,gap:16,paddingBottom:32},heading:{fontSize:28,fontWeight:'700',color:'#f4f8f5'},row:{flexDirection:'row',justifyContent:'space-between',gap:10,alignItems:'center'},copy:{color:'#a9bbb2',fontSize:14,lineHeight:22},value:{color:'#f4f8f5',fontSize:14,fontWeight:'600',flexShrink:1},small:{color:'#82968b',fontSize:12,lineHeight:19},toggle:{flex:1,padding:14,borderRadius:12,borderWidth:1,borderColor:'#284237',alignItems:'center'},selected:{backgroundColor:'#12392a',borderColor:'#2dcc98'},green:{color:'#71e6b8',paddingVertical:8,lineHeight:23},error:{color:'#ff9c9c',lineHeight:23},card:{backgroundColor:'#12261c',padding:18,borderRadius:16,gap:14},symbol:{color:'#f4f8f5',fontSize:23,fontWeight:'700'},pnl:{fontSize:30,fontWeight:'600'},close:{flex:1,paddingVertical:14,borderWidth:1,borderColor:'#345247',borderRadius:10,alignItems:'center'}});
