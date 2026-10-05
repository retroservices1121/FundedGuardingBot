import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link } from 'expo-router';
import { useSession } from '../../../App';
import AccountOnboarding from '../../components/AccountOnboarding';
export default function Home() {
  const {token,request}=useSession();
  return <SafeAreaView style={styles.page} edges={['top']}><View style={styles.header}><Text style={styles.title}>Funded Guardian</Text><Link href="/settings" style={styles.link}>Settings</Link></View><Link href="/learn" style={styles.link}>Learn: explore a trade</Link><AccountOnboarding token={token} request={request} /></SafeAreaView>;
}
const styles=StyleSheet.create({page:{flex:1,backgroundColor:'#07120e',padding:20,gap:20},header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:12},title:{fontSize:22,fontWeight:'700',color:'#f4f8f5'},link:{color:'#2dcc98',paddingVertical:12}});
