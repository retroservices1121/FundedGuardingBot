import { Alert, Pressable, Text, View, StyleSheet } from 'react-native';
import { useSession } from '../../App';
export default function Settings(){const {user,busy,leave,error}=useSession();return <View style={styles.page}>
  <Text style={styles.copy}>Signed in with {user.provider==='apple'?'Apple':'Google'}.</Text>
  <Text style={styles.copy}>Personal trading guardrails are currently off. Custom native controls will be added with trading.</Text>
  <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void leave()}><Text style={styles.link}>Sign out</Text></Pressable>
  <Pressable accessibilityRole="button" disabled={busy} onPress={()=>Alert.alert('Delete Guardian account?','This removes your native login, saved API key and sessions. It does not close your MyFundedPerps positions.',[{text:'Cancel',style:'cancel'},{text:'Delete',style:'destructive',onPress:()=>void leave(true)}])}><Text style={styles.error}>Delete Guardian account</Text></Pressable>
  {!!error&&<Text style={styles.error}>{error}</Text>}
</View>}
const styles=StyleSheet.create({page:{flex:1,padding:24,gap:24},copy:{color:'#a9bbb2',fontSize:16,lineHeight:24},link:{color:'#2dcc98',paddingVertical:12,fontSize:17},error:{color:'#ff9c9c',paddingVertical:12,fontSize:16}});
