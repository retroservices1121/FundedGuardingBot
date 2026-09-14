import "dotenv/config";
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((value) => value === "true");

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
  PORT: z.coerce.number().int().positive().default(3000),
  MINI_APP_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),
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
  return parsed;
}
