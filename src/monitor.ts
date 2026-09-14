import type { Api } from "grammy";
import type { Config } from "./config.js";
import { SecretBox } from "./crypto.js";
import { Database } from "./db.js";
import { accountDailyPnl, automaticLockReason, riskBand } from "./guardian.js";
import { MfpClient } from "./mfp.js";

const HOSTS = {
  sandbox: "https://sandbox.myfundedperpetuals.com",
  live: "https://developers.myfundedperpetuals.com",
} as const;

const cash = (value: number | null | undefined) => Number(value ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function startGuardianMonitor(config: Config, db: Database, telegram: Api) {
  const secrets = new SecretBox(config.ENCRYPTION_KEY);
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      for (const { user, connection } of await db.listMonitoredUsers()) {
        try {
          const client = new MfpClient(HOSTS[connection.environment], secrets.decrypt(connection.encryptedApiKey));
          const accounts = await client.listAccounts();
          const accountId = user.selectedAccountId && accounts.some(account => account.id === user.selectedAccountId)
            ? user.selectedAccountId
            : accounts[0]?.id;
          if (!accountId) continue;
          const [account, open, closed] = await Promise.all([
            client.getAccount(accountId),
            client.listOpenPositions(accountId),
            client.listClosedPositions(accountId, 20),
          ]);
          const next = {
            accountId,
            openPositionIds: open.map(position => position.id),
            closedPositionIds: closed.map(position => position.id),
            riskBand: riskBand(account, user.riskUsd),
          };
          const previous = await db.getMonitorState(user.telegramId);
          const dailyPnl = accountDailyPnl(account);
          const lockReason = automaticLockReason(user, dailyPnl);
          const isLocked = user.lockedUntil && user.lockedUntil.getTime() > Date.now();
          if (lockReason && !isLocked) {
            await db.lockUntilTomorrow(user.telegramId);
            if (user.alertsEnabled) await telegram.sendMessage(user.telegramId, `🔒 ${lockReason}\n\nToday's P&L: ${cash(dailyPnl)}\nGuardian has blocked new bot trades until the next New York trading day.`);
          }
          if (previous && previous.accountId === accountId && user.alertsEnabled) {
            for (const position of open.filter(item => !previous.openPositionIds.includes(item.id))) {
              await telegram.sendMessage(user.telegramId, `🟢 Position opened\n\n${position.symbol || position.coin} ${position.side.toUpperCase()} · Size ${position.size}\nEntry: ${cash(position.entry_price)}`);
            }
            for (const position of closed.filter(item => !previous.closedPositionIds.includes(item.id))) {
              await telegram.sendMessage(user.telegramId, `🏁 Position closed\n\n${position.symbol || position.coin} ${position.side.toUpperCase()}\nRealized P&L: ${cash(position.realized_pnl)}\nFees: ${cash(position.fees)}`);
            }
            if (next.riskBand !== previous.riskBand && next.riskBand !== "normal") {
              const risk = account.risk ?? account.risk_snapshot ?? {};
              await telegram.sendMessage(user.telegramId, `${next.riskBand === "critical" ? "🚨" : "⚠️"} Guardian risk alert\n\nDaily loss room: ${cash(Number(risk.daily_loss_room))}\nMaximum loss room: ${cash(Number(risk.max_loss_room))}\n${next.riskBand === "critical" ? "New trades are not recommended." : "Reduce risk before opening another position."}`);
            }
          }
          await db.saveMonitorState(user.telegramId, next);
        } catch (error) {
          console.warn(`Guardian monitor skipped Telegram user ${user.telegramId}:`, error instanceof Error ? error.message : "unknown error");
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void run(), config.GUARDIAN_MONITOR_SECONDS * 1000);
  timer.unref();
  setTimeout(() => void run(), 10_000).unref();
  return () => clearInterval(timer);
}
