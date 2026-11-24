import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../src/crypto.js';
import { MobileAuth } from '../src/mobile-auth.js';

afterEach(()=>{
  try {
    for (const [url,init] of vi.mocked(fetch).mock.calls) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(String(url)).toBe('https://sandbox.myfundedperpetuals.com/v1/orders?client_order_id=guardian-close-ticket&account_id=account');
      expect(new Headers(init?.headers).get('Authorization') === 'Bearer test-key').toBe(true);
    }
  } finally { vi.unstubAllGlobals(); }
});

const secrets = new SecretBox(Buffer.alloc(32,1).toString('base64'));
const check = {action:'check',operator:'Support'} as const;
const manual = {action:'resolve',operator:'Support',outcome:'submitted_verified',note:'Verified in the account history.'} as const;
const receipt = {dryRun:false,status:'filled',orderId:'real-order'};

function setup({age = 61, legacy = false, before = null as unknown, busy = false, missing = false} = {}) {
  let result = before;
  const rows = (...values: unknown[]) => ({rows:values,rowCount:values.length});
  const payload = {accountId:'account',marketId:'market',...(!legacy && {environment:'sandbox'})};
  const encryptedKey = secrets.encrypt('test-key');
  const audit: unknown[][] = [];
  const query = vi.fn(async (sql: string,args: unknown[] = []) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      expect(sql).toContain('submitted_at IS NOT NULL');
      expect(sql).toContain('result IS NULL');
      return result || busy || missing ? rows() : rows({payload,legacy,identity_id:'owner',submitted_age_seconds:age});
    }
    if (sql.includes('SELECT result')) return missing ? rows() : rows({result});
    if (sql.startsWith('SELECT environment')) {
      expect(args).toEqual(['owner']);
      return rows({environment:'sandbox',encrypted_api_key:encryptedKey,selected_account_id:'account'});
    }
    if (sql.startsWith('UPDATE')) {
      expect(sql).toContain('WHERE id=$1 AND result IS NULL');
      expect(result).toBeNull();
      result = JSON.parse(String(args[1]));
      return rows({});
    }
    if (sql.includes('INSERT INTO mobile_ticket_admin_audit')) audit.push(args);
    return rows();
  });
  const auth = new MobileAuth({pool:{connect:async()=>({query,release:vi.fn()})}} as never,secrets);
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify([])));
  vi.stubGlobal('fetch',request);
  return {auth,query,audit,request,result:()=>result};
}

describe('admin ticket actions', () => {
  it('records the real result and audits it in the same transaction', async () => {
    const {auth,query,audit,request,result} = setup({age:15});
    request.mockResolvedValueOnce(new Response(JSON.stringify({data:{orders:[
      {id:'real-order',status:'filled',client_order_id:'guardian-close-ticket',account_id:'account'},
    ]}})));
    expect(await auth.administerTicket('close','ticket',check)).toEqual({status:'resolved',lookup:'found',result:receipt});
    expect(result()).toEqual(receipt);
    expect(audit).toEqual([['Support','ticket','close','check',null,receipt,null,'found','resolved',null]]);
    expect(query.mock.calls.map(([sql])=>sql.trim().split(/\s+/)[0])).toEqual(['BEGIN','SELECT','SELECT','UPDATE','INSERT','COMMIT']);
  });

  it('records an aged 200 empty list as not submitted', async () => {
    const {auth,audit,result} = setup();
    expect((await auth.administerTicket('close','ticket',check)).status).toBe('resolved');
    expect(result()).toEqual({status:'not_submitted'});
    expect(audit[0]?.slice(4)).toEqual([null,{status:'not_submitted'},null,'absent','resolved',null]);
  });

  it.each([
    ['a recent empty list',59,200,[],'absent'],
    ['a non-200 empty list',61,201,[],'failed'],
    ['a missing resource',61,404,[],'failed'],
    ['a malformed response',61,200,{},'failed'],
  ] as const)('keeps %s uncertain and audits the check', async (_label,age,http,body,lookup) => {
    const {auth,audit,request,result} = setup({age});
    request.mockResolvedValueOnce(new Response(JSON.stringify(body),{status:http}));
    expect(await auth.administerTicket('close','ticket',check)).toEqual({status:lookup,lookup,result:null});
    expect(result()).toBeNull();
    expect(audit[0]?.slice(4)).toEqual([null,null,null,lookup,lookup,null]);
  });

  it('leaves an existing result intact and audits the attempted resolution', async () => {
    const {auth,query,audit,request,result} = setup({before:receipt});
    expect((await auth.administerTicket('close','ticket',{...manual,confirm:true})).status).toBe('already_resolved');
    expect(result()).toEqual(receipt);
    expect(request).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    expect(audit[0]?.slice(4,6)).toEqual([receipt,receipt]);
  });

  it('skips active senders and still audits the attempt', async () => {
    const {auth,audit,request,result} = setup({busy:true});
    expect((await auth.administerTicket('close','ticket',{...manual,confirm:true})).status).toBe('busy');
    expect(result()).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(audit[0]?.slice(4)).toEqual([null,null,manual.note,'skipped','busy','submitted_verified']);
  });

  it('audits a dry run and requires confirmation to record a manual outcome after a failed lookup', async () => {
    const {auth,audit,request,result} = setup();
    request.mockRejectedValue(new Error('Unavailable'));
    expect((await auth.administerTicket('close','ticket',{...manual,confirm:false})).status).toBe('dry_run');
    expect(result()).toBeNull();
    expect((await auth.administerTicket('close','ticket',{...manual,confirm:true})).status).toBe('resolved');
    expect(result()).toEqual({status:'submitted_verified',dryRun:false});
    expect(audit.map(row=>row.slice(4))).toEqual([
      [null,null,manual.note,'failed','dry_run','submitted_verified'],
      [null,result(),manual.note,'failed','resolved','submitted_verified'],
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('blocks a manual override when a fresh lookup finds the order', async () => {
    const {auth,audit,request,result} = setup();
    request.mockResolvedValueOnce(new Response(JSON.stringify([{id:'real-order',status:'filled'}])));
    expect((await auth.administerTicket('close','ticket',{...manual,confirm:true})).status).toBe('found_use_check');
    expect(result()).toBeNull();
    expect(audit[0]?.slice(4)).toEqual([null,null,manual.note,'found','found_use_check','submitted_verified']);
  });

  it('requires a confirmed verified submission when the lookup finds an incomplete order', async () => {
    const {auth,audit,request,result} = setup();
    request.mockImplementation(async () => new Response(JSON.stringify([{id:'real-order'}])));
    expect(await auth.administerTicket('close','ticket',check)).toEqual({status:'found',lookup:'found',result:null});
    expect((await auth.administerTicket('close','ticket',{...manual,outcome:'not_submitted',confirm:true})).status).toBe('found');
    expect((await auth.administerTicket('close','ticket',{...manual,confirm:false})).status).toBe('dry_run');
    expect(result()).toBeNull();
    expect(await auth.administerTicket('close','ticket',{...manual,confirm:true})).toEqual({
      status:'resolved',lookup:'found',result:{status:'submitted_verified',dryRun:false},
    });
    expect(audit.slice(1).map(row=>row.slice(4))).toEqual([
      [null,null,manual.note,'found','found','not_submitted'],
      [null,null,manual.note,'found','dry_run','submitted_verified'],
      [null,result(),manual.note,'found','resolved','submitted_verified'],
    ]);
  });

  it('leaves a legacy close uncertain after an empty lookup and permits a verified manual resolution', async () => {
    const {auth,audit,request,result} = setup({legacy:true});
    expect(await auth.administerTicket('close','ticket',check)).toEqual({status:'legacy',lookup:'absent',result:null});
    expect(result()).toBeNull();
    expect((await auth.administerTicket('close','ticket',{...manual,outcome:'not_submitted',confirm:true})).status).toBe('resolved');
    expect(result()).toEqual({status:'not_submitted'});
    expect(request).toHaveBeenCalledTimes(2);
    expect(audit.map(row=>row[7])).toEqual(['absent','absent']);
  });

  it('records a complete receipt found for a legacy close', async () => {
    const {auth,audit,request,result} = setup({legacy:true});
    request.mockResolvedValueOnce(new Response(JSON.stringify([{id:'real-order',status:'filled'}])));
    expect(await auth.administerTicket('close','ticket',check)).toEqual({status:'resolved',lookup:'found',result:receipt});
    expect(result()).toEqual(receipt);
    expect(audit[0]?.slice(4)).toEqual([null,receipt,null,'found','resolved',null]);
  });
});
