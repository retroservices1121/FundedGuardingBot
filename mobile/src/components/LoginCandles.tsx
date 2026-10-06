import {useEffect, useState} from 'react';
import {AccessibilityInfo, AppState, StyleSheet, View} from 'react-native';
import Animated from 'react-native-reanimated';

// Decorative market illustration, not live price data.
export default function LoginCandles() {
  const [reduced, setReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {if (mounted) setReduced(value);});
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    const state = AppState.addEventListener('change', value => setActive(value === 'active'));
    return () => {mounted = false; motion.remove(); state.remove();};
  }, []);
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.scene}>
    {[0,1,2,3,4].map(row => <View key={`grid-${row}`} style={[styles.grid,{top:`${18 + row * 16}%`}]}/>)}
    {Array.from({length:18},(_,i) => {
      const height = 28 + (i * 19 % 65);
      const color = i % 4 === 1 ? '#a65564' : '#2dcc98';
      return <Animated.View key={i} style={[styles.candle,{left:`${i * 6 - 2}%`,top:`${17 + (i * 13 % 30)}%`,opacity:0.13,
        animationName:{from:{transform:[{translateY:0}]},to:{transform:[{translateY:i % 2 ? 14 : -14}]}},
        animationDuration:7000 + i * 370,animationTimingFunction:'linear',animationIterationCount:'infinite',animationDirection:'alternate',
        animationPlayState:reduced || !active ? 'paused' : 'running'}]}>
        <View style={{height:height + 30,width:1,backgroundColor:color,position:'absolute',top:-15,left:5}}/>
        <View style={{height,width:11,borderRadius:2,backgroundColor:color}}/>
      </Animated.View>;
    })}
  </View>;
}
const styles = StyleSheet.create({
  scene:{position:'absolute',top:0,right:0,bottom:0,left:0,overflow:'hidden'},
  grid:{position:'absolute',left:0,right:0,height:1,backgroundColor:'#2dcc98',opacity:0.045},
  candle:{position:'absolute'},
});
