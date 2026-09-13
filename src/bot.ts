import { randomUUID } from "node:crypto";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { Config } from "./config.js";
import { SecretBox } from "./crypto.js";
import { Database, type UserProfile } from "./db.js";
import { accountMessage, closedPositionsMessage, positionsMessage, ticketMessage, tradeKeyboard } from "./format.js";
import { MfpClient, MfpError } from "./mfp.js";
import { buildTicket, calculateSize, guardAccount } from "./risk.js";
import { closedPositionCaption, createClosedPositionShareCard } from "./share-card.js";
import type { Market, PositionView, Side } from "./types.js";

const HOSTS = {
  sandbox: "https://sandbox.myfundedperpetuals.com",
  live: "https://developers.myfundedperpetuals.com",
} as const;

function apiError(error: unknown) {
  if (error instanceof MfpError) return `MyFundedPerps: ${error.message}${error.retryAfter ? ` Retry after ${error.retryAfter}s.` : ""}`;
  return error instanceof Error ? error.message : "Unexpected error.";
}

function marketSymbol(market: Market) {
  return String(market.symbol ?? market.id.split("|").at(-1) ?? market.id).toUpperCase();
}

function findMarket(markets: Market[], wanted: string) {
  const upper = wanted.toUpperCase();
  const candidates = markets.filter((market) => {
    const symbol = marketSymbol(market);
    return market.available !== false && (symbol === upper || symbol.startsWith(`${upper}USD`) || symbol.startsWith(`${upper}USDT`));
  });
  return candidates.find((market) => market.id.startsWith("binance|")) ?? candidates[0];
}

function activeSubscription(user: UserProfile) {
  return user.plan === "pro" || (user.plan === "trial" && user.trialEndsAt.getTime() > Date.now());
}

export function createGuardianBot(config: Config, db: Database) {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const secrets = new SecretBox(config.ENCRYPTION_KEY);

  async function ensureUser(ctx: Context) {
    if (!ctx.from) throw new Error("Telegram user information is unavailable.");
    return db.upsertUser({ telegramId: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name });
  }

  async function session(ctx: Context) {
    const user = await ensureUser(ctx);
    const connection = await db.getConnection(user.telegramId);
    if (!connection) throw new Error("Connect MyFundedPerps first with /connect.");
    return { user, connection, client: new MfpClient(HOSTS[connection.environment], secrets.decrypt(connection.encryptedApiKey)) };
  }

  async function selectedAccount(ctx: Context) {
    const state = await session(ctx);
    const accounts = await state.client.listAccounts();
    let accountId = state.user.selectedAccountId;
    if (!accountId || !accounts.some((item) => item.id === accountId)) {
      const preferred = accounts.find((item) => ["active", "trading"].includes(String(item.status).toLowerCase())) ?? accounts[0];
      if (!preferred) throw new Error("No accessible challenge account was found.");
      accountId = preferred.id;
      await db.setSelectedAccount(state.user.telegramId, accountId);
    }
    return { ...state, account: await state.client.getAccount(accountId), accounts };
  }

  async function showStatus(ctx: Context) {
    const { account, connection } = await selectedAccount(ctx);
    await ctx.reply(accountMessage(account, connection.environment, config.DRY_RUN), {
      reply_markup: new InlineKeyboard().text("Trade", "trade").text("Open Positions", "positions").row().text("Closed Positions", "closed").text("Refresh", "status").row().text("Accounts", "accounts").text("Settings", "settings").row().text("Lock Today", "lock"),
    });
  }

  async function showAccounts(ctx: Context) {
    const { user, accounts } = await selectedAccount(ctx);
    const keyboard = new InlineKeyboard();
    accounts.slice(0, 20).forEach((account, index) => {
      keyboard.text(`${account.id === user.selectedAccountId ? "✓ " : ""}${account.name ?? account.id}`, `account:${index}`).row();
    });
    await ctx.reply("Select the challenge account Guardian should use:", { reply_markup: keyboard });
  }

  bot.command("start", async (ctx) => {
    const user = await ensureUser(ctx);
    const connection = await db.getConnection(user.telegramId);
    const keyboard = connection
      ? new InlineKeyboard().text("Account Status", "status").text("Open Positions", "positions").row().text("Closed Positions", "closed").text("Trade", "trade").row().text("Settings", "settings").text("Accounts", "accounts")
      : new InlineKeyboard().text("Connect MyFundedPerps", "connect");
    await ctx.reply(connection
      ? `🛡 Welcome back to Funded Guardian.\n\nConnected: ${connection.environment} key ••••${connection.keyLastFour}`
      : "🛡 Funded Guardian protects your challenge before every trade.\n\nStart with a MyFundedPerps sandbox key. New accounts receive a 7-day test period.", { reply_markup: keyboard });
  });

  async function beginConnect(ctx: Context) {
    const user = await ensureUser(ctx);
    await db.setOnboardingState(user.telegramId, "awaiting_api_key");
    await ctx.reply("Send your MyFundedPerps API key in this private chat. Start with an fp_test_ sandbox key.\n\nGuardian will delete your message immediately, validate the key, and store an encrypted copy. Use /cancel to stop.");
  }
  bot.command("connect", beginConnect);
  bot.callbackQuery("connect", async (ctx) => { await ctx.answerCallbackQuery(); await beginConnect(ctx); });
  bot.command("cancel", async (ctx) => { const user = await ensureUser(ctx); await db.setOnboardingState(user.telegramId, null); await ctx.reply("Canceled."); });

  bot.on("message:text", async (ctx, next) => {
    const user = await ensureUser(ctx);
    if (user.onboardingState !== "awaiting_api_key" || ctx.message.text.startsWith("/")) return next();
    const key = ctx.message.text.trim();
    await ctx.deleteMessage().catch(() => undefined);
    if (!/^fp_(test|live)_[A-Za-z0-9_-]+$/.test(key)) {
      await ctx.reply("❌ That does not look like a MyFundedPerps API key. Send an fp_test_ key, or use /cancel.");
      return;
    }
    const environment = key.startsWith("fp_test_") ? "sandbox" : "live";
    if (environment === "live" && !config.ALLOW_LIVE_TRADING) {
      await ctx.reply("🛑 Live keys are disabled during beta. Please connect an fp_test_ sandbox key.");
      return;
    }
    try {
      const client = new MfpClient(HOSTS[environment], key);
      const accounts = await client.listAccounts();
      if (!accounts.length) throw new Error("The key has no accessible accounts.");
      await db.saveConnection(user.telegramId, { environment, encryptedApiKey: secrets.encrypt(key), keyLastFour: key.slice(-4) });
      const preferred = accounts.find((item) => ["active", "trading"].includes(String(item.status).toLowerCase())) ?? accounts[0]!;
      await db.setSelectedAccount(user.telegramId, preferred.id);
      await db.setOnboardingState(user.telegramId, null);
      await ctx.reply(`✅ Connected securely\n\n${accounts.length} account${accounts.length === 1 ? "" : "s"} found. Selected: ${preferred.name ?? preferred.id}`, {
        reply_markup: new InlineKeyboard().text("View Status", "status").text("Choose Account", "accounts"),
      });
    } catch (error) {
      await ctx.reply(`❌ Connection failed\n\n${apiError(error)}\n\nThe key was not stored. Try again or use /cancel.`);
    }
  });

  bot.command("disconnect", async (ctx) => {
    const user = await ensureUser(ctx);
    await db.disconnect(user.telegramId);
    await ctx.reply("Disconnected. Your stored MyFundedPerps credential and account selection were deleted.");
  });
  bot.command("status", async (ctx) => { try { await showStatus(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });
  bot.callbackQuery("status", async (ctx) => { await ctx.answerCallbackQuery(); try { await showStatus(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });

  async function showPositions(ctx: Context) {
    const { account, client } = await selectedAccount(ctx);
    const positions = await client.listOpenPositions(account.id);
    const quotes = new Map<string, { mid: number; estimatedFee?: number }>();
    await Promise.all(positions.slice(0, 10).map(async (position) => {
      try {
        const closeSide: Side = position.side === "long" ? "sell" : "buy";
        const quote = await client.getQuote(position.market_id, closeSide, Math.abs(position.size));
        quotes.set(position.id, { mid: quote.mid, estimatedFee: quote.estimated_fee });
      } catch {
        // A position remains useful even when its current quote is temporarily unavailable.
      }
    }));
    const views: PositionView[] = positions.map((position) => {
      const quote = quotes.get(position.id);
      const markPrice = quote?.mid;
      const direction = position.side === "long" ? 1 : -1;
      return {
        ...position,
        markPrice,
        estimatedUnrealizedPnl: markPrice === undefined ? undefined : (markPrice - position.entry_price) * position.size * direction,
        estimatedCloseFee: quote?.estimatedFee,
      };
    });
    await ctx.reply(positionsMessage(views), {
      reply_markup: new InlineKeyboard().text("Refresh", "positions").text("Closed Positions", "closed").row().text("Trade", "trade").text("Account Status", "status"),
    });
  }
  bot.command("positions", async (ctx) => { try { await showPositions(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });
  bot.callbackQuery("positions", async (ctx) => { await ctx.answerCallbackQuery(); try { await showPositions(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });

  async function showClosedPositions(ctx: Context) {
    const { account, client } = await selectedAccount(ctx);
    const positions = await client.listClosedPositions(account.id, 10);
    const keyboard = new InlineKeyboard();
    positions.forEach((position, index) => {
      keyboard.text(`Share #${index + 1} · ${position.symbol || position.coin}`, `shareclosed:${index}`);
      if (index % 2 === 1) keyboard.row();
    });
    if (positions.length % 2 === 1) keyboard.row();
    keyboard.text("Refresh", "closed").text("Open Positions", "positions").row().text("Trade", "trade").text("Account Status", "status");
    await ctx.reply(closedPositionsMessage(positions), {
      reply_markup: keyboard,
    });
  }
  bot.command("closed", async (ctx) => { try { await showClosedPositions(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });
  bot.callbackQuery("closed", async (ctx) => { await ctx.answerCallbackQuery(); try { await showClosedPositions(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });
  bot.callbackQuery(/^shareclosed:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Creating share card…" });
    try {
      const { account, client } = await selectedAccount(ctx);
      const position = (await client.listClosedPositions(account.id, 10))[Number(ctx.match[1])];
      if (!position) throw new Error("That closed position is no longer in the recent list. Refresh and try again.");
      const image = await createClosedPositionShareCard(position, ctx.me.username);
      const symbol = (position.symbol || position.coin).replace(/[^A-Za-z0-9_-]/g, "");
      await ctx.replyWithPhoto(new InputFile(image, `funded-guardian-${symbol}-${position.id}.png`), {
        caption: closedPositionCaption(position, ctx.me.username),
      });
    } catch (error) {
      await ctx.reply(`❌ Could not create share card\n\n${apiError(error)}`);
    }
  });
  bot.command("accounts", async (ctx) => { try { await showAccounts(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });
  bot.callbackQuery("accounts", async (ctx) => { await ctx.answerCallbackQuery(); try { await showAccounts(ctx); } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); } });
  bot.callbackQuery(/^account:(\d+)$/, async (ctx) => {
    try {
      const { user, client } = await session(ctx);
      const chosen = (await client.listAccounts())[Number(ctx.match[1])];
      if (!chosen) throw new Error("That account selection expired.");
      await db.setSelectedAccount(user.telegramId, chosen.id);
      await ctx.answerCallbackQuery({ text: "Account selected." });
      await ctx.reply(`✅ Using ${chosen.name ?? chosen.id}`, { reply_markup: new InlineKeyboard().text("View Status", "status") });
    } catch (error) { await ctx.answerCallbackQuery(); await ctx.reply(`❌ ${apiError(error)}`); }
  });

  async function showSettings(ctx: Context) {
    const user = await ensureUser(ctx);
    await ctx.reply(`⚙️ Risk Settings\n\nRisk per trade: $${user.riskUsd}\nHard cap: $${user.maxRiskUsd}\nStop distance: ${user.stopPercent}%\nReward/risk: ${user.rewardRisk}:1\nLeverage: ${user.leverage}×\nMax loss-room use: ${user.maxLossRoomUsagePercent}%`, {
      reply_markup: new InlineKeyboard().text("Risk $25", "risk:25").text("$50", "risk:50").text("$75", "risk:75").text("$100", "risk:100").row().text("Back", "status"),
    });
  }
  bot.command("settings", showSettings);
  bot.callbackQuery("settings", async (ctx) => { await ctx.answerCallbackQuery(); await showSettings(ctx); });
  bot.callbackQuery(/^risk:(25|50|75|100)$/, async (ctx) => {
    const user = await ensureUser(ctx);
    const risk = Number(ctx.match[1]);
    if (risk > user.maxRiskUsd) return void (await ctx.answerCallbackQuery({ text: `Your hard cap is $${user.maxRiskUsd}.`, show_alert: true }));
    await db.updateRisk(user.telegramId, risk);
    await ctx.answerCallbackQuery({ text: `Risk set to $${risk}.` });
    await showSettings(ctx);
  });

  async function showTrade(ctx: Context) {
    const user = await ensureUser(ctx);
    if (!activeSubscription(user)) return void (await ctx.reply("Your trial has ended. Subscription checkout is not enabled in this beta."));
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return void (await ctx.reply("🔒 Trading is locked until 00:00 UTC."));
    if (!(await db.getConnection(user.telegramId))) return void (await ctx.reply("Connect MyFundedPerps first with /connect."));
    await ctx.reply(`Choose a protected trade. Risk preset: $${user.riskUsd}.`, { reply_markup: tradeKeyboard() });
  }
  bot.command("trade", showTrade);
  bot.callbackQuery("trade", async (ctx) => { await ctx.answerCallbackQuery(); await showTrade(ctx); });

  async function lock(ctx: Context) {
    const user = await ensureUser(ctx);
    const until = await db.lockUntilTomorrow(user.telegramId);
    await ctx.reply(`🔒 New trades locked until ${until.toISOString().replace("T", " ").slice(0, 16)} UTC.`);
  }
  bot.command("lock", lock);
  bot.callbackQuery("lock", async (ctx) => { await ctx.answerCallbackQuery({ text: "Trading locked." }); await lock(ctx); });
  bot.command("unlock", async (ctx) => { const user = await ensureUser(ctx); await db.unlock(user.telegramId); await ctx.reply("🔓 Trading lock removed."); });

  bot.callbackQuery(/^draft:(BTC|ETH|SOL):(buy|sell)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking account and quote…" });
    const symbol = ctx.match[1]!;
    const side = ctx.match[2]! as Side;
    try {
      const { user, account, client } = await selectedAccount(ctx);
      if (!activeSubscription(user)) throw new Error("Your trial has ended.");
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw new Error("Trading is locked until 00:00 UTC.");
      const [policy, markets] = await Promise.all([client.getTradingPolicy(account.id), client.listMarkets()]);
      const problems = guardAccount(account, policy, user.riskUsd, user.maxRiskUsd, user.maxLossRoomUsagePercent);
      if (problems.length) return void (await ctx.reply(`🛑 Trade blocked\n\n${problems.map((item) => `• ${item}`).join("\n")}`));
      const market = findMarket(markets, symbol);
      if (!market) throw new Error(`${symbol} market is not currently available.`);
      const initialQuote = await client.getQuote(market.id);
      const precision = market.size_precision ?? market.quantity_precision ?? 6;
      const provisionalSize = calculateSize(user.riskUsd, initialQuote.mid, user.stopPercent, precision);
      const quote = await client.getQuote(market.id, side, provisionalSize);
      if (quote.fillable === false) throw new Error("The calculated size is not fillable at this market precision.");
      const ticket = buildTicket({
        id: randomUUID().slice(0, 12), userId: user.telegramId, accountId: account.id, market, symbol, side,
        riskUsd: user.riskUsd, quote, stopPercent: user.stopPercent, rewardRisk: user.rewardRisk,
        leverage: user.leverage, ttlSeconds: config.CONFIRMATION_TTL_SECONDS,
      });
      if (policy.limits?.max_position_value_usd && ticket.estimatedNotional > policy.limits.max_position_value_usd) throw new Error("Estimated notional exceeds the account policy cap.");
      await db.putTicket(ticket);
      await ctx.reply(ticketMessage(ticket, config.DRY_RUN), {
        reply_markup: new InlineKeyboard().text(config.DRY_RUN ? "Run Dry Test" : "Confirm Trade", `confirm:${ticket.id}`).text("Cancel", `cancel:${ticket.id}`),
      });
    } catch (error) { await ctx.reply(`❌ ${apiError(error)}`); }
  });

  bot.callbackQuery(/^cancel:([a-f0-9-]+)$/, async (ctx) => {
    await db.takeTicket(ctx.match[1]!, ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Trade canceled." });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  });
  bot.callbackQuery(/^confirm:([a-f0-9-]+)$/, async (ctx) => {
    const ticket = await db.takeTicket(ctx.match[1]!, ctx.from.id);
    if (!ticket) return void (await ctx.answerCallbackQuery({ text: "This quote expired or was already used.", show_alert: true }));
    const user = await ensureUser(ctx);
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return void (await ctx.answerCallbackQuery({ text: "Trading is locked.", show_alert: true }));
    await ctx.answerCallbackQuery({ text: config.DRY_RUN ? "Dry run complete." : "Submitting protected order…" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    if (config.DRY_RUN) return void (await ctx.reply(`✅ DRY RUN passed\n\n${ticket.symbol} ${ticket.side.toUpperCase()} validated. No order was sent.`));
    try {
      const { client } = await session(ctx);
      const result = await client.placeProtectedMarketOrder({
        accountId: ticket.accountId, marketId: ticket.marketId, side: ticket.side, size: ticket.size,
        expectedPrice: ticket.expectedPrice, leverage: ticket.leverage, stopLossPrice: ticket.stopLossPrice,
        takeProfitPrice: ticket.takeProfitPrice, clientOrderId: `guardian-${ticket.id}`,
      });
      await ctx.reply(`✅ Protected order submitted\n\n${ticket.symbol} ${ticket.side.toUpperCase()} · ${ticket.size}\nStatus: ${String(result.status ?? "pending")}\nTP and SL were included.`);
    } catch (error) { await ctx.reply(`❌ Order not submitted\n\n${apiError(error)}`); }
  });

  if (config.ADMIN_TELEGRAM_ID) {
    bot.command("adminstats", async (ctx) => {
      if (ctx.from?.id !== config.ADMIN_TELEGRAM_ID) return;
      const stats = await db.stats();
      await ctx.reply(`Users: ${stats.users}\nConnected accounts: ${stats.connected}`);
    });
  }

  bot.catch(({ error }) => console.error("Bot error", error));
  return bot;
}
