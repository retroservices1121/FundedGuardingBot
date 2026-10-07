import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import {NotificationPreferences,notificationsEnabled,parseNotificationPreferences,sameNotificationPreferences} from './notification-preferences';
type Request=(path:string,method?:string,data?:unknown,token?:string)=>Promise<any>;
const queues=new Map<string,Promise<unknown>>();
function serial<T>(id:string,task:()=>Promise<T>):Promise<T>{const next=(queues.get(id)??Promise.resolve()).catch(()=>{}).then(task);queues.set(id,next);return next;}
export async function storedNotificationPreferences(id:string){const raw=await SecureStore.getItemAsync(`guardian-push-prefs-${id}`);try{return raw?parseNotificationPreferences(JSON.parse(raw)):null;}catch{return null;}}
async function sync(id:string,token:string,request:Request){
 const key=`guardian-push-${id}`,saved=await SecureStore.getItemAsync(key);let prefs=await storedNotificationPreferences(id);
 if(!prefs){const remote=await request(`notifications?pushToken=${encodeURIComponent(saved??'')}`,'GET',undefined,token);prefs=parseNotificationPreferences(remote);if(!prefs)throw new Error('Could not read notification settings.');await SecureStore.setItemAsync(`guardian-push-prefs-${id}`,JSON.stringify(prefs));}
 if(!notificationsEnabled(prefs)){if(saved)await request('notifications','DELETE',{pushToken:saved},token);return prefs;}
 const permission=await Notifications.getPermissionsAsync();if(!permission.granted)throw new Error('Your alert choices are saved. Allow notifications in iPhone Settings to receive them.');
 const projectId=Constants.expoConfig?.extra?.eas?.projectId??Constants.easConfig?.projectId;if(!projectId)throw new Error('Notification project is not configured.');
 const pushToken=(await Notifications.getExpoPushTokenAsync({projectId})).data;
 const remote=parseNotificationPreferences(await request(`notifications?pushToken=${encodeURIComponent(pushToken)}`,'GET',undefined,token));
 if(!remote||saved!==pushToken||!sameNotificationPreferences(prefs,remote))await request('notifications','POST',{pushToken,...prefs},token);
 await SecureStore.setItemAsync(key,pushToken);return prefs;
}
export function syncNotificationRegistration(id:string,token:string,request:Request){return serial(id,()=>sync(id,token,request));}
export function saveNotificationPreferences(id:string,token:string,request:Request,prefs:NotificationPreferences){return serial(id,async()=>{
 await SecureStore.setItemAsync(`guardian-push-prefs-${id}`,JSON.stringify(prefs));
 if(notificationsEnabled(prefs)){let permission=await Notifications.getPermissionsAsync();if(!permission.granted)permission=await Notifications.requestPermissionsAsync();if(!permission.granted)throw new Error('Your alert choices are saved. Allow notifications in iPhone Settings to receive them.');}
 return sync(id,token,request);
});}
