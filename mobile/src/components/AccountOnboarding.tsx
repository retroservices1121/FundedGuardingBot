import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

type Account = { id: string; name?: string; status?: string; stage?: string; starting_balance?: number; balance?: number };
type Connection = { connected: boolean; accounts?: Account[]; selectedAccountId?: string; keyLastFour?: string };
type Props = { token: string; request: (path: string, method?: string, data?: unknown, token?: string) => Promise<any> };
export default function AccountOnboarding({ token, request }: Props) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let mounted = true;
    request('connection','GET',undefined,token).then(value => { if (mounted) setConnection(value); })
      .catch(e => { if (mounted) setError(e.message ?? 'Could not load your connection.'); });
    return () => { mounted = false; };
  }, [token, request]);
  async function act(action: 'connect' | 'refresh' | 'select' | 'disconnect', id?: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (action === 'connect') {
        const result = await request('connect','POST',{apiKey:apiKey.trim()},token);
        setConnection(result); setApiKey('');
      } else if (action === 'select') {
        await request('account-selection','POST',{accountId:id},token);
        setConnection(previous => previous ? {...previous, selectedAccountId:id} : previous);
      } else if (action === 'disconnect') {
        await request('connection','DELETE',undefined,token); setConnection({connected:false});
      } else setConnection(await request('connection','GET',undefined,token));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save. Please try again.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.heading}>{connection?.connected ? 'Choose your account' : 'Connect MyFundedPerps'}</Text>
    {connection?.connected ? <>
      <Text style={styles.copy}>API key connected, ending in {connection.keyLastFour}. Select the active account you want to use.</Text>
      {!connection.accounts?.length && <Text style={styles.copy}>No active accounts are currently available. Refresh after your account becomes active.</Text>}
      {connection.accounts?.map(account => <Pressable key={account.id} accessibilityRole="button" accessibilityState={{selected:connection.selectedAccountId===account.id,disabled:busy}} disabled={busy} style={[styles.account,connection.selectedAccountId===account.id && styles.selected]} onPress={() => void act('select',account.id)}>
        <Text style={styles.name}>{account.name ?? account.id}</Text>
        <Text style={styles.copy}>{account.stage ?? account.status ?? 'Active'}{Number.isFinite(account.starting_balance) ? ` · $${account.starting_balance!.toLocaleString()}` : ''}</Text>
        {connection.selectedAccountId===account.id && <Text style={styles.link}>Selected</Text>}
      </Pressable>)}
      <Text style={styles.copy}>Personal guardrails are optional and off by default. MyFundedPerps account rules still apply. Trading and custom guardrail controls are coming in the next native build.</Text>
      <Pressable disabled={busy} accessibilityRole="button" onPress={() => void act('refresh')}><Text style={styles.link}>Refresh accounts</Text></Pressable>
      <Pressable disabled={busy} accessibilityRole="button" onPress={() => Alert.alert('Disconnect MyFundedPerps?', 'This removes the saved API key from Guardian. Your positions remain on MyFundedPerps.',[{text:'Cancel',style:'cancel'},{text:'Disconnect',style:'destructive',onPress:()=>void act('disconnect')}])}><Text style={styles.remove}>Disconnect API key</Text></Pressable>
    </> : <>
      <Text style={styles.copy}>1. Open MyFundedPerps and sign in.</Text>
      <Text style={styles.copy}>2. Open Settings → API Keys. Create a key named “Funded Guardian”.</Text>
      <Text style={styles.copy}>3. Copy the secret when it appears. MyFundedPerps will not show it again.</Text>
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://myfundedperpetuals.com/settings?section=api-keys').catch(()=>setError('Could not open MyFundedPerps. Open its website and go to Settings → API Keys.'))}><Text style={styles.link}>Open MyFundedPerps API Key Settings ↗</Text></Pressable>
      <Text style={styles.copy}>4. Paste your key below. Guardian verifies it and loads your active accounts.</Text>
      <TextInput accessibilityLabel="MyFundedPerps API key" secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="none" placeholder="fp_live_…" placeholderTextColor="#82968b" value={apiKey} onChangeText={setApiKey} editable={!busy} style={styles.input} />
      <Text style={styles.small}>The key is sent securely to Guardian and encrypted on the server. Never share it in Telegram, screenshots, or public posts. Connecting does not place a trade.</Text>
      <Pressable accessibilityRole="button" disabled={busy || !apiKey.trim()} style={[styles.button,(busy||!apiKey.trim())&&styles.disabled]} onPress={()=>void act('connect')}><Text style={styles.buttonText}>Connect account</Text></Pressable>
      {!connection && !error && <ActivityIndicator color="#2dcc98" />}
    </>}
    {busy && <ActivityIndicator color="#2dcc98" />}
    {!!error && <><Text accessibilityRole="alert" style={styles.remove}>{error}</Text>{!connection && <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void act('refresh')}><Text style={styles.link}>Retry connection</Text></Pressable>}</>}
  </ScrollView>;
}
const styles=StyleSheet.create({
  scroll:{flexShrink:1},content:{gap:14,paddingBottom:20},heading:{fontSize:23,fontWeight:'700',color:'#f4f8f5'},
  copy:{fontSize:15,lineHeight:23,color:'#a9bbb2'},small:{fontSize:12,lineHeight:19,color:'#82968b'},
  link:{color:'#2dcc98',fontWeight:'600',paddingVertical:8},remove:{color:'#ff9c9c',paddingVertical:8},
  input:{color:'#f4f8f5',backgroundColor:'#12261c',borderRadius:12,borderWidth:1,borderColor:'#345247',padding:16,fontSize:16},
  button:{backgroundColor:'#2dcc98',padding:16,borderRadius:12,alignItems:'center'},buttonText:{color:'#07120e',fontWeight:'700',fontSize:17},disabled:{opacity:0.4},
  account:{padding:16,borderRadius:12,borderWidth:1,borderColor:'#345247',gap:6},selected:{borderColor:'#2dcc98',backgroundColor:'#12261c'},name:{fontSize:17,fontWeight:'600',color:'#f4f8f5'},
});
