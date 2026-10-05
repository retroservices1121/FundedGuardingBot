import { router } from 'expo-router';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../../../App';
import AccountOnboarding from '../../components/AccountOnboarding';
export default function Home() {
  const {token,request}=useSession();
  return <SafeAreaView style={styles.page} edges={['top']}><View style={styles.header}><Text style={styles.title}>Funded Guardian</Text><Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={()=>router.push('/settings')} style={{width:44,height:44,alignItems:'center',justifyContent:'center',borderRadius:22,backgroundColor:'#14271e'}}><View style={{width:22,height:22,alignItems:'center',justifyContent:'center'}}>{Array.from({length:8},(_,i)=><View key={i} style={{position:'absolute',width:6,height:22,backgroundColor:'#afc6b9',borderRadius:1,transform:[{rotate:`${i*45}deg`}]}}/>)}<View style={{width:18,height:18,borderRadius:9,backgroundColor:'#afc6b9',alignItems:'center',justifyContent:'center'}}><View style={{width:8,height:8,borderRadius:4,backgroundColor:'#14271e'}}/></View></View></Pressable></View><AccountOnboarding token={token} request={request} manage={false} /></SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e',padding:20,gap:20},header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:12},title:{fontSize:22,fontWeight:'700',color:'#f4f8f5'},link:{color:'#2dcc98',paddingVertical:12}});
