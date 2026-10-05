import { NativeTabs } from 'expo-router/unstable-native-tabs';
export default function TabsLayout() {
  return <NativeTabs tintColor="#2dcc98" backgroundColor="#07120e">
    <NativeTabs.Trigger name="index"><NativeTabs.Trigger.Icon sf="house" /><NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label></NativeTabs.Trigger>
    <NativeTabs.Trigger name="markets"><NativeTabs.Trigger.Icon sf="chart.bar" /><NativeTabs.Trigger.Label>Markets</NativeTabs.Trigger.Label></NativeTabs.Trigger>
  </NativeTabs>;
}
