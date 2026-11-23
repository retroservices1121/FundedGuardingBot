import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateIdentity, MobileAuth } from '../src/mobile-auth.js';
import { SecretBox } from '../src/crypto.js';
import { MfpClient } from '../src/mfp.js';

afterEach(()=>vi.restoreAllMocks());
const secrets = new SecretBox(Buffer.alloc(32,1).toString('base64'));

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
    const auth = new MobileAuth({pool:{query}} as never,secrets);
    await expect(auth.selectAccount('invalid','other-account')).rejects.toThrow('Session expired');
    await expect(auth.disconnect('invalid')).rejects.toThrow('Session expired');
    expect(query.mock.calls.every(call => String(call[0]).startsWith('SELECT'))).toBe(true);
  });
  it('scopes a connection read to the verified identity', async () => {
    const query = vi.fn().mockResolvedValueOnce({rows:[{id:'identity-a'}]}).mockResolvedValueOnce({rows:[]});
    const auth = new MobileAuth({pool:{query}} as never,secrets);
    expect(await auth.connection('session')).toBeUndefined();
    expect(query.mock.calls[1]?.[1]).toEqual(['identity-a']);
  });
});

describe('native ticket recovery', () => {
  const ticket = {id:'new-ticket',accountId:'account',marketId:'market',expiresAt:Date.now()+10_000};

  function pendingMarket(kind: 'trade' | 'close', ageSeconds: number, active = false, environment = 'live', selectedAccount = ticket.accountId) {
    const table = kind === 'trade' ? 'mobile_trade_tickets' : 'mobile_close_tickets';
    const connection = {environment,encrypted_api_key:secrets.encrypt('test-key'),selected_account_id:selectedAccount};
    const pending = {id:'previous',identity_id:'previous-owner',kind};
    let storedResult: string | undefined;
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      const result = (rows: unknown[]) => ({rows,rowCount:rows.length});
      if (sql.includes('UNION ALL')) return result(storedResult ? [] : [pending]);
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        expect(sql).toContain(`FROM ${table}`);
        expect(sql).toContain('EXTRACT(EPOCH FROM clock_timestamp() - submitted_at)::double precision AS submitted_age_seconds');
        expect(args).toEqual([pending.id,pending.identity_id]);
        return result(active ? [] : [{payload:{...ticket,environment:'live'},submitted_age_seconds:ageSeconds}]);
      }
      if (sql.startsWith('SELECT environment')) {
        expect(args).toEqual([pending.identity_id]);
        return result([connection]);
      }
      if (sql.startsWith(`UPDATE ${table} SET result`)) storedResult = String(args?.[1]);
      return result([{id:ticket.id}]);
    });
    const pool = {
      query:vi.fn().mockResolvedValue({rows:[{id:'new-owner'}]}),
      connect:vi.fn().mockResolvedValue({query,release:vi.fn()}),
    };
    const auth = new MobileAuth({pool} as never,secrets);
    const lookup = vi.spyOn(MfpClient.prototype,'findOrderByClientOrderId').mockResolvedValue({status:'absent'});
    return {auth,query,lookup,result:()=>storedResult && JSON.parse(storedResult)};
  }

  it.each([
    ['trade','guardian-native-previous'],
    ['close','guardian-close-previous'],
  ] as const)('reconciles an aged pending %s before issuing a market quote', async (kind,orderId) => {
    const {auth,query,lookup,result} = pendingMarket(kind,60);
    await expect(auth.saveTicket('session',ticket as never)).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(orderId,ticket.accountId);
    expect(result()).toEqual({status:'not_submitted'});
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO mobile_trade_tickets'),expect.any(Array));
  });

  it.each([
    ['an absence just under 60 seconds',59.999999,false,'live',true],
    ['active write',61,true,'live',false],
    ['changed environment',61,false,'sandbox',false],
  ] as const)('keeps the market locked on %s', async (_case,age,active,environment,checksOrder) => {
    const {auth,query,lookup,result} = pendingMarket('trade',age,active,environment);
    await expect(auth.saveTicket('session',ticket as never)).rejects.toThrow('still being checked');
    expect(lookup).toHaveBeenCalledTimes(checksOrder ? 1 : 0);
    expect(result()).toBeUndefined();
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO mobile_trade_tickets'),expect.any(Array));
  });

  it('keeps an empty lookup uncertain when the connection can no longer access the original account', async () => {
    const {auth,lookup,result} = pendingMarket('trade',61,false,'live','other-account');
    const account = vi.spyOn(MfpClient.prototype,'getAccount').mockRejectedValue(new Error('Account is unavailable'));
    await expect(auth.saveTicket('session',ticket as never)).rejects.toThrow('still being checked');
    expect(lookup).toHaveBeenCalledExactlyOnceWith('guardian-native-previous',ticket.accountId);
    expect(account).toHaveBeenCalledExactlyOnceWith(ticket.accountId);
    expect(result()).toBeUndefined();
  });
});
