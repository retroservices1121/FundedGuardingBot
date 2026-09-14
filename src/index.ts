import { loadConfig, miniAppUrl } from "./config.js";
import { createGuardianBot } from "./bot.js";
import { Database } from "./db.js";
import { startMiniAppServer } from "./mini-app-server.js";
import { startGuardianMonitor } from "./monitor.js";
import { startPulseChannel } from "./pulse.js";

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
await db.migrate();
startMiniAppServer(config, db);
const bot = createGuardianBot(config, db);

console.log(`Funded Guardian starting in ${config.DRY_RUN ? "dry run" : "execution"} mode.`);
await bot.api.setMyCommands([
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
const appUrl = miniAppUrl(config);
if (appUrl) {
  await bot.api.setChatMenuButton({
    menu_button: { type: "web_app", text: "Open Guardian", web_app: { url: appUrl } },
  });
}
startGuardianMonitor(config, db, bot.api);
const info = await bot.api.getMe();
startPulseChannel(config, db, bot.api, info.username);
await bot.start({ onStart: () => console.log(`@${info.username} is running.`) });
