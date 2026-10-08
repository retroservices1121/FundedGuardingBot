import {useEffect,useRef} from 'react';
import {AppState} from 'react-native';
import {useSession} from '../../App';
import {syncNotificationRegistration} from '../lib/notification-registration';
import {router,useRootNavigationState} from 'expo-router';
import * as Notifications from 'expo-notifications';
Notifications.setNotificationHandler({handleNotification:async()=>({shouldPlaySound:true,shouldSetBadge:false,shouldShowBanner:true,shouldShowList:true})});
export default function NotificationNavigation(){
 const {user,token,request,demo}=useSession();
 useEffect(()=>{if(demo)return;const sync=()=>{void syncNotificationRegistration(user.id,token,request).catch(()=>{});};sync();const app=AppState.addEventListener('change',state=>{if(state==='active')sync();});const push=Notifications.addPushTokenListener(sync);return()=>{app.remove();push.remove();};},[user.id,token,request,demo]);
 const navigation=useRootNavigationState();const seen=useRef('');
 useEffect(()=>{if(demo||!navigation?.key)return;const open=(response:Notifications.NotificationResponse|null)=>{if(!response||response.notification.request.content.data?.screen!=='pulse')return;const id=response.notification.request.identifier;if(seen.current===id)return;seen.current=id;router.push('/pulse');void Notifications.clearLastNotificationResponseAsync();};open(Notifications.getLastNotificationResponse());const subscription=Notifications.addNotificationResponseReceivedListener(open);return()=>subscription.remove();},[navigation?.key,demo]);return null;
}
