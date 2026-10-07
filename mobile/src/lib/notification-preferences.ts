export type NotificationPreferences={news:boolean;alerts:boolean;digest:boolean};
export const notificationsEnabled=(p:NotificationPreferences)=>p.news||p.alerts||p.digest;
export function parseNotificationPreferences(value:unknown):NotificationPreferences|null{
 if(!value||typeof value!=='object')return null;const p=value as Record<string,unknown>;
 return ['news','alerts','digest'].every(k=>typeof p[k]==='boolean')?{news:p.news as boolean,alerts:p.alerts as boolean,digest:p.digest as boolean}:null;
}
export function sameNotificationPreferences(a:NotificationPreferences,b:NotificationPreferences){return a.news===b.news&&a.alerts===b.alerts&&a.digest===b.digest;}
