import {describe,it,expect,vi} from 'vitest';
import {MobilePush,notificationInput} from '../src/mobile-push.js';
import type {Database} from '../src/db.js';
describe('Pulse notification consent',()=>{
 it('rejects missing consent and invalid tokens',()=>{expect(()=>notificationInput({pushToken:'ExpoPushToken[abc]'})).toThrow();expect(()=>notificationInput({pushToken:'x',news:true,alerts:true,digest:true})).toThrow();});
 it('accepts explicit disabled preferences',()=>{expect(notificationInput({pushToken:'ExpoPushToken[abc]',news:false,alerts:false,digest:false}).news).toBe(false);});
 it('defaults unregistered users to no notifications',async()=>{const query=vi.fn().mockResolvedValue({rows:[]});expect(await new MobilePush({pool:{query}} as unknown as Database).preferences('user')).toEqual({news:false,alerts:false,digest:false});});
 it('does not send a delivery already claimed by another worker',async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[{push_token:'ExpoPushToken[abc]',id:'news-1'}]}).mockResolvedValueOnce({rowCount:0});const fetchSpy=vi.spyOn(globalThis,'fetch');await new MobilePush({pool:{query}} as unknown as Database).send();expect(fetchSpy).not.toHaveBeenCalled();fetchSpy.mockRestore();});
});
