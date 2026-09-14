import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import WebSocket from "ws";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

const STREAM_URL = "wss://api-stream.myfundedperpetuals.com/v1/market-data";
const DISCLAIMER = "Market information only — not financial advice.";

type Tick = { price: number; time: number };
type Candle = { closeTime: number; volume: number };
type Snapshot = { price?: number; change24hPct?: number; volume24h?: number; fundingRate?: number };

export function percentMove(first: number, last: number) {
  return first > 0 && Number.isFinite(last) ? ((last - first) / first) * 100 : 0;
}

export function spreadBps(bid: number, ask: number) {
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 && ask >= bid ? ((ask - bid) / midpoint) * 10_000 : 0;
}

export function volumeMultiple(latest: number, history: number[]) {
  const usable = history.filter((value) => Number.isFinite(value) && value > 0);
  if (!Number.isFinite(latest) || latest <= 0 || usable.length === 0) return 0;
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  return average > 0 ? latest / average : 0;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestamp(value: unknown) {
  const parsed = number(value);
  if (!parsed) return Date.now();
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function baseSymbol(symbol: string) {
  return symbol.replace(/(?:USDT|USDC|USD)$/i, "");
}

function money(value: number) {
  const digits = value >= 1000 ? 2 : value >= 1 ? 3 : 5;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

function signedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function extractEvents(frame: unknown): Record<string, unknown>[] {
  if (!frame || typeof frame !== "object") return [];
  const record = frame as Record<string, unknown>;
  const candidates = [record.data, record.payload, record.event, record.events];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    if (candidate && typeof candidate === "object") return [candidate as Record<string, unknown>];
  }
  return [record];
}

function eventType(frame: Record<string, unknown>, event: Record<string, unknown>) {
  return String(event.type ?? event.channel ?? event.kind ?? frame.channel ?? frame.type ?? "").toLowerCase();
}

function eventSymbol(event: Record<string, unknown>) {
  return String(event.symbol ?? event.s ?? "").toUpperCase();
}

function firstLevel(value: unknown): { price?: number; size?: number } {
  if (!Array.isArray(value) || !value[0]) return {};
  const level = value[0] as unknown;
  if (Array.isArray(level)) return { price: number(level[0]), size: number(level[1]) };
  if (typeof level === "object") {
    const row = level as Record<string, unknown>;
    return { price: number(row.px ?? row.price), size: number(row.sz ?? row.size) };
  }
  return {};
}

function nyClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

function openButton(botUsername: string, symbol?: string, sourceUrl?: string, sourceName?: string): InlineKeyboardMarkup {
  const payload = symbol ? `?start=pulse_${baseSymbol(symbol)}` : "";
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (sourceUrl) rows.push([{ text: `Read at ${sourceName || "source"}`, url: sourceUrl }]);
  rows.push([{ text: symbol ? `Open ${baseSymbol(symbol)} in Guardian` : "Open Funded Guardian", url: `https://t.me/${botUsername}${payload}` }]);
  return { inline_keyboard: rows };
}

export function startPulseChannel(config: Config, db: Database, telegram: Api, botUsername: string) {
  if (!config.PULSE_CHANNEL_ID) {
    console.log("Funded Guardian Pulse is disabled (PULSE_CHANNEL_ID is not set).");
    return;
  }

  const channelId = config.PULSE_CHANNEL_ID;
  const ticks = new Map<string, Tick[]>();
  const candles = new Map<string, Candle[]>();
  const snapshots = new Map<string, Snapshot>();
  let stopped = false;
  let reconnectDelay = 1_000;
  let socket: WebSocket | undefined;

  const cooldownBucket = () => Math.floor(Date.now() / (config.PULSE_ALERT_COOLDOWN_MINUTES * 60_000));

  async function publish(key: string, text: string, symbol?: string, sourceUrl?: string, sourceName?: string) {
    if (!await db.claimPulsePublication(key)) return;
    try {
      await telegram.sendMessage(channelId, text, { reply_markup: openButton(botUsername, symbol, sourceUrl, sourceName), link_preview_options: { is_disabled: true } });
    } catch (error) {
      await db.releasePulsePublication(key);
      console.error("Pulse publication failed:", error);
    }
  }

  async function handleTick(event: Record<string, unknown>) {
    const symbol = eventSymbol(event);
    const price = number(event.price ?? event.p);
    const time = timestamp(event.time ?? event.ts ?? event.timestamp);
    if (!symbol || !price || Date.now() - time > 60_000) return;
    const cutoff = time - config.PULSE_MOVE_WINDOW_MINUTES * 60_000;
    const series = [...(ticks.get(symbol) ?? []), { price, time }].filter((point) => point.time >= cutoff);
    ticks.set(symbol, series);
    snapshots.set(symbol, { ...snapshots.get(symbol), price });
    const first = series[0];
    if (!first || time - first.time < config.PULSE_MOVE_WINDOW_MINUTES * 60_000 * 0.8) return;
    const move = percentMove(first.price, price);
    if (Math.abs(move) < config.PULSE_MOVE_PERCENT) return;
    const direction = move > 0 ? "up" : "down";
    await publish(
      `move:${symbol}:${direction}:${cooldownBucket()}`,
      `⚡ ${baseSymbol(symbol)} market move\n\n${baseSymbol(symbol)} moved ${signedPercent(move)} in about ${config.PULSE_MOVE_WINDOW_MINUTES} minutes.\nCurrent price: ${money(price)}\n\nFast markets can change challenge loss room quickly. Review your exposure and protective orders before acting.\n\n${DISCLAIMER}`,
      symbol,
    );
  }

  async function handleBook(event: Record<string, unknown>) {
    const symbol = eventSymbol(event);
    const bid = firstLevel(event.bids).price;
    const ask = firstLevel(event.asks).price;
    if (!symbol || !bid || !ask) return;
    const spread = spreadBps(bid, ask);
    if (spread < config.PULSE_SPREAD_BPS) return;
    await publish(
      `spread:${symbol}:${cooldownBucket()}`,
      `⚠️ ${baseSymbol(symbol)} spread widened\n\nBest bid: ${money(bid)}\nBest ask: ${money(ask)}\nSpread: ${spread.toFixed(1)} bps\n\nMarket orders may receive wider fills while the spread is elevated.\n\n${DISCLAIMER}`,
      symbol,
    );
  }

  async function handleCandle(event: Record<string, unknown>) {
    const symbol = eventSymbol(event);
    const explicitCloseTime = event.closeTime ?? event.close_time;
    const openTime = timestamp(event.openTime ?? event.open_time ?? event.time ?? event.ts);
    const closeTime = explicitCloseTime === undefined ? openTime + 60_000 : timestamp(explicitCloseTime);
    const volume = number(event.quoteVolume ?? event.quote_volume ?? event.volume ?? event.v);
    const isFinal = event.isFinal ?? event.final ?? event.closed;
    if (!symbol || !volume || isFinal === false || Date.now() - closeTime > 2 * 60 * 60_000) return;
    const history = candles.get(symbol) ?? [];
    if (history.some((bar) => bar.closeTime === closeTime)) return;
    const baseline = history.slice(-20).map((bar) => bar.volume);
    const multiple = volumeMultiple(volume, baseline);
    candles.set(symbol, [...history, { closeTime, volume }].slice(-30));
    if (closeTime > Date.now() + 5_000 || Date.now() - closeTime > 120_000 || baseline.length < 10 || multiple < config.PULSE_VOLUME_MULTIPLIER) return;
    await publish(
      `volume:${symbol}:${cooldownBucket()}`,
      `📊 ${baseSymbol(symbol)} volume spike\n\nThe latest 1-minute volume was ${multiple.toFixed(1)}× its recent 20-minute average.\n${snapshots.get(symbol)?.price ? `Current price: ${money(snapshots.get(symbol)!.price!)}\n` : ""}\nHigh volume can accompany faster price changes and slippage.\n\n${DISCLAIMER}`,
      symbol,
    );
  }

  function handleStats(event: Record<string, unknown>) {
    const symbol = eventSymbol(event);
    if (!symbol) return;
    snapshots.set(symbol, {
      ...snapshots.get(symbol),
      price: number(event.price ?? event.markPrice ?? event.mark_price) ?? snapshots.get(symbol)?.price,
      change24hPct: number(event.change24hPct ?? event.change_24h_pct) ?? snapshots.get(symbol)?.change24hPct,
      volume24h: number(event.dayNtlVlm ?? event.volume24h ?? event.volume_24h) ?? snapshots.get(symbol)?.volume24h,
      fundingRate: number(event.fundingRate ?? event.funding_rate) ?? snapshots.get(symbol)?.fundingRate,
    });
  }

  function onMessage(raw: WebSocket.RawData) {
    try {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      for (const wrapper of extractEvents(frame)) {
        const nested = (wrapper.tick ?? wrapper.book ?? wrapper.candle ?? wrapper.marketStats ?? wrapper.stats) as unknown;
        const event = nested && typeof nested === "object" ? nested as Record<string, unknown> : wrapper;
        const type = wrapper.tick ? "tick" : wrapper.book ? "book" : wrapper.candle ? "candle" : wrapper.marketStats || wrapper.stats ? "marketstats" : eventType(frame, event);
        if (type.includes("tick") || (event.price !== undefined && event.kind !== undefined)) void handleTick(event);
        else if (type.includes("book") || event.bids !== undefined) void handleBook(event);
        else if (type.includes("candle") || event.open !== undefined) void handleCandle(event);
        else if (type.includes("stat") || event.change24hPct !== undefined) handleStats(event);
      }
    } catch (error) {
      console.warn("Pulse ignored an unreadable market-stream frame:", error);
    }
  }

  function connect() {
    if (stopped) return;
    socket = new WebSocket(STREAM_URL);
    socket.on("open", () => {
      reconnectDelay = 1_000;
      const common = { symbols: config.PULSE_SYMBOLS, providers: [config.PULSE_PROVIDER] };
      socket?.send(JSON.stringify({ op: "sub", id: 1, channel: "ticks", payload: common }));
      socket?.send(JSON.stringify({ op: "sub", id: 2, channel: "books", payload: common }));
      socket?.send(JSON.stringify({ op: "sub", id: 3, channel: "marketStats", payload: common }));
      socket?.send(JSON.stringify({ op: "sub", id: 4, channel: "candles", payload: { ...common, intervals: ["1m"], historyLimit: 30 } }));
      console.log(`Funded Guardian Pulse connected for ${config.PULSE_SYMBOLS.join(", ")}.`);
    });
    socket.on("message", onMessage);
    socket.on("error", (error) => console.warn("Pulse market stream error:", error.message));
    socket.on("close", () => {
      if (stopped) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      setTimeout(connect, delay).unref();
    });
  }


  async function pollNews() {
    if (!config.CRYPTOPANIC_TOKEN) return;
    try {
      const url = new URL(config.CRYPTOPANIC_API_URL);
      url.searchParams.set("auth_token", config.CRYPTOPANIC_TOKEN);
      url.searchParams.set("public", "true");
      url.searchParams.set("kind", "news");
      url.searchParams.set("regions", "en");
      url.searchParams.set("currencies", config.PULSE_SYMBOLS.map(baseSymbol).join(","));
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) {
        console.warn(`CryptoPanic returned HTTP ${response.status}; Pulse will try again later.`);
        return;
      }
      const payload = await response.json() as Record<string, unknown>;
      const rawResults = Array.isArray(payload.results)
        ? payload.results
        : payload.data && typeof payload.data === "object" && Array.isArray((payload.data as Record<string, unknown>).results)
          ? (payload.data as Record<string, unknown>).results as unknown[]
          : [];
      for (const raw of rawResults) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const title = String(item.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        const publishedAt = Date.parse(String(item.published_at ?? item.publishedAt ?? item.created_at ?? ""));
        if (!title || !Number.isFinite(publishedAt) || Date.now() - publishedAt > config.PULSE_NEWS_MAX_AGE_MINUTES * 60_000 || publishedAt > Date.now() + 60_000) continue;

        const source = item.source && typeof item.source === "object" ? item.source as Record<string, unknown> : {};
        const sourceName = String(source.title ?? source.name ?? source.domain ?? "original source").trim();
        const candidateUrl = String(item.original_url ?? item.originalUrl ?? item.url ?? "");
        let articleUrl: URL;
        try { articleUrl = new URL(candidateUrl); } catch { continue; }
        if (!["http:", "https:"].includes(articleUrl.protocol)) continue;
        const sourceDomain = String(source.domain ?? articleUrl.hostname).toLowerCase().replace(/^www\./, "");
        if (!config.PULSE_NEWS_SOURCES.some((allowed) => sourceDomain === allowed || sourceDomain.endsWith(`.${allowed}`))) continue;

        const currencyRows = Array.isArray(item.currencies) ? item.currencies : [];
        const tagged = currencyRows.map((currency) => typeof currency === "object" && currency
          ? String((currency as Record<string, unknown>).code ?? (currency as Record<string, unknown>).symbol ?? "").toUpperCase()
          : String(currency).toUpperCase());
        const candidates = config.PULSE_SYMBOLS.filter((symbol) => tagged.includes(baseSymbol(symbol)) || new RegExp(`\\b${baseSymbol(symbol)}\\b`, "i").test(title));
        const moves = candidates.map((symbol) => {
          const series = ticks.get(symbol) ?? [];
          const first = series[0];
          const last = series.at(-1);
          return first && last ? { symbol, move: percentMove(first.price, last.price), price: last.price } : undefined;
        }).filter((value): value is { symbol: string; move: number; price: number } => !!value);
        moves.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
        const market = moves[0];
        if (!market || Math.abs(market.move) < config.PULSE_NEWS_MOVE_PERCENT) continue;

        const identity = String(item.id ?? candidateUrl).slice(0, 180);
        const ageMinutes = Math.max(0, Math.round((Date.now() - publishedAt) / 60_000));
        await publish(
          `news:${identity}`,
          `📰 Possible ${baseSymbol(market.symbol)} catalyst\n\n${title}\n\nSource: ${sourceName} · published ${ageMinutes || "<1"}m ago\n${baseSymbol(market.symbol)} move: ${signedPercent(market.move)} over roughly ${config.PULSE_MOVE_WINDOW_MINUTES} minutes\nCurrent price: ${money(market.price)}\n\nThe timing overlaps with the market move, but does not prove the story caused it.\n\n${DISCLAIMER}`,
          market.symbol,
          articleUrl.toString(),
          sourceName,
        );
      }
    } catch (error) {
      console.warn("CryptoPanic news poll failed; Pulse will try again later.", error);
    }
  }

  async function publishBrief() {
    const clock = nyClock();
    if (clock.hour !== config.PULSE_BRIEF_HOUR_ET) return;
    const rows = config.PULSE_SYMBOLS.map((symbol) => {
      const snapshot = snapshots.get(symbol);
      if (!snapshot?.price) return undefined;
      const change = snapshot.change24hPct === undefined ? "24h —" : `24h ${signedPercent(snapshot.change24hPct)}`;
      return `${baseSymbol(symbol)}  ${money(snapshot.price)}  ·  ${change}`;
    }).filter(Boolean);
    if (rows.length === 0) return;
    await publish(
      `brief:${clock.date}`,
      `🛡 Funded Guardian daily brief\n\n${rows.join("\n")}\n\nBefore trading: check the day’s scheduled events, your remaining loss room, and whether every position has protection.\n\n${DISCLAIMER}`,
    );
  }

  void telegram.getChat(channelId).then((chat) => console.log(`Pulse channel ready: ${"title" in chat ? chat.title : channelId}`)).catch((error) => console.warn("Pulse channel check failed. Make the bot a channel admin with Post Messages permission.", error));
  connect();
  const briefTimer = setInterval(() => void publishBrief(), 60_000);
  briefTimer.unref();
  setTimeout(() => void publishBrief(), 15_000).unref();
  const newsTimer = config.CRYPTOPANIC_TOKEN ? setInterval(() => void pollNews(), config.PULSE_NEWS_POLL_MINUTES * 60_000) : undefined;
  newsTimer?.unref();
  if (config.CRYPTOPANIC_TOKEN) setTimeout(() => void pollNews(), 30_000).unref();
  else console.log("Pulse news catalysts are disabled (CRYPTOPANIC_TOKEN is not set).");

  return () => {
    stopped = true;
    clearInterval(briefTimer);
    if (newsTimer) clearInterval(newsTimer);
    socket?.close();
  };
}
