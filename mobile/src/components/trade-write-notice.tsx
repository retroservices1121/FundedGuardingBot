import { Alert, Pressable, Text } from 'react-native';
import { useSession } from '../../App';
import { uncertainWriteMessage } from '../lib/trade-write';

export function TradeWriteNotice() {
  const { writeState, acknowledgeWrite } = useSession();
  if (writeState !== 'uncertain') return null;
  return <>
    <Text accessibilityRole="alert" style={{color:'#ff9c9c'}}>{uncertainWriteMessage}</Text>
    <Pressable accessibilityRole="button" onPress={() => Alert.alert(
      'Check MyFundedPerps first',
      'Check your orders, positions, and exits in MyFundedPerps. Continue only after you know what happened.',
      [{text:'Cancel',style:'cancel'},{text:'I checked MyFundedPerps',onPress:()=>void acknowledgeWrite()}],
    )}><Text style={{color:'#2dcc98',paddingVertical:12}}>I checked MyFundedPerps</Text></Pressable>
  </>;
}
