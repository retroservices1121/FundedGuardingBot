import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { TradeTicket } from './types.js';
import type { Database } from './db.js';
import type { PoolClient } from 'pg';
import { MobileSessionError, MobileValidationError, MobileWriteUncertainError } from './mobile-errors.js';
import { reviewCredentials, verifyReviewPassword } from './review-login.js';
import type { SecretBox } from './crypto.js';
import { closeClientOrderId, MfpClient } from './mfp.js';
import { entryClientOrderId, mobileOrderHosts, orderLookupResult } from './mobile-order.js';

export const GOOGLE_IOS_CLIENT_ID = '174585846381-7nrqvpr243ndbk91gst8mjrubhkmnbdk.apps.googleusercontent.com';
const keys = {
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
  google: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
};
export type Provider = keyof typeof keys;
export function validateIdentity(payload: JWTPayload, provider: Provider, nonce?: string) {
  if (!payload.sub || !payload.iat || payload.iat > Date.now() / 1000 + 60 || payload.iat < Date.now() / 1000 - 600) throw new Error('Sign-in expired. Please try again.');
  if (provider === 'apple' && (!nonce || payload.nonce !== nonce)) throw new Error('Invalid sign-in challenge.');
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type TicketMarket = { accountId: string; marketId: string };
type TicketTable = 'mobile_trade_tickets' | 'mobile_close_tickets';
const ticketTables = {trade:'mobile_trade_tickets',close:'mobile_close_tickets'} as const;
type TicketKind = keyof typeof ticketTables;
type TicketResolution = 'not_submitted' | 'submitted_verified';
type TicketAdminAction = {operator: string; note?: string} &
  ({action: 'check'} | {action: 'resolve'; outcome: TicketResolution; note: string; confirm: boolean});
// New quotes carry this flag until a server that supports reconciliation claims them.
// An older server can claim a quote during a rolling deploy without clearing the flag.
const currentTicket = "COALESCE(payload->>'environment' IN ('live','sandbox') AND NOT (payload ? 'awaitingClaim'),false)";
const closeOrderOnly = "payload->>'kind' IS DISTINCT FROM 'protection'";
const ticketAge = 'EXTRACT(EPOCH FROM clock_timestamp() - submitted_at)::double precision';
type MobileTradeTicket = TradeTicket & {environment?: keyof typeof mobileOrderHosts};
type PendingTicket = {
  payload: TicketMarket & {environment: keyof typeof mobileOrderHosts};
  identity_id: string; submitted_age_seconds: number; legacy: boolean;
};
type TicketLookup = {
  lookup: 'legacy' | 'failed' | 'found' | 'absent';
  result?: ReturnType<typeof orderLookupResult>;
};
type CloseTicketInput = { id: string; expiresAt: number; accountId: string; [key: string]: unknown } &
  ({ kind?: undefined; marketId: string } | { kind: 'protection' });
export class MobileAuth {
  constructor(private db: Database, private secrets?: SecretBox) {}
  async migrate() {
    await this.db.pool.query(`
      SELECT pg_advisory_xact_lock(hashtextextended('mobile_auth_migrate', 0));
      CREATE TABLE IF NOT EXISTS mobile_identities (
        id UUID PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL,
        email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(provider, subject)
      );
      CREATE TABLE IF NOT EXISTS mobile_connections (
        identity_id UUID PRIMARY KEY REFERENCES mobile_identities(id) ON DELETE CASCADE,
        environment TEXT NOT NULL CHECK(environment IN ('live','sandbox')),
        encrypted_api_key TEXT NOT NULL, key_last_four TEXT NOT NULL,
        selected_account_id TEXT NOT NULL, guardian_mode TEXT NOT NULL DEFAULT 'off'
      );
      ALTER TABLE mobile_connections ADD COLUMN IF NOT EXISTS personal_guards JSONB NOT NULL DEFAULT '{"mode":"off"}'::jsonb;
      CREATE TABLE IF NOT EXISTS mobile_close_tickets (
        id TEXT PRIMARY KEY, identity_id UUID NOT NULL REFERENCES mobile_identities(id) ON DELETE CASCADE,
        payload JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, submitted_at TIMESTAMPTZ
      );
      ALTER TABLE mobile_close_tickets ADD COLUMN IF NOT EXISTS result JSONB;
      CREATE TABLE IF NOT EXISTS mobile_trade_tickets (
        id TEXT PRIMARY KEY, identity_id UUID NOT NULL REFERENCES mobile_identities(id) ON DELETE CASCADE,
        payload JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        submitted_at TIMESTAMPTZ, result JSONB
      );
      CREATE TABLE IF NOT EXISTS mobile_ticket_admin_audit (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        operator TEXT NOT NULL, ticket_id TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
        before_result JSONB, after_result JSONB, note TEXT,
        lookup_status TEXT NOT NULL, outcome TEXT NOT NULL, requested_outcome TEXT,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS mobile_schema_migrations (id TEXT PRIMARY KEY);
      WITH first_run AS (
        INSERT INTO mobile_schema_migrations VALUES ('legacy_order_ticket_results')
        ON CONFLICT DO NOTHING RETURNING id
      ), close_backfill AS (
        UPDATE mobile_close_tickets SET result='{"status":"legacy"}'::jsonb
        WHERE submitted_at IS NOT NULL AND result IS NULL AND NOT ${currentTicket} AND EXISTS (SELECT 1 FROM first_run)
      )
      UPDATE mobile_trade_tickets SET result='{"status":"legacy"}'::jsonb
      WHERE submitted_at IS NOT NULL AND result IS NULL AND NOT ${currentTicket} AND EXISTS (SELECT 1 FROM first_run);
      CREATE INDEX IF NOT EXISTS mobile_trade_pending_market_idx ON mobile_trade_tickets ((payload->>'accountId'), (payload->>'marketId'))
        WHERE submitted_at IS NOT NULL AND result IS NULL;
      CREATE INDEX IF NOT EXISTS mobile_close_pending_market_idx ON mobile_close_tickets ((payload->>'accountId'), (payload->>'marketId'))
        WHERE submitted_at IS NOT NULL AND result IS NULL AND payload->>'kind' IS DISTINCT FROM 'protection';
      CREATE TABLE IF NOT EXISTS mobile_email_login_attempts (
        identity_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      DELETE FROM mobile_email_login_attempts WHERE expires_at < NOW();
      CREATE TABLE IF NOT EXISTS mobile_sessions (
        token_hash TEXT PRIMARY KEY, identity_id UUID NOT NULL REFERENCES mobile_identities(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_auth_challenges (
        nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_used_tokens (
        token_hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL
      );
      DELETE FROM mobile_sessions WHERE expires_at < NOW();
      DELETE FROM mobile_auth_challenges WHERE expires_at < NOW();
      DELETE FROM mobile_used_tokens WHERE expires_at < NOW();
    `);
  }
  async challenge() {
    const nonce = randomBytes(32).toString('hex');
    await this.db.pool.query(`INSERT INTO mobile_auth_challenges VALUES ($1,NOW()+INTERVAL '5 minutes')`, [nonce]);
    return nonce;
  }
  async login(provider: Provider, token: string, nonce?: string) {
    const { payload } = await jwtVerify(token, keys[provider], {
      issuer: provider === 'apple' ? 'https://appleid.apple.com' : ['https://accounts.google.com', 'accounts.google.com'],
      audience: provider === 'apple' ? 'com.retroservices1121.guardian' : GOOGLE_IOS_CLIENT_ID,
      algorithms: ['RS256'], requiredClaims: ['sub','exp','iat'],
    });
    const identity = validateIdentity(payload, provider, nonce);
    const client = await this.db.pool.connect();
    const sessionToken = randomBytes(32).toString('base64url');
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (provider === 'apple') {
        const used = await client.query(`DELETE FROM mobile_auth_challenges WHERE nonce=$1 AND expires_at>NOW() RETURNING nonce`, [nonce]);
        if (!used.rowCount) throw new Error('Sign-in challenge expired. Please try again.');
      }
      await client.query(`INSERT INTO mobile_used_tokens VALUES ($1,to_timestamp($2))`, [hash(token), payload.exp]);
      const result = await client.query(`INSERT INTO mobile_identities (id,provider,subject,email) VALUES ($1,$2,$3,$4)
        ON CONFLICT(provider,subject) DO UPDATE SET email=COALESCE(EXCLUDED.email,mobile_identities.email) RETURNING id,provider,email`,
        [randomUUID(),provider,identity.subject,identity.email]);
      const user = result.rows[0];
      await client.query(`INSERT INTO mobile_sessions VALUES ($1,$2,NOW()+INTERVAL '30 days')`, [hash(sessionToken),user.id]);
      await client.query('COMMIT');
      return { token: sessionToken, user };
    } catch {
      await client.query('ROLLBACK');
      throw new Error('Could not verify sign-in. Please try again.');
    } finally { client.release(); }
  }
  async loginEmail(email: string, password: string) {
    const credentials = reviewCredentials();
    const failure = 'Email or password is incorrect, or email access is unavailable.';
    if (!credentials) throw new MobileSessionError(failure);
    // Persist a shared account throttle across processes and deploys.
    const attempt = await this.db.pool.query(`INSERT INTO mobile_email_login_attempts (identity_hash,attempts,expires_at)
      VALUES ($1,1,NOW()+INTERVAL '15 minutes') ON CONFLICT(identity_hash) DO UPDATE SET
      attempts=CASE WHEN mobile_email_login_attempts.expires_at<=NOW() THEN 1 ELSE mobile_email_login_attempts.attempts+1 END,
      expires_at=CASE WHEN mobile_email_login_attempts.expires_at<=NOW() THEN NOW()+INTERVAL '15 minutes' ELSE mobile_email_login_attempts.expires_at END
      RETURNING attempts`, [hash(credentials.email)]);
    if (attempt.rows[0].attempts > 10) throw new MobileValidationError('Too many email sign-in attempts. Try again in 15 minutes.');
    const valid = await verifyReviewPassword(password, credentials.passwordHash);
    if (!valid || email.trim().toLowerCase() !== credentials.email) throw new MobileSessionError(failure);
    const client = await this.db.pool.connect();
    const sessionToken = randomBytes(32).toString('base64url');
    try {
      await client.query('BEGIN');
      const result = await client.query(`INSERT INTO mobile_identities (id,provider,subject,email) VALUES ($1,'email',$2,$3)
        ON CONFLICT(provider,subject) DO UPDATE SET email=EXCLUDED.email RETURNING id,provider,email`,
        [randomUUID(), hash(JSON.stringify([credentials.email, credentials.passwordHash])), credentials.email]);
      const user = result.rows[0];
      await client.query(`INSERT INTO mobile_sessions VALUES ($1,$2,NOW()+INTERVAL '30 days')`, [hash(sessionToken),user.id]);
      await client.query(`DELETE FROM mobile_email_login_attempts WHERE identity_hash=$1`, [hash(credentials.email)]);
      await client.query('COMMIT');
      return { token: sessionToken, user };
    } catch {
      await client.query('ROLLBACK');
      throw new Error('Could not sign in. Please try again.');
    } finally { client.release(); }
  }
  async user(token: string) {
    const result = await this.db.pool.query(`SELECT i.id,i.provider,i.email,i.subject FROM mobile_sessions s JOIN mobile_identities i ON i.id=s.identity_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [hash(token)]);
    const user = result.rows[0];
    const credentials = user?.provider === 'email' ? reviewCredentials() : undefined;
    if (!user || (user.provider === 'email' && (!credentials || user.email !== credentials.email || user.subject !== hash(JSON.stringify([credentials.email, credentials.passwordHash]))))) throw new MobileSessionError('Session expired. Please sign in again.');
    return result.rows[0];
  }
  async connection(token: string) {
    const user = await this.user(token);
    const result = await this.db.pool.query(`SELECT * FROM mobile_connections WHERE identity_id=$1`, [user.id]);
    return result.rows[0];
  }
  async saveConnection(token: string, input: { environment: string; encryptedApiKey: string; keyLastFour: string; accountId: string }) {
    const user = await this.user(token);
    await this.db.pool.query(`INSERT INTO mobile_connections (identity_id,environment,encrypted_api_key,key_last_four,selected_account_id) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(identity_id) DO UPDATE SET environment=$2,encrypted_api_key=$3,key_last_four=$4,selected_account_id=$5`,
      [user.id,input.environment,input.encryptedApiKey,input.keyLastFour,input.accountId]);
  }
  async saveGuards(token:string, guards:unknown) {
    const user=await this.user(token);
    const result=await this.db.pool.query(`UPDATE mobile_connections SET personal_guards=$2,guardian_mode=$3 WHERE identity_id=$1`,[user.id,JSON.stringify(guards),(guards as {mode:string}).mode]);
    if(!result.rowCount)throw new Error('Connect MyFundedPerps first.');
  }
  async disableQuickTrade(token:string) {
    const user=await this.user(token);
    const result=await this.db.pool.query(`UPDATE mobile_connections SET personal_guards=personal_guards || '{"quickTradeEnabled":false}'::jsonb WHERE identity_id=$1 RETURNING personal_guards`,[user.id]);
    if(!result.rowCount)throw new MobileValidationError('Connect MyFundedPerps first.');
    return result.rows[0].personal_guards;
  }
  async selectAccount(token: string, id: string) {
    const user = await this.user(token);
    await this.db.pool.query(`UPDATE mobile_connections SET selected_account_id=$2 WHERE identity_id=$1`, [user.id,id]);
  }
  async disconnect(token: string) {
    const user = await this.user(token);
    await this.db.pool.query(`DELETE FROM mobile_connections WHERE identity_id=$1`, [user.id]);
  }
  private async ticketTransaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async withMarketTicket<T>({accountId,marketId}: TicketMarket, run: (client: PoolClient) => Promise<T>, sameTicket?: string) {
    const outcome = await this.ticketTransaction(async client => {
      // Serialize quote issuance and claims across both tables, including other app sessions.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[JSON.stringify([accountId,marketId])]);
      const pendingQuery = `
        SELECT id,identity_id,'trade' AS kind FROM mobile_trade_tickets
          WHERE payload->>'accountId'=$1 AND payload->>'marketId'=$2 AND submitted_at IS NOT NULL AND result IS NULL
            AND ${currentTicket} AND id IS DISTINCT FROM $3
        UNION ALL
        SELECT id,identity_id,'close' AS kind FROM mobile_close_tickets
          WHERE payload->>'accountId'=$1 AND payload->>'marketId'=$2 AND submitted_at IS NOT NULL AND result IS NULL
            AND ${currentTicket} AND ${closeOrderOnly} AND id IS DISTINCT FROM $3
        LIMIT 1`;
      const args = [accountId,marketId,sameTicket ?? null];
      const pending = await client.query<{id: string; identity_id: string; kind: TicketKind}>(pendingQuery,args);
      const previous = pending.rows[0];
      if (previous) {
        const table = ticketTables[previous.kind];
        await this.reconcilePendingTicket(client,table,previous.id,previous.identity_id);
        // A concurrent writer may have finished, or another older ticket may still be pending.
        const remaining = await client.query(pendingQuery,args);
        if (remaining.rowCount) return {blocked:true} as const;
      }
      return {blocked:false,result:await run(client)} as const;
    });
    if (outcome.blocked) throw new MobileWriteUncertainError('A previous request for this market is still being checked.');
    return outcome.result;
  }
  private async reconcilePendingTicket(client: PoolClient, table: TicketTable, id: string, identityId: string) {
    // An active sender holds this row lock until its write finishes.
    const kind = table === 'mobile_close_tickets' ? ` AND ${closeOrderOnly}` : '';
    const {rows:[ticket]} = await client.query<PendingTicket>(`SELECT payload,identity_id,${ticketAge} AS submitted_age_seconds FROM ${table}
      WHERE id=$1 AND identity_id=$2 AND submitted_at IS NOT NULL AND result IS NULL AND ${currentTicket}${kind} FOR UPDATE SKIP LOCKED`,[id,identityId]);
    if (!ticket) return;
    const {result} = await this.lookupTicket(client,table,id,ticket);
    if (!result) return;
    await client.query(`UPDATE ${table} SET result=$2 WHERE id=$1 AND result IS NULL`,[id,JSON.stringify(result)]);
    return result;
  }
  private async lookupTicket(client: PoolClient, table: TicketTable, id: string, ticket: PendingTicket): Promise<TicketLookup> {
    if (ticket.legacy) return {lookup:'legacy'} as const;
    if (!this.secrets) return {lookup:'failed'} as const;
    const {rows:[connection]} = await client.query(`SELECT environment,encrypted_api_key,selected_account_id FROM mobile_connections WHERE identity_id=$1`,[ticket.identity_id]);
    const host = mobileOrderHosts[ticket.payload.environment];
    if (!host || connection?.environment !== ticket.payload.environment) return {lookup:'failed'} as const;
    let apiKey: string;
    try { apiKey = this.secrets.decrypt(connection.encrypted_api_key); }
    catch { return {lookup:'failed'} as const; }
    const mfp = new MfpClient(host,apiKey);
    const clientOrderId = table === 'mobile_close_tickets' ? closeClientOrderId(id) : entryClientOrderId(id);
    const lookup = await mfp.findOrderByClientOrderId(clientOrderId,ticket.payload.accountId).catch(() => ({status:'failed'} as const));
    const result = orderLookupResult(lookup,ticket.submitted_age_seconds);
    if (result?.status === 'not_submitted' && connection.selected_account_id !== ticket.payload.accountId) {
      const account = await mfp.getAccount(ticket.payload.accountId).catch(() => undefined);
      if (account?.id !== ticket.payload.accountId) return {lookup:'failed'} as const;
    }
    return {lookup:lookup.status,result};
  }
  async reconcileTicket(token: string, id: string, close = false) {
    const user = await this.user(token);
    const table = close ? 'mobile_close_tickets' : 'mobile_trade_tickets';
    return this.ticketTransaction(client => this.reconcilePendingTicket(client,table,id,user.id));
  }
  async listUncertainTickets() {
    const columns = `id,identity_id AS user_id,payload->>'accountId' AS account,payload->>'marketId' AS market,
      submitted_at,${ticketAge} AS age_seconds,NOT ${currentTicket} AS legacy`;
    const pending = 'submitted_at IS NOT NULL AND result IS NULL';
    const {rows} = await this.db.pool.query(`
      SELECT ${columns},'trade' AS kind FROM mobile_trade_tickets WHERE ${pending}
      UNION ALL
      SELECT ${columns},'close' AS kind FROM mobile_close_tickets WHERE ${pending} AND ${closeOrderOnly}
      ORDER BY submitted_at,id`);
    return rows;
  }
  async administerTicket(kind: TicketKind, id: string, input: TicketAdminAction) {
    const table = ticketTables[kind];
    const scope = `id=$1 AND submitted_at IS NOT NULL${kind === 'close' ? ` AND ${closeOrderOnly}` : ''}`;
    return this.ticketTransaction(async client => {
      const {rows:[ticket]} = await client.query<PendingTicket>(`
        SELECT payload,identity_id,${ticketAge} AS submitted_age_seconds,NOT ${currentTicket} AS legacy FROM ${table}
        WHERE ${scope} AND result IS NULL FOR UPDATE SKIP LOCKED`,[id]);
      let before: unknown = null;
      let after: unknown = null;
      let lookup = 'skipped';
      let status: string;
      if (!ticket) {
        const {rows:[existing]} = await client.query(`SELECT result FROM ${table} WHERE ${scope}`,[id]);
        before = after = existing?.result ?? null;
        status = !existing ? 'missing' : before === null ? 'busy' : 'already_resolved';
      } else {
        const checked = await this.lookupTicket(client,table,id,ticket);
        lookup = checked.lookup;
        status = lookup;
        let result: {status: string; dryRun?: boolean} | undefined;
        if (input.action === 'check') {
          result = checked.result;
        } else if (lookup === 'found') {
          status = 'found_use_check';
        } else if (ticket.submitted_age_seconds < 60) {
          status = 'too_recent';
        } else if (input.confirm) {
          result = input.outcome === 'submitted_verified' ? {status:input.outcome,dryRun:false} : {status:input.outcome};
        } else {
          status = 'dry_run';
        }
        if (result) {
          await client.query(`UPDATE ${table} SET result=$2 WHERE id=$1 AND result IS NULL`,[id,JSON.stringify(result)]);
          after = result;
          status = 'resolved';
        }
      }
      await client.query(`INSERT INTO mobile_ticket_admin_audit
        (operator,ticket_id,kind,action,before_result,after_result,note,lookup_status,outcome,requested_outcome)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.operator,id,kind,input.action,before,after,input.note ?? null,lookup,status,input.action === 'resolve' ? input.outcome : null]);
      return {status,lookup,result:status === 'resolved' ? after : null};
    });
  }
  async withTicketWrite<T>(id: string, close: boolean, environment: string, run: (client: PoolClient) => Promise<T>) {
    const table = close ? 'mobile_close_tickets' : 'mobile_trade_tickets';
    // Start the lookup grace period at the write, including when this process exits mid-request.
    await this.db.pool.query(`UPDATE ${table} SET submitted_at=clock_timestamp(), payload=jsonb_set(payload,'{environment}',to_jsonb($2::text))
      WHERE id=$1 AND submitted_at IS NOT NULL AND result IS NULL`,[id,environment]);
    return this.ticketTransaction(async client => {
      const pending = await client.query(`SELECT id FROM ${table} WHERE id=$1 AND result IS NULL
        AND submitted_at > clock_timestamp() - INTERVAL '60 seconds' FOR UPDATE`,[id]);
      if (!pending.rowCount) throw new MobileValidationError('This request is no longer available. Review a new quote.');
      return run(client);
    });
  }
  async saveTicket(token: string, ticket: MobileTradeTicket, reuse = false) {
    const user = await this.user(token);
    const result = await this.withMarketTicket(ticket,client => client.query(`INSERT INTO mobile_trade_tickets (id,identity_id,payload,expires_at) VALUES ($1,$2,$3,$4)${reuse ? ' ON CONFLICT (id) DO NOTHING' : ''}`,[ticket.id,user.id,JSON.stringify({...ticket,awaitingClaim:true}),new Date(ticket.expiresAt)]),reuse ? ticket.id : undefined);
    return result.rowCount !== 0;
  }
  private async claimMarketTicket(table: TicketTable, token: string, id: string) {
    const user = await this.user(token);
    const kind = table === 'mobile_close_tickets' ? ` AND ${closeOrderOnly}` : '';
    const available = `id=$1 AND identity_id=$2 AND submitted_at IS NULL AND result IS NULL AND expires_at>statement_timestamp()${kind}`;
    const args = [id,user.id];
    const candidate = await this.db.pool.query(`SELECT payload FROM ${table} WHERE ${available}`,args);
    const payload = candidate.rows[0]?.payload;
    if (!payload) return;
    const result = await this.withMarketTicket(payload,async client => {
      // A same-ticket claim may win between the initial read and the lock.
      return client.query(`UPDATE ${table} SET submitted_at=statement_timestamp(),payload=(payload-'awaitingClaim') ||
        COALESCE((SELECT jsonb_build_object('environment',environment) FROM mobile_connections
          WHERE identity_id=$2 AND payload->>'environment' IS NULL),'{}'::jsonb)
        WHERE ${available} RETURNING payload`,args);
    },id);
    return result.rows[0]?.payload;
  }
  async claimTicket(token: string, id: string): Promise<MobileTradeTicket | undefined> {
    return this.claimMarketTicket('mobile_trade_tickets',token,id);
  }
  async cancelUnclaimedTicket(token: string, id: string, close = false) {
    const user = await this.user(token);
    const table = close ? 'mobile_close_tickets' : 'mobile_trade_tickets';
    const kind = close ? " AND payload->>'kind' IS DISTINCT FROM 'protection'" : '';
    // Race safely with the original confirm. Once canceled, even a delayed request cannot claim it.
    await this.db.pool.query(`UPDATE ${table} SET result='{"status":"not_submitted"}'::jsonb, expires_at=LEAST(expires_at,NOW())
      WHERE id=$1 AND identity_id=$2 AND submitted_at IS NULL AND result IS NULL${kind}`,[id,user.id]);
  }
  async ticketResult(token: string, id: string) {
    const user = await this.user(token);
    const result = await this.db.pool.query(`SELECT payload,result,submitted_at FROM mobile_trade_tickets WHERE id=$1 AND identity_id=$2`,[id,user.id]);
    return result.rows[0];
  }
  async saveTicketResult(id: string, result: unknown, client: Pick<PoolClient, 'query'> = this.db.pool) {
    await client.query(`UPDATE mobile_trade_tickets SET result=$2 WHERE id=$1 AND result IS NULL`,[id,JSON.stringify(result)]);
  }
  async saveClose(token: string, input: CloseTicketInput) {
    const user = await this.user(token);
    const sql = 'INSERT INTO mobile_close_tickets (id,identity_id,payload,expires_at) VALUES ($1,$2,$3,$4)';
    const payload = input.kind === 'protection' ? input : {...input,awaitingClaim:true};
    const args = [input.id,user.id,JSON.stringify(payload),new Date(input.expiresAt)];
    if (input.kind === 'protection') await this.db.pool.query(sql,args);
    else await this.withMarketTicket(input,client => client.query(sql,args));
  }
  async claimClose(token: string, id: string, protection = false) {
    if (!protection) return this.claimMarketTicket('mobile_close_tickets',token,id);
    const user = await this.user(token);
    const result = await this.db.pool.query(`UPDATE mobile_close_tickets SET submitted_at=NOW() WHERE id=$1 AND identity_id=$2 AND payload->>'kind'='protection' AND submitted_at IS NULL AND result IS NULL AND expires_at>NOW() RETURNING payload`,[id,user.id]);
    return result.rows[0]?.payload;
  }
  async closeTicketResult(token: string, id: string) {
    const user = await this.user(token);
    const result = await this.db.pool.query('SELECT payload,result,submitted_at FROM mobile_close_tickets WHERE id=$1 AND identity_id=$2',[id,user.id]);
    return result.rows[0];
  }
  async saveCloseResult(id: string, result: unknown, client: Pick<PoolClient, 'query'> = this.db.pool) {
    await client.query('UPDATE mobile_close_tickets SET result=$2 WHERE id=$1 AND result IS NULL',[id,JSON.stringify(result)]);
  }
  async logout(token: string) { await this.db.pool.query(`DELETE FROM mobile_sessions WHERE token_hash=$1`, [hash(token)]); }
  async delete(token: string) {
    const user = await this.user(token);
    await this.db.pool.query(`DELETE FROM mobile_identities WHERE id=$1`, [user.id]);
  }
}
