import {useEffect,useRef} from 'react';
import {router,useRootNavigationState} from 'expo-router';
import * as Notifications from 'expo-notifications';
Notifications.setNotificationHandler({handleNotification:async()=>({shouldPlaySound:true,shouldSetBadge:false,shouldShowBanner:true,shouldShowList:true})});
export default function NotificationNavigation(){
 const navigation=useRootNavigationState();const seen=useRef('');
 useEffect(()=>{if(!navigation?.key)return;const open=(response:Notifications.NotificationResponse|null)=>{if(!response||response.notification.request.content.data?.screen!=='pulse')return;const id=response.notification.request.identifier;if(seen.current===id)return;seen.current=id;router.push('/pulse');void Notifications.clearLastNotificationResponseAsync();};open(Notifications.getLastNotificationResponse());const subscription=Notifications.addNotificationResponseReceivedListener(open);return()=>subscription.remove();},[navigation?.key]);return null;
}
