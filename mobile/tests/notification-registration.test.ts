import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({storage:new Map<string,string>(),getToken:vi.fn(),permission:vi.fn(),easConfig:{projectId:'test' as string|undefined}}));
vi.mock('expo-secure-store',()=>({getItemAsync:async(k:string)=>mocks.storage.get(k)??null,setItemAsync:async(k:string,v:string)=>{mocks.storage.set(k,v);}}));
vi.mock('expo-notifications',()=>({getPermissionsAsync:mocks.permission,requestPermissionsAsync:mocks.permission,getExpoPushTokenAsync:mocks.getToken}));
vi.mock('expo-constants',()=>({default:{easConfig:mocks.easConfig}}));
import {saveNotificationPreferences,syncNotificationRegistration,storedNotificationPreferences} from '../src/lib/notification-registration';
const on={news:true,alerts:true,digest:false},off={news:false,alerts:false,digest:false};
beforeEach(()=>{mocks.storage.clear();vi.clearAllMocks();mocks.easConfig.projectId='test';mocks.permission.mockResolvedValue({granted:true});mocks.getToken.mockResolvedValue({data:'ExpoPushToken[new]'});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('persistent notification choices',()=>{
 it('restores enabled preferences when the server lost the device registration',async()=>{mocks.storage.set('guardian-push-prefs-restore',JSON.stringify(on));const request=vi.fn().mockResolvedValue(off);await syncNotificationRegistration('restore','session',request);expect(request).toHaveBeenCalledWith('notifications','POST',{pushToken:'ExpoPushToken[new]',...on},'session');expect(await storedNotificationPreferences('restore')).toEqual(on);});
 it('registers a rotated token without changing choices',async()=>{mocks.storage.set('guardian-push-prefs-rotate',JSON.stringify(on));mocks.storage.set('guardian-push-rotate','ExpoPushToken[old]');const request=vi.fn().mockResolvedValue(on);await syncNotificationRegistration('rotate','session',request);expect(request).toHaveBeenCalledWith('notifications','POST',{pushToken:'ExpoPushToken[new]',...on},'session');expect(mocks.storage.get('guardian-push-rotate')).toBe('ExpoPushToken[new]');});
 it('does not register again when the token and settings are unchanged',async()=>{mocks.storage.set('guardian-push-prefs-same',JSON.stringify(on));mocks.storage.set('guardian-push-same','ExpoPushToken[new]');const request=vi.fn().mockResolvedValue(on);await syncNotificationRegistration('same','session',request);expect(request.mock.calls.some(c=>c[1]==='POST')).toBe(false);});
 it('preserves an explicit off choice and never silently enables it',async()=>{mocks.storage.set('guardian-push-off','ExpoPushToken[old]');const request=vi.fn().mockResolvedValue({ok:true});await saveNotificationPreferences('off','session',request,off);await syncNotificationRegistration('off','session',request);expect(mocks.getToken).not.toHaveBeenCalled();expect(await storedNotificationPreferences('off')).toEqual(off);});
 it('retains choices after a network error and repairs them on the next sync',async()=>{const request=vi.fn().mockRejectedValue(new Error('offline'));await expect(saveNotificationPreferences('retry','session',request,on)).rejects.toThrow('offline');expect(await storedNotificationPreferences('retry')).toEqual(on);request.mockResolvedValue(off);await syncNotificationRegistration('retry','session',request);expect(request).toHaveBeenCalledWith('notifications','POST',{pushToken:'ExpoPushToken[new]',...on},'session');});
 it('keeps choices saved when notifications are unavailable',async()=>{
  mocks.easConfig.projectId=undefined;
  vi.stubGlobal('__DEV__',false);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(saveNotificationPreferences('unavailable','session',vi.fn(),on)).rejects.toThrow('Notifications are unavailable right now. Your choices are saved.');
  expect(await storedNotificationPreferences('unavailable')).toEqual(on);
  expect(mocks.getToken).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
 });
});
