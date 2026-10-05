import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused } from 'expo-router/react-navigation';
import { useSession } from '../../../App';
type Item={id:string;kind:string;title:string;body:string;sourceName?:string;sourceUrl?:string;publishedAt:string};
export default function Pulse(){
 const {token,request}=useSession(),focused=useIsFocused();
 const [items,setItems]=useState<Item[]>([]),[filter,setFilter]=useState('all'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const refresh=useRef<(()=>Promise<void>)|null>(null);
 useEffect(()=>{
  if(!focused)return;let mounted=true,inFlight=false,timer:ReturnType<typeof setTimeout>|undefined;
  async function load(){if(!mounted||inFlight||AppState.currentState==='background')return;inFlight=true;setBusy(true);try{const result=await request('pulse','GET',undefined,token);if(mounted){setItems(result.items);setLoaded(true);setError('');}}catch(e){if(mounted)setError(e instanceof Error?e.message:'Could not refresh Pulse.');}finally{inFlight=false;if(mounted){setBusy(false);if(timer)clearTimeout(timer);timer=setTimeout(()=>void load(),60000);}}}
  refresh.current=load;void load();const listener=AppState.addEventListener('change',state=>{if(state==='active')void load();else if(timer)clearTimeout(timer);});
  return()=>{mounted=false;refresh.current=null;listener.remove();if(timer)clearTimeout(timer);};
 },[focused,token,request]);
 async function open(url:string){try{const parsed=new URL(url);if(parsed.protocol!=='https:')throw new Error('Invalid source link');await Linking.openURL(url);}catch{setError('Could not open this source link.');}}
 const visible=items.filter(item=>filter==='all'||(filter==='news'?item.kind==='news':item.kind!=='news'));
 return <SafeAreaView style={styles.page} edges={['top']}><FlatList data={visible} keyExtractor={item=>item.id} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={busy} onRefresh={()=>void refresh.current?.()} tintColor="#2dcc98"/>}
 ListHeaderComponent={<View><Text style={styles.heading}>Pulse</Text><Text style={styles.copy}>Market alerts and crypto headlines, in one place.</Text><Text style={styles.small}>Headlines are news, not trading signals. Alerts describe market moves without claiming what caused them.</Text><View style={styles.filters}>{['all','news','alerts'].map(value=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:filter===value}} style={[styles.filter,filter===value&&styles.selected]} onPress={()=>setFilter(value)}><Text style={styles.value}>{value[0].toUpperCase()+value.slice(1)}</Text></Pressable>)}</View>{!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}{loaded?' Showing last received feed.':''}</Text>}</View>}
 ListEmptyComponent={busy&&!loaded?<ActivityIndicator color="#2dcc98"/>:<Text style={styles.copy}>{loaded?'No recent items in this view. Pull to refresh.':'Pull to load Pulse.'}</Text>}
 renderItem={({item})=><View style={styles.card}><Text style={styles.tag}>{item.kind==='news'?'NEWS':item.kind==='brief'?'MARKET BRIEF':'MARKET ALERT'}</Text><Text style={styles.title}>{item.title}</Text>{!!item.body&&<Text style={styles.copy}>{item.body.split('\n').slice(1).join('\n').trim()}</Text>}<Text style={styles.small}>{item.sourceName??'Funded Guardian'} · {new Date(item.publishedAt).toLocaleString()}</Text>{!!item.sourceUrl&&<Pressable accessibilityRole="link" onPress={()=>void open(item.sourceUrl!)}><Text style={styles.link}>Read original article ↗</Text></Pressable>}</View>}/></SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e'},content:{padding:20,gap:14,paddingBottom:32},heading:{color:'#f1f7f4',fontSize:30,fontWeight:'700',marginBottom:8},copy:{color:'#b6c7bd',fontSize:16,lineHeight:23},small:{color:'#8ea89a',fontSize:12,lineHeight:18,marginTop:10},filters:{flexDirection:'row',gap:8,marginVertical:18},filter:{paddingVertical:12,paddingHorizontal:20,borderRadius:22,backgroundColor:'#14271e'},selected:{backgroundColor:'#24533e'},value:{color:'#f1f7f4',fontWeight:'600'},card:{backgroundColor:'#102219',borderRadius:20,padding:18,gap:9},tag:{color:'#2dcc98',fontSize:12,fontWeight:'700'},title:{color:'#f1f7f4',fontSize:19,fontWeight:'600',lineHeight:26},link:{color:'#2dcc98',fontWeight:'600',paddingVertical:10},error:{color:'#ff9c9c',marginBottom:16}});
