import {MobilePush} from './mobile-push.js';
import { parseGuards } from "./mobile-guards.js";
import { MobileActivity } from "./mobile-activity.js";
import { MobileTrading } from "./mobile-trading.js";
import { MobileAuth } from "./mobile-auth.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { SecretBox } from "./crypto.js";
import { Database } from "./db.js";
import { isActiveAccount, isPassedAccount, MfpClient, MfpError } from "./mfp.js";
import { accountDailyPnl, automaticLockReason } from "./guardian.js";
import { accountRisk, accountRuleProgress, buildTicket, calculateSize, guardAccount, platformRuleCheck, resolveAccountRequirements, riskAllowance } from "./risk.js";
import { createClosedPositionShareCard } from "./share-card.js";
import { createPassedAccountCard } from "./passed-card.js";
import { validateTelegramInitData, type TelegramMiniAppUser } from "./telegram-auth.js";
import type { Market, PositionView, Side, TradingPolicy } from "./types.js";

const HOSTS = {
  sandbox: "https://sandbox.myfundedperpetuals.com",
  live: "https://developers.myfundedperpetuals.com",
} as const;

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function errorMessage(error: unknown) {
  if (error instanceof MfpError) return `MyFundedPerps: ${error.message}`;
  return error instanceof Error ? error.message : "Unexpected error.";
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new Error("Request is too large.");
    chunks.push(buffer);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function marketSymbol(market: Market) {
  return String(market.symbol ?? market.id.split("|").at(-1) ?? market.id).toUpperCase();
}

function marketCoin(market: Market) {
  return String(market.coin ?? marketSymbol(market));
}

function marketProvider(market: Market) {
  return String(market.provider ?? market.id.split("|")[0] ?? "binance");
}

export function startMiniAppServer(config: Config, db: Database) {
  const mobileAuth = new MobileAuth(db);
  const mobileActivity = new MobileActivity(mobileAuth, config);
  const mobileTrading = new MobileTrading(mobileAuth, config);
  const mobilePush=new MobilePush(db);
  const mobileAuthReady = mobileAuth.migrate().then(async()=>{await mobilePush.migrate();mobilePush.start();});
  mobileAuthReady.catch(() => console.error("Mobile authentication database setup failed."));
  const authRequests = new Map<string, { count: number; until: number }>();
  const secrets = new SecretBox(config.ENCRYPTION_KEY);
  const publicRoot = path.join(process.cwd(), "public", "miniapp");

  async function authenticatedUser(request: IncomingMessage) {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("tma ")) throw new Error("Open Funded Guardian from Telegram.");
    const telegram = validateTelegramInitData(authorization.slice(4), config.TELEGRAM_BOT_TOKEN);
    const user = await db.upsertUser({
      telegramId: telegram.id,
      username: telegram.username,
      firstName: telegram.first_name,
    });
    return { telegram, user };
  }

  async function session(request: IncomingMessage) {
    const state = await authenticatedUser(request);
    const connection = await db.getConnection(state.user.telegramId);
    if (!connection) throw new Error("Connect MyFundedPerps in the bot first.");
    const client = new MfpClient(HOSTS[connection.environment], secrets.decrypt(connection.encryptedApiKey));
    return { ...state, connection, client };
  }

  async function selectedAccount(request: IncomingMessage) {
    const state = await session(request);
    const accounts = (await state.client.listAccounts()).filter(account => isActiveAccount(account) || isPassedAccount(account));
    if (!accounts.length) throw new Error("No active or passed MyFundedPerps account was found.");
    let accountId = state.user.selectedAccountId;
    if (!accountId || !accounts.some((account) => account.id === accountId)) {
      const preferred = accounts.find(isActiveAccount) ?? accounts[0];
      if (!preferred) throw new Error("No accessible challenge account was found.");
      accountId = preferred.id;
      await db.setSelectedAccount(state.user.telegramId, accountId);
    }
    return { ...state, accounts, account: await state.client.getAccount(accountId) };
  }

  async function dashboard(request: IncomingMessage) {
    const state = await selectedAccount(request);
    const active = isActiveAccount(state.account);
    const [policy, openPositions, closedPositions, workingOrders, allMarkets] = await Promise.all([
      active ? state.client.getTradingPolicy(state.account.id) : Promise.resolve({} as TradingPolicy),
      active ? state.client.listOpenPositions(state.account.id) : Promise.resolve([]),
      state.client.listClosedPositions(state.account.id, 10).catch(error => { if (active) throw error; return []; }),
      active ? state.client.listWorkingOrders(state.account.id) : Promise.resolve([]),
      state.client.listMarkets(),
    ]);

    const quoteMap = new Map<string, { mid: number; estimatedFee?: number }>();
    await Promise.all(openPositions.slice(0, 10).map(async (position) => {
      try {
        const side: Side = position.side === "long" ? "sell" : "buy";
        const quote = await state.client.getQuote(position.market_id, side, Math.abs(position.size));
        quoteMap.set(position.id, { mid: quote.mid, estimatedFee: quote.estimated_fee });
      } catch {
        // The position is still shown if a quote is briefly unavailable.
      }
    }));
    const positions: PositionView[] = openPositions.map((position) => {
      const quote = quoteMap.get(position.id);
      const direction = position.side === "long" ? 1 : -1;
      return {
        ...position,
        markPrice: quote?.mid,
        estimatedUnrealizedPnl: quote ? (quote.mid - position.entry_price) * position.size * direction : undefined,
        estimatedCloseFee: quote?.estimatedFee,
      };
    });

    // Return metadata for every available market without a quote request per row.
    const markets = allMarkets.filter(market => market.available !== false)
      .map(market => ({
        id: market.id,
        symbol: marketSymbol(market),
        coin: marketCoin(market),
        provider: marketProvider(market),
        category: typeof market.category === "string" ? market.category : undefined,
        maxLeverage: typeof market.max_leverage === "number" ? market.max_leverage : undefined,
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.provider.localeCompare(b.provider));
    const problems = active ? guardAccount(
      state.account,
      policy,
      state.user.riskUsd,
      state.user.maxRiskUsd,
      state.user.maxLossRoomUsagePercent,
      state.user.guardianMode === "enforce",
    ) : ["This evaluation has passed. Continue the funding steps on MyFundedPerps."];
    const dailyPnl = accountDailyPnl(state.account);
    const autoLockReason = active ? automaticLockReason(state.user, dailyPnl) : undefined;
    let lockedUntil = state.user.lockedUntil;
    if (autoLockReason && (!lockedUntil || lockedUntil.getTime() <= Date.now())) lockedUntil = await db.lockUntilTomorrow(state.user.telegramId);
    if (lockedUntil && lockedUntil.getTime() > Date.now()) problems.unshift(`${autoLockReason ?? "Trading is locked"} until the next New York trading day.`);

    return {
      user: {
        firstName: state.telegram.first_name,
        username: state.telegram.username,
        riskUsd: state.user.riskUsd,
        maxRiskUsd: state.user.maxRiskUsd,
        maxLossRoomUsagePercent: state.user.maxLossRoomUsagePercent,
        enforceGuardrails: state.user.enforceGuardrails,
        guardianMode: state.user.guardianMode,
        stopPercent: state.user.stopPercent,
        rewardRisk: state.user.rewardRisk,
        leverage: state.user.leverage,
        dailyProfitLockUsd: state.user.dailyProfitLockUsd,
        dailyLossLockUsd: state.user.dailyLossLockUsd,
        alertsEnabled: state.user.alertsEnabled,
        lockedUntil,
      },
      connection: { environment: state.connection.environment, keyLastFour: state.connection.keyLastFour },
      account: {
        id: state.account.id,
        name: state.account.name ?? state.account.id,
        status: state.account.status,
        stage: state.account.stage,
        balance: state.account.balance,
        startingBalance: state.account.starting_balance,
        risk: { ...accountRisk(state.account), requirements: resolveAccountRequirements(state.account, policy) },
      },
      accounts: state.accounts.map((account) => ({ id: account.id, name: account.name ?? account.id, status: account.status, stage: account.stage })),
      passed: isPassedAccount(state.account),
      safeToTrade: problems.length === 0,
      problems,
      positions,
      closedPositions,
      workingOrders,
      dailyPnl,
      autoLockReason,
      ruleProgress: accountRuleProgress(state.account, policy),
      tradeLimits: {
        maxLeverage: typeof policy.limits?.max_leverage === "number" ? policy.limits.max_leverage : undefined,
        maxPositionNotional: policy.limits?.max_position_value_usd,
        maximumTotalNotional: typeof policy.maximum_total_notional_usd === "number" ? policy.maximum_total_notional_usd : undefined,
      },
      markets,
      dryRun: config.DRY_RUN,
    };
  }

  async function createTicket(request: IncomingMessage, payload: Record<string, unknown>) {
    const state = await selectedAccount(request);
    if (!isActiveAccount(state.account)) throw new Error("This account is not active for trading. Select an active account.");
    const marketId = String(payload.marketId ?? "");
    const side = payload.side === "buy" || payload.side === "sell" ? payload.side : undefined;
    const requestedRisk = Number(payload.riskUsd ?? state.user.riskUsd);
    const requestedLeverage = Number(payload.leverage ?? state.user.leverage);
    if (!side || !marketId) throw new Error("Choose a market and a direction.");
    if (!Number.isFinite(requestedRisk) || requestedRisk <= 0 || requestedRisk > 100_000) {
      throw new Error("Risk must be between $1 and $100,000.");
    }
    if (!Number.isInteger(requestedLeverage) || requestedLeverage < 1 || requestedLeverage > 100) {
      throw new Error("Leverage must be a whole number between 1x and 100x.");
    }
    const autoLockReason = automaticLockReason(state.user, accountDailyPnl(state.account));
    if (autoLockReason) {
      await db.lockUntilTomorrow(state.user.telegramId);
      throw new Error(`${autoLockReason}. Guardian locked new trades until the next New York trading day.`);
    }
    if (state.user.lockedUntil && state.user.lockedUntil.getTime() > Date.now()) throw new Error("Trading is locked until the next New York trading day.");
    const [policy, markets, openPositions] = await Promise.all([
      state.client.getTradingPolicy(state.account.id),
      state.client.listMarkets(),
      state.client.listOpenPositions(state.account.id),
    ]);
    if (state.user.guardianMode === "enforce") {
      const allowance = riskAllowance(state.account, state.user.maxRiskUsd, state.user.maxLossRoomUsagePercent);
      if (requestedRisk > state.user.maxRiskUsd) throw new Error(`Requested risk $${requestedRisk} exceeds your $${state.user.maxRiskUsd} limit.`);
      if (requestedRisk > allowance.allowedRisk) throw new Error(`Risk exceeds your configured loss-room limit of $${allowance.allowedRisk.toFixed(2)}.`);
    }
    const market = markets.find(item => item.id === marketId && item.available !== false);
    if (!market) throw new Error("That market is not currently available.");
    const symbol = marketSymbol(market);
    const firstQuote = await state.client.getQuote(market.id);
    const precision = market.size_precision ?? market.quantity_precision ?? 6;
    const provisionalSize = calculateSize(requestedRisk, firstQuote.mid, state.user.stopPercent, precision);
    const quote = await state.client.getQuote(market.id, side, provisionalSize);
    if (quote.fillable === false) throw new Error("The calculated size is not fillable.");
    const ticket = buildTicket({
      id: randomUUID().slice(0, 12),
      userId: state.user.telegramId,
      accountId: state.account.id,
      market,
      symbol,
      side,
      riskUsd: requestedRisk,
      quote,
      stopPercent: state.user.stopPercent,
      rewardRisk: state.user.rewardRisk,
      leverage: requestedLeverage,
      ttlSeconds: config.CONFIRMATION_TTL_SECONDS,
    });
    if (state.user.guardianMode === "warn") {
      const allowance = riskAllowance(state.account, state.user.maxRiskUsd, state.user.maxLossRoomUsagePercent);
      if (requestedRisk > allowance.allowedRisk) {
        ticket.guardianWarning = `This trade risks $${requestedRisk.toFixed(2)}, above your configured Guardian limit of $${allowance.allowedRisk.toFixed(2)}. Warnings-only mode is enabled.`;
      }
    }
    ticket.platformRules = platformRuleCheck({ account: state.account, policy, market, ticket, openPositions });
    await db.putTicket(ticket);
    return ticket;
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string) {
    if (request.method === "GET" && pathname === "/api/session") {
      const { user } = await authenticatedUser(request);
      const connection = await db.getConnection(user.telegramId);
      return json(response, 200, { connected: !!connection, onboardingState: user.onboardingState, allowLive: config.ALLOW_LIVE_TRADING, isAdmin: config.ADMIN_TELEGRAM_ID === user.telegramId, refreshSeconds: config.MINI_APP_REFRESH_SECONDS });
    }
    if (request.method === "GET" && pathname === "/api/admin/stats") {
      const { telegram } = await authenticatedUser(request);
      if (!config.ADMIN_TELEGRAM_ID || telegram.id !== config.ADMIN_TELEGRAM_ID) throw new Error("Admin access required.");
      return json(response, 200, await db.adminStats());
    }
    if (request.method === "POST" && pathname === "/api/connect") {
      const { user } = await authenticatedUser(request);
      const payload = await body(request);
      const key = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      if (!/^fp_(test|live)_[A-Za-z0-9_-]+$/.test(key)) throw new Error("Paste a MyFundedPerps API key beginning fp_live_ or fp_test_.");
      const environment = key.startsWith("fp_test_") ? "sandbox" : "live";
      if (environment === "live" && !config.ALLOW_LIVE_TRADING) throw new Error("Live connections are not enabled. Use a sandbox key or contact the bot owner.");
      const client = new MfpClient(HOSTS[environment], key);
      const accounts = (await client.listAccounts()).filter(account => isActiveAccount(account) || isPassedAccount(account));
      if (!accounts.length) throw new Error("This key has no active or passed challenge accounts.");
      const preferred = accounts.find(isActiveAccount) ?? accounts[0]!;
      await db.saveConnection(user.telegramId, { environment, encryptedApiKey: secrets.encrypt(key), keyLastFour: key.slice(-4) });
      await db.setSelectedAccount(user.telegramId, preferred.id);
      await db.setOnboardingState(user.telegramId, "choose_guardrails");
      return json(response, 200, { connected: true });
    }
    if (request.method === "GET" && pathname === "/api/dashboard") {
      return json(response, 200, await dashboard(request));
    }
    if (request.method === "POST" && pathname === "/api/account") {
      const state = await session(request);
      const payload = await body(request);
      const accountId = String(payload.accountId ?? "");
      const accounts = (await state.client.listAccounts()).filter(account => isActiveAccount(account) || isPassedAccount(account));
      if (!accounts.some((account) => account.id === accountId)) throw new Error("That account is unavailable.");
      await db.setSelectedAccount(state.user.telegramId, accountId);
      return json(response, 200, { ok: true });
    }
    const milestoneMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/milestone$/);
    if (request.method === "GET" && milestoneMatch) {
      const state = await session(request);
      const accountId = decodeURIComponent(milestoneMatch[1]!);
      const listed = (await state.client.listAccounts()).find(account => account.id === accountId && isPassedAccount(account));
      if (!listed) throw new Error("A passed evaluation is required for this celebration card.");
      const account = await state.client.getAccount(accountId);
      if (!isPassedAccount(account)) throw new Error("This evaluation is not marked passed by MyFundedPerps.");
      const image = await createPassedAccountCard(account, state.telegram.username);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": "attachment; filename=guardian-evaluation-passed.png",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(image);
      return;
    }
    if (request.method === "POST" && pathname === "/api/lock") {
      const { user } = await authenticatedUser(request);
      const payload = await body(request);
      if (payload.locked === false) {
        await db.unlock(user.telegramId);
        return json(response, 200, { lockedUntil: null });
      }
      return json(response, 200, { lockedUntil: await db.lockUntilTomorrow(user.telegramId) });
    }
    if (request.method === "POST" && pathname === "/api/settings/risk") {
      const { user } = await authenticatedUser(request);
      const payload = await body(request);
      const risk = Number(payload.riskUsd);
      if (!Number.isFinite(risk) || risk <= 0 || risk > 100_000) throw new Error("Risk must be between $1 and $100,000.");
      if (user.guardianMode === "enforce" && risk > user.maxRiskUsd) throw new Error(`Risk exceeds your $${user.maxRiskUsd} maximum risk per trade.`);
      await db.updateRisk(user.telegramId, risk);
      return json(response, 200, { riskUsd: risk });
    }
    if (request.method === "POST" && pathname === "/api/settings/guardian") {
      const { user } = await authenticatedUser(request);
      const payload = await body(request);
      const optionalAmount = (value: unknown, label: string) => {
        if (value === null || value === undefined || value === "") return undefined;
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 10 || amount > 100_000) throw new Error(`${label} must be between $10 and $100,000.`);
        return amount;
      };
      const settings = {
        dailyProfitLockUsd: optionalAmount(payload.dailyProfitLockUsd, "Profit lock"),
        dailyLossLockUsd: optionalAmount(payload.dailyLossLockUsd, "Loss lock"),
        alertsEnabled: payload.alertsEnabled !== false,
        maxLossRoomUsagePercent: Number(payload.maxLossRoomUsagePercent ?? 100),
        maxRiskUsd: Number(payload.maxRiskUsd ?? 100000),
        guardianMode: String(payload.guardianMode ?? "off") as "off" | "warn" | "enforce",
      };
      if (!["off", "warn", "enforce"].includes(settings.guardianMode)) throw new Error("Choose Off, Warnings, or Enforced for Guardian limits.");
      if (!Number.isFinite(settings.maxLossRoomUsagePercent) || settings.maxLossRoomUsagePercent < 1 || settings.maxLossRoomUsagePercent > 100) {
        throw new Error("Maximum loss-room use must be between 1% and 100%.");
      }
      if (!Number.isFinite(settings.maxRiskUsd) || settings.maxRiskUsd < 1 || settings.maxRiskUsd > 100_000) {
        throw new Error("Maximum trade risk must be between $1 and $100,000.");
      }
      await db.updateGuardianSettings(user.telegramId, settings);
      if (user.onboardingState === "choose_guardrails") await db.setOnboardingState(user.telegramId, null);
      return json(response, 200, settings);
    }
    if (request.method === "POST" && pathname === "/api/trade/quote") {
      return json(response, 200, { ticket: await createTicket(request, await body(request)), dryRun: config.DRY_RUN });
    }
    if (request.method === "POST" && pathname === "/api/trade/confirm") {
      const { user, client } = await session(request);
      const payload = await body(request);
      const ticket = await db.takeTicket(String(payload.ticketId ?? ""), user.telegramId);
      if (!ticket) throw new Error("This quote expired or was already used.");
      const currentUser = await db.getUser(user.telegramId);
      if (currentUser.lockedUntil && currentUser.lockedUntil.getTime() > Date.now()) throw new Error("Trading is locked.");
      const [freshAccount, freshPolicy, freshPositions, freshMarkets] = await Promise.all([
        client.getAccount(ticket.accountId),
        client.getTradingPolicy(ticket.accountId),
        client.listOpenPositions(ticket.accountId),
        client.listMarkets(),
      ]);
      if (!isActiveAccount(freshAccount)) throw new Error("This challenge is no longer active for trading.");
      const freshMarket = freshMarkets.find(item => item.id === ticket.marketId && item.available !== false);
      if (!freshMarket) throw new Error("MyFundedPerps rule check: this market is no longer available.");
      const freshCheck = platformRuleCheck({ account: freshAccount, policy: freshPolicy, market: freshMarket, ticket, openPositions: freshPositions });
      if (config.DRY_RUN) {
        await db.recordTradeExecution({ ticketId: ticket.id, telegramId: user.telegramId, accountId: ticket.accountId, symbol: ticket.symbol, side: ticket.side, notionalUsd: ticket.estimatedNotional, dryRun: true, status: "validated" });
        return json(response, 200, { dryRun: true, status: "validated" });
      }
      const result = await client.placeProtectedMarketOrder({
        accountId: ticket.accountId,
        marketId: ticket.marketId,
        side: ticket.side,
        size: ticket.size,
        expectedPrice: ticket.expectedPrice,
        leverage: ticket.leverage,
        stopLossPrice: ticket.stopLossPrice,
        takeProfitPrice: ticket.takeProfitPrice,
        clientOrderId: `guardian-${ticket.id}`,
      });
      const status = String(result?.status ?? "pending");
      await db.recordTradeExecution({ ticketId: ticket.id, telegramId: user.telegramId, accountId: ticket.accountId, symbol: ticket.symbol, side: ticket.side, notionalUsd: ticket.estimatedNotional, dryRun: false, status });
      return json(response, 200, { dryRun: false, status });
    }
    const closeMatch = pathname.match(/^\/api\/positions\/([^/]+)\/close$/);
    if (request.method === "POST" && closeMatch) {
      const state = await selectedAccount(request);
      const payload = await body(request);
      const positionId = decodeURIComponent(closeMatch[1]!);
      const [positions, markets] = await Promise.all([
        state.client.listOpenPositions(state.account.id),
        state.client.listMarkets(),
      ]);
      const position = positions.find(item => item.id === positionId);
      if (!position) throw new Error("That open position is unavailable. Refresh and try again.");
      const percent = Number(payload.percent);
      if (![25, 50, 75, 100].includes(percent)) throw new Error("Choose 25%, 50%, 75%, or 100%.");
      if (config.DRY_RUN) return json(response, 200, { dryRun: true, status: "validated" });
      const market = markets.find(item => item.id === position.market_id || item.market_id === position.market_id);
      const precision = market?.size_precision ?? market?.quantity_precision ?? 8;
      const factor = 10 ** precision;
      const size = percent === 100 ? undefined : Math.floor(position.size * percent / 100 * factor) / factor;
      if (size !== undefined && size <= 0) throw new Error("This partial close is below the market's minimum size. Use Close all instead.");
      const closeSide = position.side === "long" ? "sell" : "buy";
      const closeSize = size ?? position.size;
      const quote = await state.client.getQuote(position.market_id, closeSide, closeSize);
      if (quote.fillable === false) throw new Error("MyFundedPerps cannot currently fill this close size. Try again or close a smaller amount.");
      const expectedPrice = quote.estimated_fill_price ?? (closeSide === "sell" ? quote.bid : quote.ask) ?? quote.mid;
      if (!Number.isFinite(expectedPrice) || expectedPrice <= 0) throw new Error("A valid close price is not currently available. Refresh and try again.");
      const result = await state.client.closePosition(position.id, size, expectedPrice);
      return json(response, 200, { dryRun: false, status: result?.status ?? "pending" });
    }
    const protectionMatch = pathname.match(/^\/api\/positions\/([^/]+)\/protection$/);
    if (request.method === "PUT" && protectionMatch) {
      const state = await selectedAccount(request);
      const payload = await body(request);
      const positionId = decodeURIComponent(protectionMatch[1]!);
      const [positions, workingOrders] = await Promise.all([
        state.client.listOpenPositions(state.account.id),
        state.client.listWorkingOrders(state.account.id),
      ]);
      const position = positions.find(item => item.id === positionId);
      if (!position) throw new Error("That open position is unavailable. Refresh and try again.");
      const takeProfitPrice = Number(payload.takeProfitPrice);
      const stopLossPrice = Number(payload.stopLossPrice);
      if (![takeProfitPrice, stopLossPrice].every(value => Number.isFinite(value) && value > 0)) throw new Error("Enter positive TP and SL prices.");
      const reference = position.entry_price;
      if (position.side === "long" && !(takeProfitPrice > reference && stopLossPrice < reference)) throw new Error("For a long, TP must be above entry and SL below entry.");
      if (position.side === "short" && !(takeProfitPrice < reference && stopLossPrice > reference)) throw new Error("For a short, TP must be below entry and SL above entry.");
      if (config.DRY_RUN) return json(response, 200, { dryRun: true, status: "validated" });
      const result = await state.client.replacePositionExits(position, workingOrders, takeProfitPrice, stopLossPrice);
      return json(response, 200, { dryRun: false, status: result?.status ?? "updated" });
    }
    const cancelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const state = await selectedAccount(request);
      const orderId = decodeURIComponent(cancelMatch[1]!);
      const order = (await state.client.listWorkingOrders(state.account.id)).find(item => item.id === orderId);
      if (!order) throw new Error("That working order is unavailable. Refresh and try again.");
      if (config.DRY_RUN) return json(response, 200, { dryRun: true, status: "validated" });
      const result = await state.client.cancelOrder(order.id);
      return json(response, 200, { dryRun: false, status: result?.status ?? "canceling" });
    }
    const shareMatch = pathname.match(/^\/api\/share\/([^/]+)$/);
    if (request.method === "GET" && shareMatch) {
      const state = await selectedAccount(request);
      const positions = await state.client.listClosedPositions(state.account.id, 25);
      const position = positions.find((item) => item.id === decodeURIComponent(shareMatch[1]!));
      if (!position) throw new Error("That closed position is unavailable.");
      const image = await createClosedPositionShareCard(position, state.telegram.username);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="funded-guardian-${position.id}.png"`,
        "Cache-Control": "private, no-store",
      });
      response.end(image);
      return;
    }
    json(response, 404, { error: "Not found." });
  }

  const staticFiles: Record<string, { file: string; type: string }> = {
    "/privacy": { file: "privacy.html", type: "text/html; charset=utf-8" },
    "/privacy/": { file: "privacy.html", type: "text/html; charset=utf-8" },
    "/support": { file: "support.html", type: "text/html; charset=utf-8" },
    "/support/": { file: "support.html", type: "text/html; charset=utf-8" },
    "/legal.css": { file: "legal.css", type: "text/css; charset=utf-8" },
    "/app": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v3.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v4.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v5.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v6.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v7.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v8.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v9.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v10.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v11.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v12.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v13.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v15.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v17.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v18.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v19.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v20.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v21.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v22.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v23.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v24.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v25.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v3.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v4.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v5.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v6.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v7.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v8.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v9.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v10.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v11.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v12.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v13.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v14.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v15.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v17.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v18.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v19.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v20.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v21.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v22.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v23.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v24.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/mobile/auth/")) {
        await mobileAuthReady;
        let address = request.socket.remoteAddress ?? "unknown";
        if (request.headers.authorization?.startsWith("Bearer ")) {
          try { address = `mobile:${(await mobileAuth.user(request.headers.authorization.slice(7))).id}`; }
          catch { return json(response,401,{error:"Session expired. Please sign in again."}); }
        }
        const now = Date.now();
        for (const [key, value] of authRequests) if (value.until < now) authRequests.delete(key);
        const limit = authRequests.get(address) ?? { count: 0, until: now + 60_000 };
        limit.count++;
        authRequests.set(address, limit);
        if (limit.count > 60) return json(response, 429, { error: "Too many sign-in requests. Try again shortly." });
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        try {
          if (url.pathname === "/api/mobile/auth/challenge" && request.method === "POST") return json(response, 200, { nonce: await mobileAuth.challenge() });
          if (url.pathname === "/api/mobile/auth/login" && request.method === "POST") {
            const input = await body(request);
            if ((input.provider !== "apple" && input.provider !== "google") || typeof input.idToken !== "string" || input.idToken.length > 16000) return json(response, 400, { error: "Invalid sign-in request." });
            return json(response, 200, await mobileAuth.login(input.provider, input.idToken, typeof input.nonce === "string" ? input.nonce : undefined));
          }
          if (url.pathname === "/api/mobile/auth/connect" && request.method === "POST") {
            await mobileAuth.user(token);
            const input = await body(request);
            const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
            if (!/^fp_(test|live)_[A-Za-z0-9_-]+$/.test(apiKey)) return json(response,400,{error:"Paste a key beginning fp_live_ or fp_test_."});
            const environment = apiKey.startsWith("fp_test_") ? "sandbox" : "live";
            if (environment === "live" && !config.ALLOW_LIVE_TRADING) return json(response,400,{error:"Live account connections are not enabled yet."});
            let accounts;
            try { accounts = (await new MfpClient(HOSTS[environment],apiKey).listAccounts()).filter(isActiveAccount); }
            catch { return json(response,400,{error:"MyFundedPerps could not verify this key. Check that it is valid and try again."}); }
            if (!accounts.length) return json(response,400,{error:"This key has no active accounts."});
            const preferred = accounts[0]!;
            await mobileAuth.saveConnection(token,{environment,encryptedApiKey:secrets.encrypt(apiKey),keyLastFour:apiKey.slice(-4),accountId:preferred.id});
            return json(response,200,{connected:true,accounts,selectedAccountId:preferred.id,keyLastFour:apiKey.slice(-4)});
          }
          if (url.pathname === "/api/mobile/auth/guards") {
            const connection=await mobileAuth.connection(token);
            if(!connection)return json(response,400,{error:"Connect MyFundedPerps first."});
            if(request.method==='GET')return json(response,200,connection.personal_guards??{mode:'off'});
            if(request.method==='POST'){const input=await body(request);const guards=parseGuards({...connection.personal_guards,...input});await mobileAuth.saveGuards(token,guards);return json(response,200,guards);}
          }
          if(url.pathname==='/api/mobile/auth/notifications'){
            const user=await mobileAuth.user(token);
            if(request.method==='GET')return json(response,200,await mobilePush.preferences(user.id,url.searchParams.get('pushToken')??undefined));
            if(request.method==='POST')return json(response,200,await mobilePush.register(user.id,await body(request)));
            if(request.method==='DELETE'){const input=await body(request);await mobilePush.disable(user.id,typeof input.pushToken==='string'?input.pushToken:undefined);return json(response,200,{ok:true});}
          }
          if (url.pathname === "/api/mobile/auth/pulse" && request.method === "GET") {
            await mobileAuth.user(token);
            return json(response,200,{items:await db.pulseItems(),updatedAt:new Date().toISOString()});
          }
          if(url.pathname==='/api/mobile/auth/protection'&&request.method==='POST'){
            const input=await body(request);if(typeof input.positionId!=='string')throw new Error('Choose an open position.');
            return json(response,200,await mobileActivity.protection(token,input.positionId));
          }
          if(url.pathname==='/api/mobile/auth/share'&&request.method==='POST'){
            const input=await body(request);if(typeof input.positionId!=='string')throw new Error('Choose a closed position.');
            return json(response,200,await mobileActivity.share(token,input.positionId));
          }
          if(url.pathname==='/api/mobile/auth/protection/quote'&&request.method==='POST')return json(response,200,await mobileActivity.quoteProtection(token,await body(request)));
          if(url.pathname==='/api/mobile/auth/protection/confirm'&&request.method==='POST'){
            const input=await body(request);if(typeof input.ticketId!=='string')throw new Error('Review an edit first.');
            return json(response,200,await mobileActivity.confirmProtection(token,input.ticketId));
          }
          if (url.pathname === "/api/mobile/auth/activity" && request.method === "GET") {
            await mobileAuth.user(token);
            try { return json(response,200,await mobileActivity.list(token)); }
            catch(error) { return json(response,400,{error:errorMessage(error)}); }
          }
          if (url.pathname === "/api/mobile/auth/close/quote" && request.method === "POST") {
            await mobileAuth.user(token);
            try { return json(response,200,await mobileActivity.quoteClose(token,await body(request))); }
            catch(error) { return json(response,400,{error:errorMessage(error)}); }
          }
          if (url.pathname === "/api/mobile/auth/close/confirm" && request.method === "POST") {
            await mobileAuth.user(token);
            const input=await body(request);
            try { return json(response,200,await mobileActivity.confirmClose(token,String(input.ticketId??""))); }
            catch(error) { return json(response,400,{error:errorMessage(error)}); }
          }
          if(url.pathname==='/api/mobile/auth/trade/quick'&&request.method==='POST')return json(response,200,await mobileTrading.quick(token,await body(request)));
          if (url.pathname === "/api/mobile/auth/trade/quote" && request.method === "POST") {
            await mobileAuth.user(token);
            try { return json(response,200,await mobileTrading.quote(token,await body(request))); }
            catch(error) { return json(response,400,{error:errorMessage(error)}); }
          }
          if (url.pathname === "/api/mobile/auth/trade/confirm" && request.method === "POST") {
            await mobileAuth.user(token);
            const input = await body(request);
            try { return json(response,200,await mobileTrading.confirm(token,String(input.ticketId??""))); }
            catch(error) { return json(response,400,{error:errorMessage(error)}); }
          }
          if (url.pathname === "/api/mobile/auth/markets" && request.method === "GET") {
            await mobileAuth.user(token);
            try {
              const markets = (await new MfpClient(HOSTS.live, "").listMarkets()).filter(market => market.available !== false)
                .map(market => ({id:market.id,symbol:marketSymbol(market),coin:marketCoin(market),provider:marketProvider(market),category:market.category,maxLeverage:market.max_leverage}));
              return json(response,200,{markets});
            } catch { return json(response,502,{error:"Could not load markets. Please try again."}); }
          }
          if (url.pathname === "/api/mobile/auth/dashboard" && request.method === "GET") {
            const connection = await mobileAuth.connection(token);
            if (!connection) return json(response,400,{error:"Connect MyFundedPerps first."});
            const client = new MfpClient(HOSTS[connection.environment as keyof typeof HOSTS],secrets.decrypt(connection.encrypted_api_key));
            try {
              const account = await client.getAccount(connection.selected_account_id);
              if (!isActiveAccount(account)) return json(response,409,{error:"This account is no longer active. Select another account."});
              const policy = await client.getTradingPolicy(account.id);
              return json(response,200,{account,risk:accountRisk(account),rules:accountRuleProgress(account,policy),updatedAt:new Date().toISOString(),refreshSeconds:config.MINI_APP_REFRESH_SECONDS});
            } catch { return json(response,502,{error:"Could not refresh account data. Please try again."}); }
          }
          if (url.pathname === "/api/mobile/auth/connection" && request.method === "GET") {
            const connection = await mobileAuth.connection(token);
            if (!connection) return json(response,200,{connected:false});
            const client = new MfpClient(HOSTS[connection.environment as keyof typeof HOSTS],secrets.decrypt(connection.encrypted_api_key));
            let accounts;
            try { accounts = (await client.listAccounts()).filter(isActiveAccount); }
            catch { return json(response,502,{error:"Could not refresh MyFundedPerps accounts. Try again."}); }
            return json(response,200,{connected:true,accounts,selectedAccountId:connection.selected_account_id,keyLastFour:connection.key_last_four});
          }
          if (url.pathname === "/api/mobile/auth/account-selection" && request.method === "POST") {
            const connection = await mobileAuth.connection(token);
            if (!connection) return json(response,400,{error:"Connect MyFundedPerps first."});
            const input = await body(request);
            const client = new MfpClient(HOSTS[connection.environment as keyof typeof HOSTS],secrets.decrypt(connection.encrypted_api_key));
            const accounts = (await client.listAccounts()).filter(isActiveAccount);
            if (!accounts.some(account => account.id === input.accountId)) return json(response,400,{error:"Choose an active account belonging to your API key."});
            await mobileAuth.selectAccount(token,String(input.accountId));
            return json(response,200,{ok:true});
          }
          if (url.pathname === "/api/mobile/auth/connection" && request.method === "DELETE") { await mobileAuth.disconnect(token); return json(response,200,{ok:true}); }
          if (url.pathname === "/api/mobile/auth/me" && request.method === "GET") return json(response, 200, { user: await mobileAuth.user(token) });
          if (url.pathname === "/api/mobile/auth/logout" && request.method === "POST") { await mobilePush.disable((await mobileAuth.user(token)).id); await mobileAuth.logout(token); return json(response, 200, { ok: true }); }
          if (url.pathname === "/api/mobile/auth/account" && request.method === "DELETE") { await mobileAuth.delete(token); return json(response, 200, { ok: true }); }
          return json(response, 404, { error: "Not found." });
        } catch { return json(response, 401, { error: "Could not verify your session. Please sign in again." }); }
      }
      if (url.pathname === "/health") return json(response, 200, { ok: true });
      if (url.pathname === "/") {
        response.writeHead(302, { Location: "/app" });
        return void response.end();
      }
      if (url.pathname === "/app/logo.png") {
        const logo = await readFile(path.join(process.cwd(), "assets", "funded-guardian-logo.png"));
        response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
        return void response.end(logo);
      }
      if (url.pathname.startsWith("/api/")) return void await handleApi(request, response, url.pathname);
      const asset = staticFiles[url.pathname];
      if (asset) {
        const content = await readFile(path.join(publicRoot, asset.file));
        response.writeHead(200, {
          "Content-Type": asset.type,
          "Cache-Control": "no-store, max-age=0",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self' wss://api-stream.myfundedperpetuals.com; img-src 'self' data: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; frame-ancestors https://web.telegram.org https://telegram.org https://*.telegram.org;",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        return void response.end(content);
      }
      json(response, 404, { error: "Not found." });
    } catch (error) {
      const status = errorMessage(error).includes("Telegram authentication") || errorMessage(error).includes("Open Funded") ? 401 : 400;
      json(response, status, { error: errorMessage(error) });
    }
  });

  server.listen(config.PORT, "0.0.0.0", () => {
    console.log(`Funded Guardian Mini App listening on port ${config.PORT}.`);
  });
  return server;
}
