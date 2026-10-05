import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>FUNDED GUARDIAN</Text>
      <Text style={styles.title}>Your account.
Less clutter.</Text>
      <Text style={styles.description}>A simpler way to understand and manage your MyFundedPerps account.</Text>
      <View style={styles.notice}>
        <Text style={styles.noticeTitle}>Development preview</Text>
        <Text style={styles.description}>Native Apple and Google sign-in, account connection and trading are being built. This preview does not connect to an account or send orders.</Text>
      </View>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#07120e', justifyContent: 'center', padding: 28, gap: 20 },
  label: { color: '#2dcc98', fontWeight: '700', letterSpacing: 3, fontSize: 13 },
  title: { color: '#f4f8f5', fontSize: 42, fontWeight: '700' },
  description: { color: '#a9bbb2', fontSize: 17, lineHeight: 26 },
  notice: { backgroundColor: '#12261c', borderRadius: 20, padding: 20, gap: 12, marginTop: 20 },
  noticeTitle: { color: '#f4f8f5', fontSize: 18, fontWeight: '600' },
});
