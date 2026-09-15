import pg from "pg";
import type { TradeTicket } from "./types.js";

const { Pool } = pg;

export interface UserProfile {
  telegramId: number;
  username?: string;
  firstName?: string;
  onboardingState?: string;
  selectedAccountId?: string;
  riskUsd: number;
  maxRiskUsd: number;
  stopPercent: number;
  rewardRisk: number;
  leverage: number;
  maxLossRoomUsagePercent: number;
  enforceGuardrails: boolean;
  guardianMode: "off" | "warn" | "enforce";
  dailyProfitLockUsd?: number;
  dailyLossLockUsd?: number;
  alertsEnabled: boolean;
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
        onboarding_state TEXT,
        selected_account_id TEXT,
        risk_usd NUMERIC NOT NULL DEFAULT 75,
        max_risk_usd NUMERIC NOT NULL DEFAULT 100000,
        stop_percent NUMERIC NOT NULL DEFAULT 0.5,
        reward_risk NUMERIC NOT NULL DEFAULT 1.8,
        leverage INTEGER NOT NULL DEFAULT 2,
        max_loss_room_usage_percent NUMERIC NOT NULL DEFAULT 100,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_profit_lock_usd NUMERIC;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_loss_lock_usd NUMERIC;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS enforce_guardrails BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS guardian_mode TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE users ALTER COLUMN max_risk_usd SET DEFAULT 100000;
      ALTER TABLE users ALTER COLUMN max_loss_room_usage_percent SET DEFAULT 100;
      ALTER TABLE users ALTER COLUMN enforce_guardrails SET DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
      UPDATE users SET last_seen_at=updated_at WHERE last_seen_at IS NULL;
      ALTER TABLE users ALTER COLUMN last_seen_at SET DEFAULT NOW();
      ALTER TABLE users ALTER COLUMN last_seen_at SET NOT NULL;
      CREATE TABLE IF NOT EXISTS guardian_monitor_state (
        telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        open_position_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        closed_position_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        risk_band TEXT NOT NULL DEFAULT 'normal',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS trade_executions (
        id BIGSERIAL PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        notional_usd NUMERIC NOT NULL,
        dry_run BOOLEAN NOT NULL,
        status TEXT NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS trade_executions_time_idx ON trade_executions(executed_at DESC);
      CREATE TABLE IF NOT EXISTS pulse_publications (
        dedupe_key TEXT PRIMARY KEY,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      DELETE FROM pulse_publications WHERE published_at < NOW() - INTERVAL '90 days';
    `);
  }

  async upsertUser(input: { telegramId: number; username?: string; firstName?: string }) {
    await this.pool.query(
      `INSERT INTO users (telegram_id, username, first_name) VALUES ($1,$2,$3)
       ON CONFLICT (telegram_id) DO UPDATE SET username=$2, first_name=$3, updated_at=NOW(), last_seen_at=NOW()`,
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
      onboardingState: row.onboarding_state ?? undefined,
      selectedAccountId: row.selected_account_id ?? undefined, riskUsd: Number(row.risk_usd),
      maxRiskUsd: Number(row.max_risk_usd), stopPercent: Number(row.stop_percent),
      rewardRisk: Number(row.reward_risk), leverage: Number(row.leverage),
      maxLossRoomUsagePercent: Number(row.max_loss_room_usage_percent),
      enforceGuardrails: row.guardian_mode === "enforce",
      guardianMode: (["off", "warn", "enforce"].includes(row.guardian_mode) ? row.guardian_mode : "off") as UserProfile["guardianMode"],
      dailyProfitLockUsd: row.daily_profit_lock_usd === null ? undefined : Number(row.daily_profit_lock_usd),
      dailyLossLockUsd: row.daily_loss_lock_usd === null ? undefined : Number(row.daily_loss_lock_usd),
      alertsEnabled: row.alerts_enabled !== false, lockedUntil: row.locked_until ?? undefined,
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM mfp_connections WHERE telegram_id=$1`, [telegramId]);
      await client.query(`UPDATE users SET selected_account_id=NULL, onboarding_state=NULL WHERE telegram_id=$1`, [telegramId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  setSelectedAccount(telegramId: number, accountId: string) {
    return this.pool.query(`UPDATE users SET selected_account_id=$2, updated_at=NOW() WHERE telegram_id=$1`, [telegramId, accountId]);
  }

  async updateRisk(telegramId: number, riskUsd: number) {
    await this.pool.query(`UPDATE users SET risk_usd=$2, updated_at=NOW() WHERE telegram_id=$1`, [telegramId, riskUsd]);
  }

  async lockUntilTomorrow(telegramId: number) {
    const { rows } = await this.pool.query(
      `UPDATE users SET locked_until=(date_trunc('day', NOW() AT TIME ZONE 'America/New_York') + INTERVAL '1 day') AT TIME ZONE 'America/New_York'
       WHERE telegram_id=$1 RETURNING locked_until`, [telegramId],
    );
    return rows[0].locked_until as Date;
  }

  unlock(telegramId: number) {
    return this.pool.query(`UPDATE users SET locked_until=NULL WHERE telegram_id=$1`, [telegramId]);
  }

  async updateGuardianSettings(telegramId: number, settings: { dailyProfitLockUsd?: number; dailyLossLockUsd?: number; alertsEnabled: boolean; maxLossRoomUsagePercent: number; maxRiskUsd: number; guardianMode: UserProfile["guardianMode"] }) {
    await this.pool.query(
      `UPDATE users SET daily_profit_lock_usd=$2, daily_loss_lock_usd=$3, alerts_enabled=$4, max_loss_room_usage_percent=$5, max_risk_usd=$6, enforce_guardrails=$7, guardian_mode=$8, updated_at=NOW() WHERE telegram_id=$1`,
      [telegramId, settings.dailyProfitLockUsd ?? null, settings.dailyLossLockUsd ?? null, settings.alertsEnabled, settings.maxLossRoomUsagePercent, settings.maxRiskUsd, settings.guardianMode === "enforce", settings.guardianMode],
    );
  }

  async listMonitoredUsers(limit = 100) {
    const { rows } = await this.pool.query(
      `SELECT telegram_id FROM users WHERE alerts_enabled=TRUE OR daily_profit_lock_usd IS NOT NULL OR daily_loss_lock_usd IS NOT NULL ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    const users = [];
    for (const row of rows) {
      const telegramId = Number(row.telegram_id);
      const connection = await this.getConnection(telegramId);
      if (connection) users.push({ user: await this.getUser(telegramId), connection });
    }
    return users;
  }

  async getMonitorState(telegramId: number) {
    const { rows } = await this.pool.query(`SELECT * FROM guardian_monitor_state WHERE telegram_id=$1`, [telegramId]);
    const row = rows[0];
    return row ? {
      accountId: String(row.account_id),
      openPositionIds: Array.isArray(row.open_position_ids) ? row.open_position_ids.map(String) : [],
      closedPositionIds: Array.isArray(row.closed_position_ids) ? row.closed_position_ids.map(String) : [],
      riskBand: String(row.risk_band),
    } : undefined;
  }

  async saveMonitorState(telegramId: number, state: { accountId: string; openPositionIds: string[]; closedPositionIds: string[]; riskBand: string }) {
    await this.pool.query(
      `INSERT INTO guardian_monitor_state (telegram_id, account_id, open_position_ids, closed_position_ids, risk_band)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telegram_id) DO UPDATE SET account_id=$2, open_position_ids=$3,
       closed_position_ids=$4, risk_band=$5, updated_at=NOW()`,
      [telegramId, state.accountId, JSON.stringify(state.openPositionIds), JSON.stringify(state.closedPositionIds), state.riskBand],
    );
  }

  async claimPulsePublication(dedupeKey: string) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO pulse_publications (dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING`,
      [dedupeKey],
    );
    return rowCount === 1;
  }

  releasePulsePublication(dedupeKey: string) {
    return this.pool.query(`DELETE FROM pulse_publications WHERE dedupe_key=$1`, [dedupeKey]);
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

  async recordTradeExecution(input: { ticketId: string; telegramId: number; accountId: string; symbol: string; side: string; notionalUsd: number; dryRun: boolean; status: string }) {
    await this.pool.query(
      `INSERT INTO trade_executions (ticket_id, telegram_id, account_id, symbol, side, notional_usd, dry_run, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (ticket_id) DO NOTHING`,
      [input.ticketId, input.telegramId, input.accountId, input.symbol, input.side, input.notionalUsd, input.dryRun, input.status],
    );
  }

  async adminStats() {
    const { rows } = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int AS users,
        (SELECT COUNT(*) FROM mfp_connections)::int AS connected,
        (SELECT COUNT(*) FROM users WHERE last_seen_at >= NOW() - INTERVAL '24 hours')::int AS active_day,
        (SELECT COUNT(*) FROM users WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_week,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_week,
        (SELECT COUNT(*) FROM trade_executions WHERE dry_run=FALSE)::int AS live_trades,
        COALESCE((SELECT SUM(notional_usd) FROM trade_executions WHERE dry_run=FALSE),0)::numeric AS live_notional,
        COALESCE((SELECT SUM(notional_usd) FROM trade_executions WHERE dry_run=FALSE AND executed_at >= NOW() - INTERVAL '7 days'),0)::numeric AS week_notional,
        (SELECT COUNT(*) FROM trade_executions WHERE dry_run=TRUE)::int AS dry_runs
    `);
    const summary = rows[0];
    const recent = await this.pool.query(`
      SELECT e.symbol, e.side, e.notional_usd, e.dry_run, e.status, e.executed_at, u.username
      FROM trade_executions e JOIN users u ON u.telegram_id=e.telegram_id
      ORDER BY e.executed_at DESC LIMIT 20
    `);
    return {
      users: Number(summary.users),
      connected: Number(summary.connected),
      activeDay: Number(summary.active_day),
      activeWeek: Number(summary.active_week),
      newWeek: Number(summary.new_week),
      liveTrades: Number(summary.live_trades),
      liveNotional: Number(summary.live_notional),
      weekNotional: Number(summary.week_notional),
      dryRuns: Number(summary.dry_runs),
      recent: recent.rows.map((row) => ({
        symbol: String(row.symbol),
        side: String(row.side),
        notionalUsd: Number(row.notional_usd),
        dryRun: Boolean(row.dry_run),
        status: String(row.status),
        executedAt: row.executed_at as Date,
        username: row.username ? String(row.username) : undefined,
      })),
    };
  }

  async stats() {
    const stats = await this.adminStats();
    return { users: stats.users, connected: stats.connected };
  }
}
