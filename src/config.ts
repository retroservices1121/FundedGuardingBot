import "dotenv/config";
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((value) => value === "true");

const csv = z.string().transform((value) => value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean));
const domains = z.string().transform((value) => value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive().optional(),
  ALLOW_LIVE_TRADING: bool.default("false"),
  DRY_RUN: bool.default("true"),
  DEFAULT_RISK_USD: z.coerce.number().positive().default(75),
  MAX_RISK_USD: z.coerce.number().positive().default(100),
  DEFAULT_STOP_PERCENT: z.coerce.number().positive().max(10).default(0.5),
  DEFAULT_REWARD_RISK: z.coerce.number().positive().max(10).default(1.8),
  DEFAULT_LEVERAGE: z.coerce.number().int().positive().max(100).default(2),
  MAX_LOSS_ROOM_USAGE_PERCENT: z.coerce.number().positive().max(100).default(20),
  CONFIRMATION_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(45),
  GUARDIAN_MONITOR_SECONDS: z.coerce.number().int().min(30).max(3600).default(90),
  MINI_APP_REFRESH_SECONDS: z.coerce.number().int().min(10).max(300).default(20),
  PORT: z.coerce.number().int().positive().default(3000),
  MINI_APP_URL: optionalUrl,
  RAILWAY_PUBLIC_DOMAIN: optionalString,
  PULSE_CHANNEL_ID: optionalString,
  PULSE_PROVIDER: z.string().min(1).default("binance"),
  PULSE_SYMBOLS: csv.default("BTCUSDT,ETHUSDT,SOLUSDT"),
  PULSE_MOVE_PERCENT: z.coerce.number().positive().max(25).default(1),
  PULSE_MOVE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  PULSE_VOLUME_MULTIPLIER: z.coerce.number().min(1.5).max(25).default(3),
  PULSE_SPREAD_BPS: z.coerce.number().positive().max(1000).default(10),
  PULSE_ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  PULSE_BRIEF_HOUR_ET: z.coerce.number().int().min(0).max(23).default(8),
  CRYPTOPANIC_TOKEN: optionalString,
  CRYPTOPANIC_API_URL: z.string().url().default("https://cryptopanic.com/api/free/v2/posts/"),
  PULSE_NEWS_POLL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  PULSE_NEWS_MAX_AGE_MINUTES: z.coerce.number().int().min(5).max(180).default(45),
  PULSE_NEWS_MOVE_PERCENT: z.coerce.number().positive().max(25).default(0.5),
  PULSE_NEWS_SOURCES: domains.default("reuters.com,apnews.com,bloomberg.com,coindesk.com,theblock.co,cointelegraph.com,decrypt.co,sec.gov,federalreserve.gov"),
});

export type Config = z.infer<typeof schema>;

export function miniAppUrl(config: Config) {
  return config.MINI_APP_URL
    ?? (config.RAILWAY_PUBLIC_DOMAIN ? `https://${config.RAILWAY_PUBLIC_DOMAIN}/app` : undefined);
}

export function loadConfig(env = process.env): Config {
  const parsed = schema.parse(env);
  const bytes = Buffer.from(parsed.ENCRYPTION_KEY, "base64");
  if (bytes.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes.");
  if (parsed.PULSE_SYMBOLS.length > 32) throw new Error("PULSE_SYMBOLS supports at most 32 markets.");
  return parsed;
}
