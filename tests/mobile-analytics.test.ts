import {describe,it,expect,vi} from 'vitest';
import {adminAuthorized,installationInput,MobileAnalytics} from '../src/mobile-analytics.js';
import type {Database} from '../src/db.js';
describe('private mobile analytics',()=>{
 it('fails closed and checks the full admin token',()=>{expect(adminAuthorized('Bearer short','short')).toBe(false);const secret='a'.repeat(64);expect(adminAuthorized('Bearer '+secret,secret)).toBe(true);expect(adminAuthorized('Bearer '+'b'.repeat(64),secret)).toBe(false);expect(adminAuthorized(undefined,secret)).toBe(false);});
 it('allows only mobile platforms and validated install IDs',()=>{expect(installationInput({installId:'x'.repeat(30),platform:'android',version:'1.0.2'}).platform).toBe('android');expect(()=>installationInput({installId:'x'.repeat(30),platform:'web'})).toThrow();expect(()=>installationInput({installId:"'; drop table users",platform:'ios'})).toThrow();});
 it('upserts installation records rather than counting every launch again',async()=>{const query=vi.fn().mockResolvedValue({rows:[]});const analytics=new MobileAnalytics({pool:{query}} as unknown as Database);await analytics.track({installId:'x'.repeat(30),platform:'ios'});expect(query.mock.calls[1]?.[0]).toContain('ON CONFLICT(install_id)');expect(query.mock.calls[1]?.[1]).toEqual(['x'.repeat(30),'ios','unknown',null]);});
});
