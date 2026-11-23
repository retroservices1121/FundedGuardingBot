import { Alert, Pressable, Text } from 'react-native';
import { useSession } from '../../App';
import { orderResultMessage, TradeWriteUncertainError, TradeWriteValidationError, uncertainWriteMessage } from '../lib/trade-write';

export function TradeWriteNotice() {
  const { writeState, acknowledgeWrite, pendingConfirm, checkConfirm, user } = useSession();
  async function check() {
    try {
      const result = await checkConfirm();
      Alert.alert('Request status', orderResultMessage(result, pendingConfirm?.path === 'close/check'));
    } catch (error) {
      Alert.alert('Request status', error instanceof TradeWriteValidationError || error instanceof TradeWriteUncertainError ? error.message : uncertainWriteMessage);
    }
  }
  if (writeState === 'pending' && pendingConfirm) return <Text accessibilityRole="alert" style={{color:'#2dcc98'}}>Checking your request…</Text>;
  if (writeState !== 'uncertain') return null;
  return <>
    <Text accessibilityRole="alert" style={{color:'#ff9c9c'}}>{uncertainWriteMessage}</Text>
    {pendingConfirm ? pendingConfirm.userId === user.id
      ? <Pressable accessibilityRole="button" onPress={()=>void check()}><Text style={{color:'#2dcc98',paddingVertical:12}}>Check request status</Text></Pressable>
      : <Text style={{color:'#ff9c9c'}}>Sign in with the account that started the request to check its status.</Text>
      : <Pressable accessibilityRole="button" onPress={() => Alert.alert(
      'Check MyFundedPerps first',
      'Check your orders, positions, and exits in MyFundedPerps. Continue only after you know what happened.',
      [{text:'Cancel',style:'cancel'},{text:'I checked MyFundedPerps',onPress:()=>void acknowledgeWrite()}],
    )}><Text style={{color:'#2dcc98',paddingVertical:12}}>I checked MyFundedPerps</Text></Pressable>}
  </>;
}
