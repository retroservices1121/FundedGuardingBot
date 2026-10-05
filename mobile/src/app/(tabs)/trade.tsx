import { useIsFocused } from 'expo-router/react-navigation';
import { Link, useLocalSearchParams } from 'expo-router';
import MarketChart from '../../components/market-chart';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../../../App';
type Market={id:string;symbol:string;coin:string;provider:string;maxLeverage?:number};
type Ticket={id:string;symbol:string;side:string;riskUsd:number;size:number;expectedPrice:number;stopLossPrice:number;takeProfitPrice:number;estimatedNotional:number;estimatedFee?:number;leverage:number;expiresAt:number;platformRules?:{warnings:string[];estimatedMargin?:number}};
const money=(v?:number)=>typeof v==='number'&&Number.isFinite(v)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v):'Unavailable';
export default function Trade(){
 const focused=useIsFocused();
 const {request,token}=useSession(),params=useLocalSearchParams<{marketId?:string}>();
 const [markets,setMarkets]=useState<Market[]|null>(null),[marketId,setMarketId]=useState(params.marketId??''),[search,setSearch]=useState(''),[side,setSide]=useState<'buy'|'sell'>('buy');
 const [risk,setRisk]=useState(''),[leverage,setLeverage]=useState(''),[stop,setStop]=useState(''),[reward,setReward]=useState('');
 const [ticket,setTicket]=useState<Ticket|null>(null),[accountName,setAccountName]=useState(''),[dryRun,setDryRun]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(''),[now,setNow]=useState(()=>Date.now());
 const [quickPrefs,setQuickPrefs]=useState<{quickTradeEnabled?:boolean;quickAmounts?:number[]}|null>(null),[quickUncertain,setQuickUncertain]=useState(false);
 const pending=useRef(false),[submitted,setSubmitted]=useState(false);
 useEffect(()=>{let mounted=true;request('markets','GET',undefined,token).then(result=>{if(mounted)setMarkets(result.markets);}).catch(e=>{if(mounted)setError(e.message);});return()=>{mounted=false;};},[request,token]);
 useEffect(()=>{if(!ticket)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[ticket]);
 // Navigation can select another market while this tab remains mounted.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{if(params.marketId){setMarketId(params.marketId);setTicket(null);setSearch('');setError('');}},[params.marketId]);
 useEffect(()=>{if(!focused)return;let mounted=true;request('guards','GET',undefined,token).then(value=>{if(mounted)setQuickPrefs(value);}).catch(()=>{if(mounted)setQuickPrefs(null);});return()=>{mounted=false;};},[request,token,focused]);
 async function quickTrade(amount:number){
  if(pending.current||quickUncertain||!quickPrefs?.quickTradeEnabled)return;
  if(!marketId||![leverage,stop,reward].every(v=>v.trim()&&Number.isFinite(Number(v))&&Number(v)>0)){setError('Choose a market, leverage, stop distance and reward/risk first.');return;}
  pending.current=true;setBusy(true);setError('');setResult('');
  try{const value=await request('trade/quick','POST',{marketId,side,riskUsd:amount,leverage:Number(leverage),stopPercent:Number(stop),rewardRisk:Number(reward)},token);if(value.error)throw new Error(value.error);setResult(`${value.dryRun?'Dry run validated. No order sent.':`Order submitted: ${value.status}. Check MyFundedPerps for the final fill.`}${value.warnings?.length?'\n'+value.warnings.join('\n'):''}`);}
  catch(e){const message=e instanceof Error?e.message:'Submission response unavailable.';setError(message);if(/timeout|timed out|network|fetch|abort|Check MyFundedPerps/i.test(message))setQuickUncertain(true);}
  finally{pending.current=false;setBusy(false);}
 }
 const market=markets?.find(m=>m.id===marketId);
 async function review(){
  if(pending.current)return;pending.current=true;setBusy(true);setError('');setResult('');
  try{const value=await request('trade/quote','POST',{marketId,side,riskUsd:Number(risk),leverage:Number(leverage),stopPercent:Number(stop),rewardRisk:Number(reward)},token);setTicket(value.ticket);setAccountName(value.accountName);setDryRun(value.dryRun);setSubmitted(false);setNow(Date.now());}
  catch(e){setError(e instanceof Error?e.message:'Could not quote trade.');}
  finally{pending.current=false;setBusy(false);}
 }
 async function confirm(){
  if(!ticket||pending.current||submitted)return;pending.current=true;setBusy(true);setError('');setSubmitted(true);
  try{const value=await request('trade/confirm','POST',{ticketId:ticket.id},token);if(value.error)throw new Error(value.error);setResult(value.dryRun?'Dry run validated. No order was sent.':`Order submitted. Status: ${value.status}. Check MyFundedPerps for the final fill.`);setTicket(null);}
  catch(e){setError(e instanceof Error?e.message:'Submission could not be confirmed. Check MyFundedPerps before placing another trade.');}
  finally{pending.current=false;setBusy(false);}
 }
 const expired=!!ticket&&now>=ticket.expiresAt;
 return <SafeAreaView style={styles.page} edges={['top']}><ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
  <Text style={styles.heading}>Trade</Text>
  {!!result&&<Text accessibilityRole="alert" style={styles.success}>{result}</Text>}
  {ticket?<View style={styles.card}>
   <Text style={styles.heading}>{ticket.symbol} {ticket.side==='buy'?'Long':'Short'}</Text><Text style={styles.copy}>{accountName}</Text>
   <Text style={styles.copy}>{dryRun?'Dry run only. No order will be sent.':'Confirmation sends a market order with attached TP and SL.'}</Text>
   {([['Risk at stop',money(ticket.riskUsd)],['Size',String(ticket.size)],['Leverage',`${ticket.leverage}x`],['Estimated entry',money(ticket.expectedPrice)],['Stop loss',money(ticket.stopLossPrice)],['Take profit',money(ticket.takeProfitPrice)],['Potential profit at TP',money(Math.abs(ticket.takeProfitPrice-ticket.expectedPrice)*ticket.size)],['Estimated notional',money(ticket.estimatedNotional)],['Estimated entry fee',money(ticket.estimatedFee)],['Estimated margin + entry fee',money(ticket.platformRules?.estimatedMargin)]] as const).map(([label,value])=><View key={label} style={styles.row}><Text style={styles.copy}>{label}</Text><Text style={styles.value}>{value}</Text></View>)}
   <Text style={styles.small}>Risk at stop excludes fees and slippage. Stop execution may differ from the stop price.</Text>
   {ticket.platformRules?.warnings.map(w=><Text key={w} style={styles.warning}>{w}</Text>)}
   <Text style={styles.copy}>{expired?'Quote expired. Review again.':`Quote expires in ${Math.max(0,Math.ceil((ticket.expiresAt-now)/1000))} seconds.`}</Text>
   <Pressable accessibilityRole="button" disabled={busy||expired||submitted} style={[styles.button,(busy||expired||submitted)&&styles.disabled]} onPress={()=>Alert.alert(dryRun?'Validate dry run?':'Confirm order?',`${ticket.symbol} ${ticket.side==='buy'?'Long':'Short'} on ${accountName}`, [{text:'Cancel',style:'cancel'},{text:dryRun?'Validate':'Submit order',onPress:()=>void confirm()}])}><Text style={styles.buttonText}>{submitted?'Submission attempted':dryRun?'Validate dry run':'Confirm trade'}</Text></Pressable>
   <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setTicket(null);setError('');}}><Text style={styles.link}>Back to trade inputs</Text></Pressable>
  </View>:<>
   <TextInput accessibilityLabel="Search markets" placeholder="Search markets" placeholderTextColor="#82968b" style={styles.input} value={search} onChangeText={setSearch} autoCorrect={false}/>
   {!markets&&<ActivityIndicator color="#2dcc98"/>}
   <Text style={styles.copy}>{market?`Selected: ${market.symbol} (${market.provider})`:'Choose a market'}</Text>
   {market&&<MarketChart key={market.id} provider={market.provider} coin={market.coin}/> }
   <View style={styles.field}><Text style={styles.copy}>{quickPrefs?.quickTradeEnabled?'One-tap risk · sends immediately':'Quick risk · review required'}</Text><View style={styles.row}>{(quickPrefs?.quickAmounts??[10,50,100]).map((amount,i)=><Pressable key={i} accessibilityRole="button" disabled={busy||quickUncertain} style={styles.direction} onPress={()=>quickPrefs?.quickTradeEnabled?void quickTrade(amount):setRisk(String(amount))}><Text style={styles.value}>${amount}</Text></Pressable>)}</View><Link href="/settings" style={styles.link}>Edit quick amounts and one-tap settings</Link>{quickPrefs?.quickTradeEnabled&&<Text style={styles.warning}>Uses {side==='buy'?'Long':'Short'} · {leverage||'choose'}x · stop {stop||'choose'}% · reward/risk {reward||'choose'}. Tap sends immediately.</Text>}{quickUncertain&&<Pressable accessibilityRole="button" onPress={()=>Alert.alert('Check your orders first','Only continue after confirming the previous attempt in MyFundedPerps or Activity.',[{text:'Cancel',style:'cancel'},{text:'I checked my orders',onPress:()=>setQuickUncertain(false)}])}><Text style={styles.link}>Check previous order before another quick trade</Text></Pressable>}</View>
   {(search||!market?markets??[]:[]).filter(m=>`${m.symbol} ${m.provider}`.toLowerCase().includes(search.toLowerCase())).slice(0,8).map(m=><Pressable key={m.id} accessibilityRole="button" onPress={()=>setMarketId(m.id)} style={[styles.market,m.id===marketId&&styles.selected]}><Text style={styles.value}>{m.symbol}</Text><Text style={styles.small}>{m.provider}{m.maxLeverage?` · Up to ${m.maxLeverage}x`:''}</Text></Pressable>)}
   <View style={styles.row}>{(['buy','sell'] as const).map(direction=><Pressable accessibilityRole="button" accessibilityState={{selected:side===direction}} key={direction} style={[styles.direction,side===direction&&styles.selected]} onPress={()=>setSide(direction)}><Text style={styles.value}>{direction==='buy'?'Long':'Short'}</Text></Pressable>)}</View>
   <Text style={styles.copy}>Select leverage</Text><View style={[styles.row,{flexWrap:'wrap'}]}>{[1,2,3,5,10,20,50].filter(v=>v<=(market?.maxLeverage??100)).map(v=><Pressable key={v} accessibilityRole="button" accessibilityState={{selected:Number(leverage)===v}} onPress={()=>setLeverage(String(v))} style={[styles.market,Number(leverage)===v&&styles.selected]}><Text style={styles.value}>{v}x</Text></Pressable>)}</View>
   {([{label:'Risk at stop ($)',value:risk,set:setRisk,hint:'Amount you choose to risk before fees'},{label:'Leverage (x)',value:leverage,set:setLeverage,hint:'Enter a whole number, e.g. 5'},{label:'Stop distance (%)',value:stop,set:setStop,hint:'Distance from entry, e.g. 1'},{label:'Reward / risk',value:reward,set:setReward,hint:'Target multiple, e.g. 2'}]).map(field=><View key={field.label} style={styles.field}><Text style={styles.copy}>{field.label}</Text><TextInput accessibilityLabel={field.label} keyboardType="decimal-pad" value={field.value} onChangeText={field.set} style={styles.input} placeholder={field.hint} placeholderTextColor="#82968b"/><Text style={styles.small}>{field.hint}</Text></View>)}
   <Text style={styles.small}>You choose your trade parameters. Personal guardrails follow your choices in Settings. MyFundedPerps performs final account and trading-rule checks.</Text>
   <Pressable accessibilityRole="button" disabled={busy||!marketId||!risk||!leverage||!stop||!reward} style={[styles.button,(busy||!marketId||!risk||!leverage||!stop||!reward)&&styles.disabled]} onPress={()=>void review()}><Text style={styles.buttonText}>Review trade</Text></Pressable>
  </>}
  {busy&&<ActivityIndicator color="#2dcc98"/>}{!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
 </ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e'},content:{padding:20,gap:16,paddingBottom:32},heading:{color:'#f4f8f5',fontSize:28,fontWeight:'700'},copy:{color:'#a9bbb2',fontSize:15,lineHeight:23},value:{color:'#f4f8f5',fontSize:15,fontWeight:'600',flexShrink:1,textAlign:'right'},small:{color:'#82968b',fontSize:12,lineHeight:19},warning:{color:'#ecae68',fontSize:14,lineHeight:21},error:{color:'#ff9c9c',fontSize:15,lineHeight:22},success:{color:'#71e6b8',fontSize:16,lineHeight:24},input:{padding:15,borderRadius:12,backgroundColor:'#12261c',color:'#f4f8f5',fontSize:16},row:{flexDirection:'row',justifyContent:'space-between',gap:14},field:{gap:8},market:{padding:12,borderWidth:1,borderColor:'#284237',borderRadius:10,flexDirection:'row',justifyContent:'space-between'},selected:{borderColor:'#2dcc98',backgroundColor:'#12392a'},direction:{flex:1,padding:18,borderWidth:1,borderColor:'#284237',borderRadius:12,alignItems:'center'},card:{backgroundColor:'#12261c',padding:18,borderRadius:16,gap:16},button:{backgroundColor:'#2dcc98',padding:17,borderRadius:12,alignItems:'center'},buttonText:{color:'#07120e',fontSize:17,fontWeight:'700'},disabled:{opacity:0.4},link:{color:'#2dcc98',paddingVertical:12}});
