import { Tabs } from 'expo-router';
export default function TabsLayout(){return <Tabs screenOptions={{headerShown:false,tabBarActiveTintColor:'#2dcc98',tabBarInactiveTintColor:'#91a79a',tabBarStyle:{backgroundColor:'#07120e',borderTopColor:'#284237'},tabBarIcon:()=>null,tabBarIconStyle:{display:"none"},tabBarItemStyle:{justifyContent:"center",minHeight:48},tabBarLabelStyle:{fontSize:11,fontWeight:'600'}}}>
 <Tabs.Screen name="index" options={{title:'Home'}}/>
 <Tabs.Screen name="markets" options={{title:'Markets'}}/>
 <Tabs.Screen name="trade" options={{title:'Trade'}}/>
 <Tabs.Screen name="activity" options={{title:'Activity'}}/>
 <Tabs.Screen name="pulse" options={{title:'Pulse'}}/>
 <Tabs.Screen name="preferences" options={{title:'Settings'}}/>
</Tabs>;}
