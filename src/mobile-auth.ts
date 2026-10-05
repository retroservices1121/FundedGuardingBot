import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Database } from './db.js';

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
export class MobileAuth {
  constructor(private db: Database) {}
  async migrate() {
    await this.db.pool.query(`
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
      await client.query('BEGIN');
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
  async user(token: string) {
    const result = await this.db.pool.query(`SELECT i.id,i.provider,i.email FROM mobile_sessions s JOIN mobile_identities i ON i.id=s.identity_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [hash(token)]);
    if (!result.rows[0]) throw new Error('Session expired. Please sign in again.');
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
  async selectAccount(token: string, id: string) {
    const user = await this.user(token);
    await this.db.pool.query(`UPDATE mobile_connections SET selected_account_id=$2 WHERE identity_id=$1`, [user.id,id]);
  }
  async disconnect(token: string) {
    const user = await this.user(token);
    await this.db.pool.query(`DELETE FROM mobile_connections WHERE identity_id=$1`, [user.id]);
  }
  async logout(token: string) { await this.db.pool.query(`DELETE FROM mobile_sessions WHERE token_hash=$1`, [hash(token)]); }
  async delete(token: string) {
    const user = await this.user(token);
    await this.db.pool.query(`DELETE FROM mobile_identities WHERE id=$1`, [user.id]);
  }
}
