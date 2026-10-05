import { useIsFocused } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';

type LossRule = { limitPct?: number; limitAmount?: number; floor?: number; room?: number; usedAmount?: number; usedPercent?: number; lockedFloor?: boolean };
type Data = { account: { name?: string; stage?: string; balance?: number }; risk: {equity?: number; unrealized_pnl?: number; available_balance?: number; marks_complete?: boolean}; rules: {profit:{targetAmount?: number;remaining?: number;achievedAmount?: number;achievedPercent?: number};dailyLoss:LossRule;maxDrawdown:LossRule}; updatedAt: string; refreshSeconds: number };
type Props = {token:string;accountId:string;request:(path:string,method?:string,data?:unknown,token?:string)=>Promise<any>};
const money=(value?:number)=>typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value):'Unavailable';
function Progress({percent,color='#2dcc98'}:{percent?:number;color?:string}) {
  if (typeof percent!=='number'||!Number.isFinite(percent)) return null;
  return <View accessibilityLabel={`${percent.toFixed(1)} percent`} style={styles.track}><View style={[styles.fill,{width:`${Math.max(0,Math.min(100,percent))}%`,backgroundColor:color}]} /></View>;
}
function LossCard({title,rule}:{title:string;rule:LossRule}) {
  return <View style={styles.card}>
    <Text style={styles.label}>{title}</Text><Text style={styles.value}>{money(rule.room)}</Text><Text style={styles.small}>Remaining loss room</Text>
    <Progress percent={rule.usedPercent} color="#ecae68" />
    <Text style={styles.small}>Equity floor: {money(rule.floor)}</Text>
    {rule.limitAmount!==undefined&&<Text style={styles.small}>Used {money(rule.usedAmount)} of {money(rule.limitAmount)}{rule.limitPct!==undefined?` (${rule.limitPct}%)`:''}</Text>}
    {rule.lockedFloor&&<Text style={styles.small}>Funded drawdown floor is locked at or above the starting balance.</Text>}
  </View>;
}
export default function AccountDashboard({token,accountId,request}:Props) {
  const focused = useIsFocused();
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=useRef<(()=>Promise<void>)|null>(null);
  useEffect(()=>{
    if (!focused) return;
    let mounted=true,inFlight=false,interval=20000;
    let timer:ReturnType<typeof setTimeout>|undefined;
    async function load() {
      if(inFlight||!mounted||AppState.currentState==='background') return;
      inFlight=true;setBusy(true);
      try {const result:Data=await request('dashboard','GET',undefined,token);if(mounted){setData(result);setError('');interval=Math.max(10000,result.refreshSeconds*1000||20000);}}
      catch(e){if(mounted)setError(e instanceof Error?e.message:'Could not refresh.');}
      finally {inFlight=false;if(mounted){setBusy(false);if(timer)clearTimeout(timer);timer=setTimeout(()=>void load(),interval);}}
    }
    refresh.current=load;
    void load();
    const listener=AppState.addEventListener('change',state=>{if(state==='active')void load();else if(timer)clearTimeout(timer);});
    return ()=>{mounted=false;refresh.current=null;if(timer)clearTimeout(timer);listener.remove();};
  },[token,accountId,request,focused]);
  return <View style={styles.container}>
    <Text style={styles.heading}>Account overview</Text>
    {!data&&busy&&<ActivityIndicator color="#2dcc98" />}
    {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}{data?' Showing the last received data.':''}</Text>}
    {data&&<>
      <Text style={styles.label}>{data.account.name??'Selected account'} · {data.account.stage??'Active'}</Text>
      <View style={styles.card}><Text style={styles.label}>Equity</Text><Text style={styles.value}>{money(data.risk.equity)}</Text>
        <Text style={styles.small}>Balance: {money(data.account.balance)}</Text>
        <Text style={styles.small}>Unrealized P&L: {money(data.risk.unrealized_pnl)}</Text>
        <Text style={styles.small}>Available balance: {money(data.risk.available_balance)}</Text>
      </View>
      {data.risk.marks_complete===false&&<Text style={styles.error}>Some market prices are not fresh. Equity and P&L may be unavailable.</Text>}
      {data.account.stage?.toLowerCase()!=='funded'&&<View style={styles.card}><Text style={styles.label}>Profit target</Text><Text style={styles.value}>{money(data.rules.profit.remaining)}</Text><Text style={styles.small}>Remaining to target</Text><Progress percent={data.rules.profit.achievedPercent} /><Text style={styles.small}>Achieved {money(data.rules.profit.achievedAmount)} of {money(data.rules.profit.targetAmount)}</Text></View>}
      <LossCard title="Daily loss limit" rule={data.rules.dailyLoss} /><LossCard title="Maximum drawdown" rule={data.rules.maxDrawdown} />
      <Text style={styles.small}>Updated {new Date(data.updatedAt).toLocaleTimeString()}. Refreshes automatically while the app is open.</Text>
    </>}
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void refresh.current?.()}><Text style={styles.link}>{busy?'Refreshing…':'Refresh now'}</Text></Pressable>
  </View>;
}
const styles=StyleSheet.create({container:{gap:12},heading:{color:'#f4f8f5',fontSize:23,fontWeight:'700'},card:{padding:18,borderRadius:16,backgroundColor:'#0a1b13',gap:9},label:{color:'#a9bbb2',fontSize:14},value:{color:'#f4f8f5',fontSize:28,fontWeight:'700'},small:{color:'#82968b',fontSize:13,lineHeight:20},error:{color:'#ffb49c',fontSize:14,lineHeight:21},link:{color:'#2dcc98',paddingVertical:10,fontWeight:'600'},track:{height:7,borderRadius:4,backgroundColor:'#284237',overflow:'hidden'},fill:{height:7,borderRadius:4}});
