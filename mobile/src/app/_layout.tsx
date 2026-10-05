import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { Stack } from 'expo-router/stack';
import App from '../../App';
export default function RootLayout() {
  return <App><Stack screenOptions={{headerStyle:{backgroundColor:'#07120e'},headerTintColor:'#f4f8f5',contentStyle:{backgroundColor:'#07120e'}}}>
    <Stack.Screen name="(tabs)" options={{headerShown:false}} />
    <Stack.Screen name="protection" options={{title:'Edit TP/SL'}} />
    <Stack.Screen name="share-card" options={{title:'Share position'}} />
    <Stack.Screen name="learn" options={{title:'Learn'}} />
    <Stack.Screen name="settings" options={{title:'Settings',presentation:'modal',headerRight:()=> <Pressable accessibilityRole="button" accessibilityLabel="Close settings" hitSlop={12} onPress={()=>router.canGoBack()?router.back():router.replace('/')}><Text style={{color:'#2dcc98',fontSize:17,fontWeight:'600',padding:8}}>Done</Text></Pressable>}} />
  </Stack></App>;
}
