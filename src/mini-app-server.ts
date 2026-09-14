import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { SecretBox } from "./crypto.js";
import { Database, type UserProfile } from "./db.js";
import { MfpClient, MfpError } from "./mfp.js";
import { accountRisk, buildTicket, calculateSize, guardAccount } from "./risk.js";
import { createClosedPositionShareCard } from "./share-card.js";
import { validateTelegramInitData, type TelegramMiniAppUser } from "./telegram-auth.js";
import type { Market, PositionView, Side } from "./types.js";

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

function activeSubscription(user: UserProfile) {
  return user.plan === "pro" || (user.plan === "trial" && user.trialEndsAt.getTime() > Date.now());
}

export function startMiniAppServer(config: Config, db: Database) {
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
    const accounts = await state.client.listAccounts();
    let accountId = state.user.selectedAccountId;
    if (!accountId || !accounts.some((account) => account.id === accountId)) {
      const preferred = accounts.find((account) => ["active", "trading"].includes(String(account.status).toLowerCase())) ?? accounts[0];
      if (!preferred) throw new Error("No accessible challenge account was found.");
      accountId = preferred.id;
      await db.setSelectedAccount(state.user.telegramId, accountId);
    }
    return { ...state, accounts, account: await state.client.getAccount(accountId) };
  }

  async function dashboard(request: IncomingMessage) {
    const state = await selectedAccount(request);
    const [policy, openPositions, closedPositions, allMarkets] = await Promise.all([
      state.client.getTradingPolicy(state.account.id),
      state.client.listOpenPositions(state.account.id),
      state.client.listClosedPositions(state.account.id, 10),
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
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.provider.localeCompare(b.provider));
    const problems = guardAccount(
      state.account,
      policy,
      state.user.riskUsd,
      state.user.maxRiskUsd,
      state.user.maxLossRoomUsagePercent,
    );
    if (!activeSubscription(state.user)) problems.unshift("Your trial has ended.");
    if (state.user.lockedUntil && state.user.lockedUntil.getTime() > Date.now()) problems.unshift("Trading is locked until 00:00 UTC.");

    return {
      user: {
        firstName: state.telegram.first_name,
        username: state.telegram.username,
        plan: state.user.plan,
        trialEndsAt: state.user.trialEndsAt,
        riskUsd: state.user.riskUsd,
        maxRiskUsd: state.user.maxRiskUsd,
        stopPercent: state.user.stopPercent,
        rewardRisk: state.user.rewardRisk,
        leverage: state.user.leverage,
        lockedUntil: state.user.lockedUntil,
      },
      connection: { environment: state.connection.environment, keyLastFour: state.connection.keyLastFour },
      account: {
        id: state.account.id,
        name: state.account.name ?? state.account.id,
        status: state.account.status,
        stage: state.account.stage,
        balance: state.account.balance,
        startingBalance: state.account.starting_balance,
        risk: accountRisk(state.account),
      },
      accounts: state.accounts.map((account) => ({ id: account.id, name: account.name ?? account.id, status: account.status })),
      safeToTrade: problems.length === 0,
      problems,
      positions,
      closedPositions,
      markets,
      dryRun: config.DRY_RUN,
    };
  }

  async function createTicket(request: IncomingMessage, payload: Record<string, unknown>) {
    const state = await selectedAccount(request);
    const marketId = String(payload.marketId ?? "");
    const side = payload.side === "buy" || payload.side === "sell" ? payload.side : undefined;
    const requestedRisk = Number(payload.riskUsd ?? state.user.riskUsd);
    if (!side || !marketId) throw new Error("Choose a market and a direction.");
    if (!Number.isFinite(requestedRisk) || requestedRisk <= 0 || requestedRisk > state.user.maxRiskUsd) {
      throw new Error(`Risk must be between $1 and $${state.user.maxRiskUsd}.`);
    }
    if (!activeSubscription(state.user)) throw new Error("Your trial has ended.");
    if (state.user.lockedUntil && state.user.lockedUntil.getTime() > Date.now()) throw new Error("Trading is locked until 00:00 UTC.");
    const [policy, markets] = await Promise.all([state.client.getTradingPolicy(state.account.id), state.client.listMarkets()]);
    const problems = guardAccount(state.account, policy, requestedRisk, state.user.maxRiskUsd, state.user.maxLossRoomUsagePercent);
    if (problems.length) throw new Error(problems.join(" "));
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
      leverage: state.user.leverage,
      ttlSeconds: config.CONFIRMATION_TTL_SECONDS,
    });
    if (policy.limits?.max_position_value_usd && ticket.estimatedNotional > policy.limits.max_position_value_usd) {
      throw new Error("Estimated notional exceeds the account policy cap.");
    }
    await db.putTicket(ticket);
    return ticket;
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string) {
    if (request.method === "GET" && pathname === "/api/session") {
      const { user } = await authenticatedUser(request);
      const connection = await db.getConnection(user.telegramId);
      return json(response, 200, { connected: !!connection, allowLive: config.ALLOW_LIVE_TRADING });
    }
    if (request.method === "POST" && pathname === "/api/connect") {
      const { user } = await authenticatedUser(request);
      const payload = await body(request);
      const key = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      if (!/^fp_(test|live)_[A-Za-z0-9_-]+$/.test(key)) throw new Error("Paste a MyFundedPerps API key beginning fp_live_ or fp_test_.");
      const environment = key.startsWith("fp_test_") ? "sandbox" : "live";
      if (environment === "live" && !config.ALLOW_LIVE_TRADING) throw new Error("Live connections are not enabled. Use a sandbox key or contact the bot owner.");
      const client = new MfpClient(HOSTS[environment], key);
      const accounts = await client.listAccounts();
      if (!accounts?.length) throw new Error("This key has no accessible accounts. Check its account access in MyFundedPerps.");
      const preferred = accounts.find(item => ["active", "trading"].includes(String(item.status).toLowerCase())) ?? accounts[0]!;
      await db.saveConnection(user.telegramId, { environment, encryptedApiKey: secrets.encrypt(key), keyLastFour: key.slice(-4) });
      await db.setSelectedAccount(user.telegramId, preferred.id);
      await db.setOnboardingState(user.telegramId, null);
      return json(response, 200, { connected: true });
    }
    if (request.method === "GET" && pathname === "/api/dashboard") {
      return json(response, 200, await dashboard(request));
    }
    if (request.method === "POST" && pathname === "/api/account") {
      const state = await session(request);
      const payload = await body(request);
      const accountId = String(payload.accountId ?? "");
      const accounts = await state.client.listAccounts();
      if (!accounts.some((account) => account.id === accountId)) throw new Error("That account is unavailable.");
      await db.setSelectedAccount(state.user.telegramId, accountId);
      return json(response, 200, { ok: true });
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
      if (!Number.isFinite(risk) || risk <= 0 || risk > user.maxRiskUsd) throw new Error(`Risk must be between $1 and $${user.maxRiskUsd}.`);
      await db.updateRisk(user.telegramId, risk);
      return json(response, 200, { riskUsd: risk });
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
      if (config.DRY_RUN) return json(response, 200, { dryRun: true, status: "validated" });
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
      return json(response, 200, { dryRun: false, status: result.status ?? "pending" });
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
    "/app": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v3.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/app-v4.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/app/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v3.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app/styles-v4.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
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
          "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self' wss://api-stream.myfundedperpetuals.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors https://web.telegram.org https://telegram.org https://*.telegram.org;",
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
