import { describe, expect, it, vi } from 'vitest';
import { validateIdentity, MobileAuth } from '../src/mobile-auth.js';

describe('native identity policy', () => {
  const fresh = { sub: 'provider-subject', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  it('requires matching Apple challenge', () => {
    expect(() => validateIdentity({...fresh, nonce:'correct'}, 'apple','wrong')).toThrow();
    expect(() => validateIdentity(fresh,'apple')).toThrow();
    expect(validateIdentity({...fresh,nonce:'correct'},'apple','correct').subject).toBe(fresh.sub);
  });
  it('rejects stale or missing identity claims', () => {
    expect(() => validateIdentity({...fresh,iat:1},'google')).toThrow();
    expect(() => validateIdentity({...fresh,sub:undefined},'google')).toThrow();
  });
  it('allows Apple repeat logins without email', () => {
    expect(validateIdentity({...fresh,nonce:'correct'},'apple','correct').email).toBeNull();
  });
});


describe('native connection ownership', () => {
  it('blocks account changes and disconnects without a valid session', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const auth = new MobileAuth({pool:{query}} as never);
    await expect(auth.selectAccount('invalid','other-account')).rejects.toThrow('Session expired');
    await expect(auth.disconnect('invalid')).rejects.toThrow('Session expired');
    expect(query.mock.calls.every(call => String(call[0]).startsWith('SELECT'))).toBe(true);
  });
  it('scopes a connection read to the verified identity', async () => {
    const query = vi.fn().mockResolvedValueOnce({rows:[{id:'identity-a'}]}).mockResolvedValueOnce({rows:[]});
    const auth = new MobileAuth({pool:{query}} as never);
    expect(await auth.connection('session')).toBeUndefined();
    expect(query.mock.calls[1]?.[1]).toEqual(['identity-a']);
  });
});
