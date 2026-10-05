import { Stack } from 'expo-router/stack';
import App from '../../App';
export default function RootLayout() {
  return <App><Stack screenOptions={{headerStyle:{backgroundColor:'#07120e'},headerTintColor:'#f4f8f5',contentStyle:{backgroundColor:'#07120e'}}}>
    <Stack.Screen name="(tabs)" options={{headerShown:false}} />
    <Stack.Screen name="protection" options={{title:'Edit TP/SL'}} />
    <Stack.Screen name="share-card" options={{title:'Share position'}} />
    <Stack.Screen name="learn" options={{title:'Learn'}} />
    <Stack.Screen name="settings" options={{title:'Settings',presentation:'modal'}} />
  </Stack></App>;
}
