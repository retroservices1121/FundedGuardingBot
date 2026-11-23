import { useEffect, useState } from 'react';
import { AppState, Text, type StyleProp, type TextStyle } from 'react-native';
import { nextDailyLossReset } from '../lib/daily-loss-reset';

export function DailyLossReset({style}: {style: StyleProp<TextStyle>}) {
  const [reset, setReset] = useState(() => nextDailyLossReset());
  useEffect(() => {
    const update = () => setReset(nextDailyLossReset());
    const timer = setTimeout(update, Math.max(0, reset.getTime() - Date.now()));
    const listener = AppState.addEventListener('change', state => { if (state === 'active') update(); });
    return () => { clearTimeout(timer); listener.remove(); };
  }, [reset]);
  const localTime = reset.toLocaleString(undefined, {weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
  return <Text style={style}>Daily loss resets at midnight Eastern. Next reset: {localTime} (your local time).</Text>;
}
