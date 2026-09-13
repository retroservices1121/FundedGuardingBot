import { loadConfig } from "./config.js";
import { createGuardianBot } from "./bot.js";
import { Database } from "./db.js";

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
await db.migrate();
const bot = createGuardianBot(config, db);

console.log(`Funded Guardian SaaS starting in ${config.DRY_RUN ? "dry run" : "execution"} mode.`);
await bot.api.setMyCommands([
  { command: "connect", description: "Connect a MyFundedPerps key" },
  { command: "accounts", description: "Choose a challenge account" },
  { command: "status", description: "Account and risk snapshot" },
  { command: "positions", description: "View open positions" },
  { command: "trade", description: "Create a protected trade" },
  { command: "settings", description: "Personal risk settings" },
  { command: "lock", description: "Lock new trades until tomorrow UTC" },
  { command: "unlock", description: "Remove the local trading lock" },
  { command: "disconnect", description: "Delete the stored connection" },
]);
await bot.start({ onStart: (info) => console.log(`@${info.username} is running.`) });
