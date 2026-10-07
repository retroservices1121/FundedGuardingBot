import {useEffect, useState} from 'react';
import {AccessibilityInfo, AppState, StyleSheet, View} from 'react-native';
import Animated, {cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming} from 'react-native-reanimated';

// Decorative market illustration, not live price data.
export default function LoginCandles() {
  const [reduced, setReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {if (mounted) setReduced(value);});
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    const state = AppState.addEventListener('change', value => setActive(value === 'active'));
    return () => {mounted = false; motion.remove(); state.remove();};
  }, []);
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.scene}>
    {[0,1,2,3,4,5,6,7,8].map(row => <View key={`grid-${row}`} style={[styles.grid,{top:`${5 + row * 11}%`}]}/>)}
    {Array.from({length:48},(_,i) => <Candle key={i} index={i} running={!reduced && active}/>)}
  </View>;
}
function Candle({index, running}:{index:number;running:boolean}) {
  const phase = useSharedValue(0);
  useEffect(()=>{
    if(running) phase.set(withRepeat(withTiming(1,{duration:3000 + index % 7 * 400,easing:Easing.linear}),-1,true));
    else {cancelAnimation(phase);phase.set(0);}
    return ()=>cancelAnimation(phase);
  },[running,index,phase]);
  const motion = useAnimatedStyle(()=>({transform:[{translateY:(phase.get()-0.5)*(index%2 ? 46 : -46)},{scaleY:0.8+phase.get()*0.4}]}));
  const height=30 + index * 19 % 55;
  const color=index%4===1 ? '#b75d70' : '#2dcc98';
  return <Animated.View style={[styles.candle,{left:`${(index%8)*14-1}%`,top:`${Math.floor(index/8)*18+3+(index%3)*2}%`,opacity:0.15},motion]}>
    <View style={{height:height+30,width:1,backgroundColor:color,position:'absolute',top:-15,left:5}}/>
    <View style={{height,width:11,borderRadius:2,backgroundColor:color}}/>
  </Animated.View>;
}
const styles = StyleSheet.create({
  scene:{position:'absolute',top:0,right:0,bottom:0,left:0,overflow:'hidden'},
  grid:{position:'absolute',left:0,right:0,height:1,backgroundColor:'#2dcc98',opacity:0.045},
  candle:{position:'absolute'},
});
