import { loadConfig, miniAppUrl } from "./config.js";
import { createGuardianBot } from "./bot.js";
import { Database } from "./db.js";
import { startMiniAppServer } from "./mini-app-server.js";
import { startGuardianMonitor } from "./monitor.js";
import { startPulseNews } from "./pulse-news.js";
import { startPulseChannel } from "./pulse.js";

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
let shuttingDown = false;
let server: ReturnType<typeof startMiniAppServer> | undefined;
let bot: ReturnType<typeof createGuardianBot> | undefined;
let polling: Promise<void> | undefined;
const stopBackground: (() => void)[] = [];

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const requests = server?.beginShutdown();
  const stopPolling = bot?.stop();
  for (const stop of stopBackground) stop();

  let timedOut = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>(resolve => {
    drainTimer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, 42_000);
  });
  await Promise.race([deadline, Promise.allSettled([requests, migration, stopPolling, polling])]);

  const httpServer = server;
  if (httpServer) {
    const closed = new Promise<void>(resolve => httpServer.close(() => resolve()));
    await Promise.race([deadline, closed]);
    if (timedOut) httpServer.closeAllConnections();
  }
  clearTimeout(drainTimer);
  if (timedOut) console.warn("Funded Guardian shutdown reached its drain deadline.");
  const poolDeadline = setTimeout(() => process.exit(1), 1_000);
  try {
    await db.pool.end();
  } catch {
    console.error("Funded Guardian could not close its database pool.");
    exitCode = 1;
  } finally {
    clearTimeout(poolDeadline);
  }
  process.exit(timedOut ? 1 : exitCode);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

const migration = db.migrate();
async function start() {
  await migration;
  if (shuttingDown) return;
  server = startMiniAppServer(config, db);
  stopBackground.push(startPulseNews(db));
  const guardianBot = bot = createGuardianBot(config, db, () => shuttingDown);

  console.log(`Funded Guardian starting in ${config.DRY_RUN ? "dry run" : "execution"} mode.`);
  await guardianBot.api.setMyCommands([
    { command: "connect", description: "Connect a MyFundedPerps key" },
    { command: "app", description: "Open the Funded Guardian Mini App" },
    { command: "accounts", description: "Choose a challenge account" },
    { command: "status", description: "Account and risk snapshot" },
    { command: "positions", description: "View open positions" },
    { command: "closed", description: "View recent closed positions" },
    { command: "trade", description: "Create a protected trade" },
    { command: "settings", description: "Personal risk settings" },
    { command: "lock", description: "Lock new trades until the next trading day" },
    { command: "unlock", description: "Remove the local trading lock" },
    { command: "disconnect", description: "Delete the stored connection" },
  ]);
  if (shuttingDown) return;
  const appUrl = miniAppUrl(config);
  if (appUrl) {
    await guardianBot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "Open Guardian", web_app: { url: appUrl } },
    });
  }
  if (shuttingDown) return;
  stopBackground.push(startGuardianMonitor(config, db, guardianBot.api));
  await guardianBot.init();
  if (shuttingDown) return;
  const { username } = guardianBot.botInfo;
  const pulse = startPulseChannel(config, db, guardianBot.api, username);
  stopBackground.push(pulse.stop);
  guardianBot.command("pulse_status", async (ctx) => {
    if (!config.ADMIN_TELEGRAM_ID || ctx.from?.id !== config.ADMIN_TELEGRAM_ID || ctx.chat.type !== "private") return;
    await ctx.reply(pulse.status());
  });
  polling = guardianBot.start({ onStart: () => console.log(`@${username} is running.`) });
  await polling;
}

await start().catch(async () => {
  if (shuttingDown) return;
  console.error("Funded Guardian could not start or continue polling.");
  await shutdown(1);
});
