import pg from "pg";
import type { TradeTicket } from "./types.js";

const { Pool } = pg;

export interface UserProfile {
  telegramId: number;
  username?: string;
  firstName?: string;
  plan: "trial" | "pro" | "suspended";
  trialEndsAt: Date;
  onboardingState?: string;
  selectedAccountId?: string;
  riskUsd: number;
  maxRiskUsd: number;
  stopPercent: number;
  rewardRisk: number;
  leverage: number;
  maxLossRoomUsagePercent: number;
  lockedUntil?: Date;
}

export interface Connection {
  environment: "sandbox" | "live";
  encryptedApiKey: string;
  keyLastFour: string;
}

export class Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false } });
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        plan TEXT NOT NULL DEFAULT 'trial',
        trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
        onboarding_state TEXT,
        selected_account_id TEXT,
        risk_usd NUMERIC NOT NULL DEFAULT 75,
        max_risk_usd NUMERIC NOT NULL DEFAULT 100,
        stop_percent NUMERIC NOT NULL DEFAULT 0.5,
        reward_risk NUMERIC NOT NULL DEFAULT 1.8,
        leverage INTEGER NOT NULL DEFAULT 2,
        max_loss_room_usage_percent NUMERIC NOT NULL DEFAULT 20,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mfp_connections (
        telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
        environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
        encrypted_api_key TEXT NOT NULL,
        key_last_four TEXT NOT NULL,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS trade_tickets (
        id TEXT PRIMARY KEY,
        telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS trade_tickets_user_idx ON trade_tickets(telegram_id, expires_at);
    `);
  }

  async upsertUser(input: { telegramId: number; username?: string; firstName?: string }) {
    await this.pool.query(
      `INSERT INTO users (telegram_id, username, first_name) VALUES ($1,$2,$3)
       ON CONFLICT (telegram_id) DO UPDATE SET username=$2, first_name=$3, updated_at=NOW()`,
      [input.telegramId, input.username ?? null, input.firstName ?? null],
    );
    return this.getUser(input.telegramId);
  }

  async getUser(telegramId: number): Promise<UserProfile> {
    const { rows } = await this.pool.query(`SELECT * FROM users WHERE telegram_id=$1`, [telegramId]);
    const row = rows[0];
    if (!row) throw new Error("User profile not found.");
    return {
      telegramId: Number(row.telegram_id), username: row.username ?? undefined, firstName: row.first_name ?? undefined,
      plan: row.plan, trialEndsAt: row.trial_ends_at, onboardingState: row.onboarding_state ?? undefined,
      selectedAccountId: row.selected_account_id ?? undefined, riskUsd: Number(row.risk_usd),
      maxRiskUsd: Number(row.max_risk_usd), stopPercent: Number(row.stop_percent),
      rewardRisk: Number(row.reward_risk), leverage: Number(row.leverage),
      maxLossRoomUsagePercent: Number(row.max_loss_room_usage_percent), lockedUntil: row.locked_until ?? undefined,
    };
  }

  setOnboardingState(telegramId: number, state: string | null) {
    return this.pool.query(`UPDATE users SET onboarding_state=$2, updated_at=NOW() WHERE telegram_id=$1`, [telegramId, state]);
  }

  async saveConnection(telegramId: number, connection: Connection) {
    await this.pool.query(
      `INSERT INTO mfp_connections (telegram_id, environment, encrypted_api_key, key_last_four)
       VALUES ($1,$2,$3,$4) ON CONFLICT (telegram_id) DO UPDATE SET environment=$2,
       encrypted_api_key=$3, key_last_four=$4, connected_at=NOW()`,
      [telegramId, connection.environment, connection.encryptedApiKey, connection.keyLastFour],
    );
  }

  async getConnection(telegramId: number): Promise<Connection | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM mfp_connections WHERE telegram_id=$1`, [telegramId]);
    const row = rows[0];
    return row ? { environment: row.environment, encryptedApiKey: row.encrypted_api_key, keyLastFour: row.key_last_four } : undefined;
  }

  async disconnect(telegramId: number) {
    await this.pool.query("BEGIN");
    try {
      await this.pool.query(`DELETE FROM mfp_connections WHERE telegram_id=$1`, [telegramId]);
      await this.pool.query(`UPDATE users SET selected_account_id=NULL, onboarding_state=NULL WHERE telegram_id=$1`, [telegramId]);
      await this.pool.query("COMMIT");
    } catch (error) { await this.pool.query("ROLLBACK"); throw error; }
  }

  setSelectedAccount(telegramId: number, accountId: string) {
    return this.pool.query(`UPDATE users SET selected_account_id=$2, updated_at=NOW() WHERE telegram_id=$1`, [telegramId, accountId]);
  }

  async updateRisk(telegramId: number, riskUsd: number) {
    await this.pool.query(`UPDATE users SET risk_usd=$2, updated_at=NOW() WHERE telegram_id=$1`, [telegramId, riskUsd]);
  }

  async lockUntilTomorrow(telegramId: number) {
    const { rows } = await this.pool.query(
      `UPDATE users SET locked_until=date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + INTERVAL '1 day'
       WHERE telegram_id=$1 RETURNING locked_until`, [telegramId],
    );
    return rows[0].locked_until as Date;
  }

  unlock(telegramId: number) {
    return this.pool.query(`UPDATE users SET locked_until=NULL WHERE telegram_id=$1`, [telegramId]);
  }

  async putTicket(ticket: TradeTicket) {
    await this.pool.query(`INSERT INTO trade_tickets (id, telegram_id, payload, expires_at) VALUES ($1,$2,$3,$4)`,
      [ticket.id, ticket.userId, JSON.stringify(ticket), new Date(ticket.expiresAt)]);
  }

  async takeTicket(id: string, telegramId: number): Promise<TradeTicket | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE trade_tickets SET consumed_at=NOW() WHERE id=$1 AND telegram_id=$2
         AND consumed_at IS NULL AND expires_at>NOW() RETURNING payload`, [id, telegramId],
      );
      await client.query("COMMIT");
      return rows[0]?.payload as TradeTicket | undefined;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async stats() {
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int users, COUNT(*) FILTER (WHERE c.telegram_id IS NOT NULL)::int connected FROM users u LEFT JOIN mfp_connections c USING (telegram_id)`);
    return rows[0] as { users: number; connected: number };
  }
}
