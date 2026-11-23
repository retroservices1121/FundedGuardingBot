import { screenErrorMessage } from '../lib/screen-error';
import PulseNotifications from './PulseNotifications';
import { Link } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import AccountOnboarding from './AccountOnboarding';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Text, TextInput, View, StyleSheet } from 'react-native';
import { useSession } from '../../App';
import { APP_PAGE_URLS, TRADING_DISCLAIMER } from '../lib/app-information';

const informationLinks = [
 {label:'Privacy Policy',url:APP_PAGE_URLS.privacy},
 {label:'Terms of Use',url:APP_PAGE_URLS.terms},
 {label:'Support',url:APP_PAGE_URLS.support},
];

export default function Settings(){
 const focused=useIsFocused();const {user,token,request,busy,leave,error,demo,setQuickTradeOff}=useSession();const [mode,setMode]=useState('off'),[max,setMax]=useState(''),[percent,setPercent]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[ready,setReady]=useState(false),[quickEnabled,setQuickEnabled]=useState(false),[amounts,setAmounts]=useState(['10','50','100']);
 const savingRef=useRef(false);
 useEffect(()=>{if(!focused)return;let mounted=true;request('guards','GET',undefined,token).then(value=>{if(mounted){setQuickEnabled(value.quickTradeEnabled===true);setAmounts((value.quickAmounts??[10,50,100]).map(String));setMode(value.mode);setMax(value.maxRiskUsd==null?'':String(value.maxRiskUsd));setPercent(value.lossRoomPercent==null?'':String(value.lossRoomPercent));setReady(true);}}).catch(e=>{if(mounted)setNotice(screenErrorMessage(e,'Could not load your trading preferences.'));}).finally(()=>{if(mounted)setLoading(false);});return()=>{mounted=false;};},[request,token,focused]);
 async function save(){
  if(savingRef.current)return;
  if([max,percent,...amounts].some(v=>v.trim()&&(!Number.isFinite(Number(v))||Number(v)<=0))){setNotice('Enter positive numeric limits or leave them blank.');return;}
  savingRef.current=true;setSaving(true);
  try{await request('guards','POST',{mode,quickTradeEnabled:quickEnabled,quickAmounts:amounts.map(Number),maxRiskUsd:max.trim()?Number(max):null,lossRoomPercent:percent.trim()?Number(percent):null},token);setQuickTradeOff(!quickEnabled);setNotice('Your trading preferences are saved.');}
  catch{setNotice('Could not save your trading preferences.');}
  finally{savingRef.current=false;setSaving(false);}
 }
 async function turnQuickTradeOff(){
  if(savingRef.current)return;
  savingRef.current=true;setSaving(true);setQuickTradeOff(true);setQuickEnabled(false);setNotice('');
  try{
   await request('guards','POST',{quickTradeEnabled:false},token);
   setQuickEnabled(false);setNotice('One-tap trading is off.');
  }catch{
   setQuickEnabled(true);setNotice('One-tap trading is paused in this session. Tap to turn it off again to save the change.');
  }finally{savingRef.current=false;setSaving(false);}
 }
 return <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
 <Text style={styles.heading}>Settings</Text><Link href="/learn" asChild><Pressable accessibilityRole="button" style={{padding:18,borderRadius:16,backgroundColor:'#173a2b',borderWidth:1,borderColor:'#32664d',gap:6}}><Text style={{color:'#f4f8f5',fontSize:18,fontWeight:'700'}}>Learn with your account →</Text><Text style={styles.small}>Explore margin, leverage, stops and targets in a practice calculator.</Text></Pressable></Link><Text style={styles.heading}>Personal guardrails</Text><Text style={styles.copy}>Off by default. Choose your own limits. MyFundedPerps account rules still apply to every order.</Text>
 <View style={styles.row}>{(['off','warn','enforce'] as const).map(value=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:mode===value}} disabled={!ready||saving} style={[styles.option,mode===value&&styles.selected]} onPress={()=>setMode(value)}><Text style={styles.value}>{value==='off'?'Off':value==='warn'?'Warn me':'Enforce'}</Text></Pressable>)}</View>
 <Text style={styles.copy}>{mode==='off'?'Guardian adds no personal risk limit.':mode==='warn'?'Show warnings and allow you to decide.':'Block new trades that exceed your chosen limits. Position closing stays available.'}</Text>
 <Text style={styles.copy}>Maximum risk per trade ($), optional</Text><TextInput editable={ready&&!saving} accessibilityLabel="Maximum risk per trade" keyboardType="decimal-pad" value={max} onChangeText={setMax} placeholder="No personal limit" placeholderTextColor="#82968b" style={styles.input}/>
 <Text style={styles.copy}>Remaining loss room per trade (%), optional</Text><TextInput editable={ready&&!saving} accessibilityLabel="Loss room percentage" keyboardType="decimal-pad" value={percent} onChangeText={setPercent} placeholder="Choose 1 to 100" placeholderTextColor="#82968b" style={styles.input}/>
 <Text style={styles.small}>Uses the smaller available daily or maximum loss room. Limits cover the proposed trade risk at stop, excluding fees, slippage and other open risk. Settings apply across your linked accounts.</Text>
 <Text style={styles.heading}>One-tap trading</Text><Text style={styles.copy}>Choose three risk-at-stop amounts. Tap a saved amount in Trade to see the market order and confirm it. Fees and slippage can add to losses.</Text>
 <View style={styles.row}>{amounts.map((amount,i)=><TextInput key={i} accessibilityLabel={`Quick risk amount ${i+1}`} editable={ready&&!saving} value={amount} onChangeText={text=>setAmounts(current=>current.map((v,j)=>j===i?text:v))} keyboardType="decimal-pad" style={[styles.input,{flex:1,minWidth:0}]} />)}</View>
 <Pressable accessibilityRole="button" disabled={!ready||saving} style={styles.option} onPress={()=>quickEnabled?void turnQuickTradeOff():Alert.alert('Enable one-tap trading?','Each market order still asks for confirmation. Save your preferences to turn on one-tap trading.',[{text:'Cancel',style:'cancel'},{text:'Enable',onPress:()=>setQuickEnabled(true)}])}><Text style={styles.value}>{quickEnabled?'Enabled · tap to turn off':'Off · tap to enable'}</Text></Pressable>
 <Pressable accessibilityRole="button" disabled={!ready||saving||loading} onPress={()=>void save()} style={styles.option}><Text style={styles.link}>{loading?'Loading…':saving?'Saving…':'Save trading preferences'}</Text></Pressable>{!!notice&&<Text accessibilityRole="alert" style={styles.copy}>{notice}</Text>}
 <PulseNotifications/><AccountOnboarding token={token} request={request} showDashboard={false}/><Text style={styles.copy}>{demo?'Demo session · Settings apply only to this demonstration.':`Signed in with ${user.provider==='apple'?'Apple':user.provider==='email'?'email':'Google'}.`}</Text>
 <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void leave()}><Text style={styles.link}>{demo?'Exit demo':'Sign out'}</Text></Pressable>
 {!demo&&<Pressable accessibilityRole="button" disabled={busy} onPress={()=>Alert.alert('Delete Guardian account?','This removes your Guardian sign-in and saved connection key. It does not close your MyFundedPerps positions.',[{text:'Cancel',style:'cancel'},{text:'Delete',style:'destructive',onPress:()=>void leave(true)}])}><Text style={styles.error}>Delete Guardian account</Text></Pressable>}{!!error&&<Text style={styles.error}>{error}</Text>}
 <View>
  {informationLinks.map(({label,url})=><Pressable key={url} accessibilityRole="link" onPress={()=>void Linking.openURL(url).catch(()=>Alert.alert('Could not open this page','Please try again.'))}><Text style={styles.link}>{label}</Text></Pressable>)}
 </View>
 <Text style={styles.small}>{TRADING_DISCLAIMER}</Text>
 </ScrollView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e'},content:{padding:24,gap:18,paddingBottom:50},heading:{color:'#fff',fontSize:25,fontWeight:'700'},copy:{color:'#a9bbb2',fontSize:16,lineHeight:24},small:{color:'#82968b',fontSize:13,lineHeight:20},link:{color:'#2dcc98',paddingVertical:12,fontSize:17},error:{color:'#ff9c9c',paddingVertical:12,fontSize:16},row:{flexDirection:'row',gap:8},option:{backgroundColor:'#14271e',borderRadius:12,padding:12},selected:{backgroundColor:'#24533e'},value:{color:'#fff'},input:{color:'#fff',backgroundColor:'#14271e',borderRadius:12,padding:16,fontSize:20}});
