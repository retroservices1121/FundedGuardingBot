import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import LoginCandles from './src/components/LoginCandles';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as Apple from 'expo-apple-authentication';
import * as SecureStore from 'expo-secure-store';
import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';

type User = { id: string; provider: string; email?: string };
const key = 'guardian.native.session';
const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? Constants.expoConfig?.extra?.apiUrl)?.replace(/\/$/, '');
GoogleSignin.configure({ iosClientId: Constants.expoConfig?.extra?.googleIosClientId });
class SessionError extends Error {}
async function request(path: string, method = 'GET', data?: unknown, token?: string) {
  if (!apiUrl || !apiUrl.startsWith('https://')) throw new Error('The app server is not configured yet.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${apiUrl}/api/mobile/auth/${path}`, { method, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) throw new SessionError(result.error);
      throw new Error(result.error ?? 'Could not reach Guardian. Try again.');
    }
    return result;
  } finally { clearTimeout(timer); }
}
type Session = { token: string; user: User; request: typeof request; busy: boolean; leave: (remove?: boolean) => Promise<void>; error: string };
const SessionContext = createContext<Session | null>(null);
export function useSession() { const value = useContext(SessionContext); if (!value) throw new Error('Sign in first.'); return value; }
export default function App({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
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
      setError(e instanceof Error ? e.message : 'Could not restore your session.');
    } finally { setLoading(false); }
  }
  // Session hydration resolves asynchronously before updating screen state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void hydrate(); void Apple.isAvailableAsync().then(setAvailable).catch(() => setAvailable(false)); }, []);
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
      if (!idToken) throw new Error('No sign-in token received. Please try again.');
      const result = await request('login', 'POST', { provider, idToken, nonce });
      await SecureStore.setItemAsync(key, result.token);
      setToken(result.token); setUser(result.user);
    } catch (e) {
      if ((e as { code?: string }).code !== 'ERR_REQUEST_CANCELED') setError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.');
    } finally { pending.current = false; setBusy(false); }
  }
  async function leave(remove = false) {
    if (!token || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await request(remove ? 'account' : 'logout', remove ? 'DELETE' : 'POST', undefined, token);
      await SecureStore.deleteItemAsync(key);
      setToken(null); setUser(null);
      void GoogleSignin.signOut().catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); }
    finally { pending.current = false; setBusy(false); }
  }
  if (user && token && !loading) return <SessionContext.Provider value={{user,token,request,busy,leave,error}}><StatusBar style="light" />{children}</SessionContext.Provider>;
  return <View style={styles.container}>
    <LoginCandles />
    <StatusBar style="light" />
    <ScrollView contentContainerStyle={styles.loginContent} showsVerticalScrollIndicator={false}>
    <View style={styles.loginBrand}><Image source={require("./assets/icon.png")} accessibilityLabel="Funded Guardian logo" style={styles.loginLogo}/><Text style={styles.label}>FUNDED GUARDIAN</Text></View>
    {!user && <Text style={styles.title}>Your Account.{'\n'}On the go.</Text>}
    <Text style={styles.description}>{user ? `Signed in with ${user.provider === 'apple' ? 'Apple' : 'Google'}.` : 'Your mobile companion for managing your MyFundedPerps account.'}</Text>
    {loading ? <ActivityIndicator color="#2dcc98" accessibilityLabel="Restoring session" /> : token ? <Pressable accessibilityRole="button" onPress={() => { setLoading(true); setError(''); void hydrate(); }}><Text style={styles.link}>Retry session connection</Text></Pressable> : <View style={styles.buttons} pointerEvents={busy ? 'none' : 'auto'}>
      {available && <Apple.AppleAuthenticationButton buttonType={Apple.AppleAuthenticationButtonType.CONTINUE} buttonStyle={Apple.AppleAuthenticationButtonStyle.WHITE} cornerRadius={14} style={styles.apple} onPress={() => void login('apple')} />}
      <Pressable accessibilityRole="button" accessibilityLabel="Continue with Google" accessibilityState={{disabled:busy || !apiUrl}} disabled={busy || !apiUrl} onPress={() => void login('google')} style={({pressed})=>[styles.googleButton,{opacity:busy || !apiUrl ? 0.5 : pressed ? 0.85 : 1}]}>
        <Image source={require('./assets/google-g.png')} style={styles.googleIcon}/><Text style={styles.googleLabel}>Continue with Google</Text>
      </Pressable>
      {!apiUrl && <Text style={styles.description}>Server configuration is needed before you can sign in.</Text>}
    </View>}
    {busy && <ActivityIndicator color="#2dcc98" />}
    {!!error && <Text accessibilityRole="alert" style={styles.delete}>{error}</Text>}
    <Text style={styles.footnote}>Your Apple or Google login creates your Guardian profile. Your MyFundedPerps API key is connected separately.</Text>
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({
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
});
