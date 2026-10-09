import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashReviewPassword, reviewCredentials, verifyReviewPassword } from '../src/review-login.js';
import { MobileAuth } from '../src/mobile-auth.js';
let encoded: string;
const password = 'test-only-secret-123';
beforeAll(async () => { encoded = await hashReviewPassword(password); });
afterEach(() => vi.unstubAllEnvs());
function configure() {
  vi.stubEnv('GUARDIAN_REVIEW_EMAIL','review@example.invalid');
  vi.stubEnv('GUARDIAN_REVIEW_PASSWORD_HASH',encoded);
}
function database(attempts=1) {
  const query=vi.fn().mockResolvedValue({rows:[{attempts}]});
  const clientQuery=vi.fn().mockImplementation(async (sql:string)=>({rows:sql.includes('RETURNING id,provider,email')?[{id:'review-id',provider:'email',email:'review@example.invalid'}]:[]}));
  const release=vi.fn();
  const connect=vi.fn().mockResolvedValue({query:clientQuery,release});
  return {query,clientQuery,connect,release,auth:new MobileAuth({pool:{query,connect}} as never)};
}
describe('provisioned email access',()=>{
 it('uses salted hashes, accepts the correct password and rejects incorrect or malformed input',async()=>{
  expect(encoded).not.toContain(password);
  expect(await verifyReviewPassword(password,encoded)).toBe(true);
  expect(await verifyReviewPassword('wrong',encoded)).toBe(false);
  expect(await verifyReviewPassword(password,'malformed')).toBe(false);
  expect(await verifyReviewPassword('x'.repeat(257),encoded)).toBe(false);
  expect(await hashReviewPassword(password)).not.toBe(encoded);
 });
 it('is disabled without valid server configuration',async()=>{
  vi.stubEnv('GUARDIAN_REVIEW_EMAIL','');vi.stubEnv('GUARDIAN_REVIEW_PASSWORD_HASH','');
  expect(reviewCredentials()).toBeUndefined();
  const d=database();await expect(d.auth.loginEmail('review@example.invalid',password)).rejects.toThrow('unavailable');expect(d.query).not.toHaveBeenCalled();
 });
 it('does not grant access for the wrong email or password',async()=>{
  configure();const d=database();
  await expect(d.auth.loginEmail('other@example.invalid',password)).rejects.toThrow('incorrect');
  await expect(d.auth.loginEmail('review@example.invalid','wrong')).rejects.toThrow('incorrect');
  expect(d.connect).not.toHaveBeenCalled();
 });
 it('creates a real session for a normalized matching email and never stores the plaintext token',async()=>{
  configure();const d=database();const result=await d.auth.loginEmail(' REVIEW@example.invalid ',password);
  expect(result.user.provider).toBe('email');expect(result.token.length).toBeGreaterThan(32);
  const call=d.clientQuery.mock.calls.find(c=>String(c[0]).includes('INSERT INTO mobile_sessions'));
  expect(call?.[1][0]).toBe(createHash('sha256').update(result.token).digest('hex'));
  expect(d.clientQuery.mock.calls.some(c=>c[0]==='COMMIT')).toBe(true);expect(d.release).toHaveBeenCalledOnce();
 });
 it('enforces persistent attempt limits before password checks or session creation',async()=>{
  configure();const d=database(11);await expect(d.auth.loginEmail('review@example.invalid',password)).rejects.toThrow('15 minutes');expect(d.connect).not.toHaveBeenCalled();
 });
 it('invalidates email sessions when credentials are disabled or rotated',async()=>{
  configure();const d=database();d.query.mockResolvedValue({rows:[{id:'review-id',provider:'email',email:'review@example.invalid',subject:createHash('sha256').update(JSON.stringify(['review@example.invalid',encoded])).digest('hex')}]});
  expect((await d.auth.user('session')).id).toBe('review-id');
  vi.stubEnv('GUARDIAN_REVIEW_PASSWORD_HASH',await hashReviewPassword(password));await expect(d.auth.user('session')).rejects.toThrow('Session expired');
  vi.stubEnv('GUARDIAN_REVIEW_PASSWORD_HASH','');await expect(d.auth.user('session')).rejects.toThrow('Session expired');
 });
 it('rolls back and releases the database connection if session creation fails',async()=>{
  configure();const d=database();d.clientQuery.mockImplementation(async(sql:string)=>{if(sql.includes('INSERT INTO mobile_sessions'))throw new Error('db down');return {rows:[{id:'review-id'}]};});
  await expect(d.auth.loginEmail('review@example.invalid',password)).rejects.toThrow('Could not sign in');expect(d.clientQuery).toHaveBeenCalledWith('ROLLBACK');expect(d.release).toHaveBeenCalledOnce();
 });
});
