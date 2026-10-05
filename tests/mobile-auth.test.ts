import { describe, expect, it } from 'vitest';
import { validateIdentity } from '../src/mobile-auth.js';

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
