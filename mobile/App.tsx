import {Link,router} from 'expo-router';
import {SafeAreaView} from 'react-native-safe-area-context';
import {createDemoClient,DEMO_TOKEN,DEMO_USER} from './src/lib/demo-session';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import LoginCandles from './src/components/LoginCandles';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as Apple from 'expo-apple-authentication';
import * as SecureStore from 'expo-secure-store';
import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';

import { isTradeWrite, type ConfirmRetry } from './src/lib/trade-write';
import { ScreenError, screenErrorMessage } from './src/lib/screen-error';
import { createMobileRequest, serverUnavailableMessage, SessionError } from './src/lib/mobile-request';
import { useTradeWriteLock } from './src/hooks/use-trade-write-lock';
import { APP_PAGE_URLS, TRADING_DISCLAIMER } from './src/lib/app-information';

type User = { id: string; provider: string; email?: string };
const key = 'guardian.native.session';
const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? Constants.expoConfig?.extra?.apiUrl)?.replace(/\/$/, '');
GoogleSignin.configure({ iosClientId: Constants.expoConfig?.extra?.googleIosClientId });
const request = createMobileRequest(apiUrl);
// Installation IDs describe app launches, not App Store downloads or advertising identity.
let launchTracking: Promise<{installId:string;platform:string;version:string}|undefined> | undefined;
function trackLaunch() {
  return launchTracking ??= (async()=>{
    if(!apiUrl || !['ios','android'].includes(Platform.OS))return;
    let installId=await SecureStore.getItemAsync('guardian.analytics.install');
    if(!installId){installId=`launch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;await SecureStore.setItemAsync('guardian.analytics.install',installId);}
    const payload={installId,platform:Platform.OS,version:Constants.expoConfig?.version??'unknown'};
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
    try { await fetch(`${apiUrl}/api/mobile/launch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal}); }
    catch { /* Analytics must never block app access. */ }
    finally { clearTimeout(timer); }
    return payload;
  })().catch(()=>undefined);
}
type Session = { writeState: ReturnType<typeof useTradeWriteLock>['state']; acknowledgeWrite: () => Promise<void>; pendingConfirm?: ConfirmRetry; checkConfirm: () => ReturnType<typeof request>; quickTradeOff: boolean; setQuickTradeOff: (off: boolean) => void; demo: boolean; token: string; user: User; request: typeof request; busy: boolean; leave: (remove?: boolean) => Promise<void>; error: string };
const SessionContext = createContext<Session | null>(null);
export function useSession() { const value = useContext(SessionContext); if (!value) throw new Error('Sign in first.'); return value; }
export default function App({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState('');
  const [emailForm, setEmailForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const pending = useRef(false);
  const [demoClient] = useState(createDemoClient);
  const [quickTradeOffFor, setQuickTradeOffFor] = useState<string | null>(null);
  const setQuickTradeOff = useCallback((off: boolean) => setQuickTradeOffFor(off ? user?.id ?? null : null), [user?.id]);
  const demo = token === DEMO_TOKEN;
  const { state: writeState, run: runWrite, acknowledge: acknowledgeWrite, confirm: pendingConfirm, check } = useTradeWriteLock();
  const userId = user?.id;
  const liveRequest = useCallback<typeof request>((path, method = 'GET', data, token) => {
    if (!isTradeWrite(path, method)) return request(path, method, data, token);
    const input = data as {ticketId?:string} | undefined;
    if ((path === 'trade/confirm' || path === 'trade/quick' || path === 'close/confirm') && input?.ticketId && userId) {
      const checkPath = path === 'close/confirm' ? 'close/check' : 'trade/check';
      return runWrite(() => request(path, method, data, token), {path:checkPath,ticketId:input.ticketId,userId});
    }
    if (path === 'trade/quick') return Promise.reject(new ScreenError('Review a new one-tap order before submitting.'));
    return runWrite(() => request(path, method, data, token));
  }, [runWrite, userId]);
  const checkConfirm = () => check(userId ?? '', intent => request(intent.path, 'POST', {ticketId:intent.ticketId}, token ?? undefined));
  function enterDemo(){if(loading||busy)return;demoClient.reset();setError('');setToken(DEMO_TOKEN);setUser(DEMO_USER);}
  async function hydrate() {
    try {
      const saved = await SecureStore.getItemAsync(key);
      if (saved) {
        setToken(saved);
        const result = await request('me', 'GET', undefined, saved);
        setUser(result.user);
      }
    } catch (e) {
      if (e instanceof SessionError) { await SecureStore.deleteItemAsync(key); setToken(null); }
      setError(screenErrorMessage(e, 'Could not restore your session.'));
    } finally { setLoading(false); }
  }
  // Session hydration resolves asynchronously before updating screen state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void trackLaunch(); void hydrate(); void Apple.isAvailableAsync().then(setAvailable).catch(() => setAvailable(false)); }, []);
  useEffect(()=>{if(token && token!==DEMO_TOKEN)void trackLaunch().then(payload=>{if(payload)return request('analytics','POST',payload,token);}).catch(()=>undefined);},[token]);
  async function login(provider: 'apple' | 'google') {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      let idToken: string | null = null;
      let nonce: string | undefined;
      if (provider === 'apple') {
        const challenge = await request('challenge', 'POST');
        nonce = challenge.nonce;
        const credential = await Apple.signInAsync({ nonce, requestedScopes: [Apple.AppleAuthenticationScope.EMAIL] });
        idToken = credential.identityToken;
      } else {
        const result = await GoogleSignin.signIn();
        if (!isSuccessResponse(result)) return;
        idToken = result.data.idToken;
      }
      if (!idToken) throw new ScreenError('Could not verify sign-in. Please try again.');
      const result = await request('login', 'POST', { provider, idToken, nonce });
      await SecureStore.setItemAsync(key, result.token);
      setToken(result.token); setUser(result.user);
    } catch (e) {
      if ((e as { code?: string }).code !== 'ERR_REQUEST_CANCELED') setError(screenErrorMessage(e, 'Sign-in failed. Please try again.'));
    } finally { pending.current = false; setBusy(false); }
  }
  async function loginEmail() {
    if (pending.current || !email.trim() || !password) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await request('email-login', 'POST', { email: email.trim(), password });
      await SecureStore.setItemAsync(key, result.token);
      setPassword(''); setToken(result.token); setUser(result.user);
    } catch (e) { setError(screenErrorMessage(e, 'Sign-in failed. Please try again.')); }
    finally { pending.current = false; setBusy(false); }
  }
  async function leave(remove = false) {
    if (demo){router.replace('/');setToken(null);setUser(null);setError('');return;}
    if (!token || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (remove) await request('account', 'DELETE', undefined, token);
      const logout = remove ? undefined : request('logout', 'POST', undefined, token).catch(() => undefined);
      setToken(null); setUser(null); setPassword('');
      void GoogleSignin.signOut().catch(() => {});
      await Promise.all([
        SecureStore.deleteItemAsync(key).catch(() => setError('Could not remove the saved sign-in from this device.')),
        logout,
      ]);
    } catch (e) { setError(screenErrorMessage(e, 'Could not delete your Guardian account. Please try again.')); }
    finally { pending.current = false; setBusy(false); }
  }
  if (user && token && !loading) return <SessionContext.Provider value={{demo,user,token,request:demo?demoClient.request:liveRequest,writeState:demo?'ready':writeState,acknowledgeWrite,pendingConfirm,checkConfirm,quickTradeOff:quickTradeOffFor===user.id,setQuickTradeOff,busy,leave,error}}><StatusBar style="light" /><View style={{flex:1,backgroundColor:'#07120e'}}>{demo&&<SafeAreaView edges={['top']} style={{backgroundColor:'#173a2b'}}><View style={{paddingHorizontal:18,paddingVertical:8,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}}><Text style={{color:'#f4f8f5',fontSize:12,flexShrink:1}}>DEMO · Sample data · No real orders</Text><Pressable accessibilityRole="button" accessibilityLabel="Exit demo" onPress={()=>void leave()} hitSlop={8} style={{padding:8}}><Text style={{color:'#2dcc98',fontWeight:'700'}}>Exit</Text></Pressable></View></SafeAreaView>}<View style={{flex:1}}>{children}</View></View></SessionContext.Provider>;
  return <View style={styles.container}>
    <LoginCandles />
    <StatusBar style="light" />
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={styles.loginContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false}>
    <View style={styles.loginBrand}><Image source={require("./assets/icon.png")} accessibilityLabel="Funded Guardian logo" style={styles.loginLogo}/><Text style={styles.label}>FUNDED GUARDIAN</Text></View>
    {!user && <Text style={styles.title}>Your Account.{'\n'}On the go.</Text>}
    <Text style={styles.description}>{user ? `Signed in with ${user.provider === 'apple' ? 'Apple' : user.provider === 'email' ? 'email' : 'Google'}.` : 'Your mobile companion for managing your MyFundedPerps account.'}</Text>
    {loading ? <ActivityIndicator color="#2dcc98" accessibilityLabel="Restoring session" /> : token ? <Pressable accessibilityRole="button" onPress={() => { setLoading(true); setError(''); void hydrate(); }}><Text style={styles.link}>Retry session connection</Text></Pressable> : <View style={styles.buttons} pointerEvents={busy ? 'none' : 'auto'}>
      {available && <Apple.AppleAuthenticationButton buttonType={Apple.AppleAuthenticationButtonType.CONTINUE} buttonStyle={Apple.AppleAuthenticationButtonStyle.WHITE} cornerRadius={14} style={styles.apple} onPress={() => void login('apple')} />}
      <Pressable accessibilityRole="button" accessibilityLabel="Continue with Google" accessibilityState={{disabled:busy || !apiUrl}} disabled={busy || !apiUrl} onPress={() => void login('google')} style={({pressed})=>[styles.googleButton,{opacity:busy || !apiUrl ? 0.5 : pressed ? 0.85 : 1}]}>
        <Image source={require('./assets/google-g.png')} style={styles.googleIcon}/><Text style={styles.googleLabel}>Continue with Google</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setEmailForm(!emailForm);setError('');setPassword('');}} style={{paddingVertical:12,alignItems:'center'}}><Text style={styles.link}>{emailForm?'Close email sign-in':'Sign in with email'}</Text></Pressable>
      {emailForm&&<View style={{gap:12}}>
        <Text style={styles.footnote}>Use the email and password provided by Guardian.</Text>
        <TextInput accessibilityLabel="Email" placeholder="Email" placeholderTextColor="#82968b" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="username" textContentType="username" maxLength={254} style={styles.emailInput}/>
        <TextInput accessibilityLabel="Password" placeholder="Password" placeholderTextColor="#82968b" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" maxLength={256} returnKeyType="go" onSubmitEditing={()=>void loginEmail()} style={styles.emailInput}/>
        <Pressable accessibilityRole="button" disabled={busy||!apiUrl||!email.trim()||!password} onPress={()=>void loginEmail()} style={{padding:16,borderRadius:14,alignItems:'center',backgroundColor:'#2dcc98',opacity:busy||!apiUrl||!email.trim()||!password?0.5:1}}><Text style={{color:'#07120e',fontSize:17,fontWeight:'700'}}>Sign in</Text></Pressable>
      </View>}
      {!apiUrl && <Text style={styles.description}>{serverUnavailableMessage}</Text>}
    </View>}
    {!loading&&<Pressable accessibilityRole="button" disabled={busy} onPress={enterDemo} style={{padding:16,borderRadius:14,borderWidth:1,borderColor:'#32664d',alignItems:'center',gap:6}}><Text style={{color:'#2dcc98',fontSize:17,fontWeight:'700'}}>Explore demo</Text><Text style={{color:'#a9bbb2',fontSize:12}}>Sample account · No sign-in needed</Text></Pressable>}
    {busy && <ActivityIndicator color="#2dcc98" />}
    {!!error && <Text accessibilityRole="alert" style={styles.delete}>{error}</Text>}
    <Text style={styles.footnote}>Sign in to Guardian, then connect your MyFundedPerps account.</Text>
    <View>
      <Text style={styles.footnote}>{TRADING_DISCLAIMER}</Text>
      <View style={styles.legalLinks}>
        <Link href={APP_PAGE_URLS.privacy} style={styles.legalLink}>Privacy Policy</Link>
        <Link href={APP_PAGE_URLS.terms} style={styles.legalLink}>Terms of Use</Link>
        <Link href={APP_PAGE_URLS.support} style={styles.legalLink}>Support</Link>
      </View>
    </View>
    </ScrollView>
    </KeyboardAvoidingView>
  </View>;
}
const styles = StyleSheet.create({
  emailInput: {backgroundColor:'#12261c',color:'#f4f8f5',padding:16,borderRadius:14,borderWidth:1,borderColor:'#32664d',fontSize:17},
  container: { flex: 1, backgroundColor: '#07120e' },
  loginContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 64, gap: 20 },
  loginBrand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  loginLogo: { width: 52, height: 52, borderRadius: 12 },
  label: { color: '#2dcc98', fontWeight: '700', letterSpacing: 3, fontSize: 13 },
  title: { color: '#f4f8f5', fontSize: 40, fontWeight: '700' },
  description: { color: '#a9bbb2', fontSize: 17, lineHeight: 26 },
  notice: { flexShrink: 1, backgroundColor: '#12261c', borderRadius: 20, padding: 20, gap: 16 },
  noticeTitle: { color: '#f4f8f5', fontSize: 18, fontWeight: '600' },
  buttons: { gap: 14, marginTop: 8 }, apple: { width: '100%', height: 56 },
  googleButton: { minHeight: 56, borderRadius: 14, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 14 },
  googleIcon: { width: 22, height: 22, resizeMode: 'contain' },
  googleLabel: { color: '#1f1f1f', fontSize: 19, fontWeight: '500', flexShrink: 1 },
  link: { color: '#2dcc98', fontSize: 17, paddingVertical: 10 }, delete: { color: '#ff9c9c', fontSize: 15, paddingVertical: 8 },
  footnote: { color: '#82968b', fontSize: 13, lineHeight: 20 },
  legalLinks: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 },
  legalLink: { color: '#2dcc98', fontSize: 13, paddingVertical: 14 },
});
