import path from "node:path";
import sharp from "sharp";
import type { Position } from "./types.js";

const WIDTH = 1200;
const HEIGHT = 675;
const FONT = "DejaVu Sans, sans-serif";

const ASSET_NAMES: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP",
  DOGE: "Dogecoin", BNB: "BNB", ADA: "Cardano", AVAX: "Avalanche",
  LINK: "Chainlink", LTC: "Litecoin",
};

function escapeXml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

function currency(value?: number | null, showPlus = false) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "N/A";
  const formatted = Math.abs(value).toLocaleString("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  if (value < 0) return `-${formatted}`;
  return showPlus ? `+${formatted}` : formatted;
}

function normalizedTimestamp(timestamp?: number | null) {
  if (!timestamp) return 0;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function duration(openedAt?: number | null, closedAt?: number | null) {
  const seconds = Math.max(0, Math.round((normalizedTimestamp(closedAt) - normalizedTimestamp(openedAt)) / 1000));
  if (!seconds || !Number.isFinite(seconds)) return "N/A";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}H ${minutes}M` : `${minutes}M ${remainder}S`;
}

function returnPercent(position: Position) {
  if (!position.entry_price || !position.exit_price) return "N/A";
  const direction = position.side === "long" ? 1 : -1;
  const result = ((position.exit_price - position.entry_price) / position.entry_price)
    * direction * Math.max(position.leverage || 1, 1) * 100;
  return `${result >= 0 ? "+" : ""}${result.toFixed(2)}%`;
}

function cleanSymbol(position: Position) {
  return (position.symbol || position.coin || "PERP")
    .toUpperCase()
    .replace(/[-_/]?(USDT|USDC|USD|PERP)$/i, "");
}

export function closedPositionCaption(position: Position, botUsername?: string) {
  const symbol = cleanSymbol(position);
  const direction = position.side.toUpperCase();
  const pnl = currency(position.realized_pnl, true);
  const bot = botUsername ? `\n\nCreated with @${botUsername}` : "";
  return `${symbol} ${direction} closed · ${pnl} realized P&L${bot}\n\n#FundedGuardian #TradingDiscipline`;
}

export async function createClosedPositionShareCard(position: Position, botUsername?: string) {
  const pnl = position.realized_pnl ?? 0;
  const positive = pnl >= 0;
  const accent = positive ? "#35d39a" : "#ff5572";
  const symbol = cleanSymbol(position);
  const assetName = ASSET_NAMES[symbol] ?? symbol;
  const direction = position.side.toUpperCase();
  const username = escapeXml(botUsername ? `@${botUsername.replace(/^@/, "")}` : "@FundedGuardianBot");
  const logoPath = path.join(process.cwd(), "assets", "funded-guardian-logo.png");
  const logo = await sharp(logoPath).resize(58, 58, { fit: "contain" }).png().toBuffer();

  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#080b0a"/>
          <stop offset="100%" stop-color="#030504"/>
        </linearGradient>
        <linearGradient id="ribbon" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#111815"/>
          <stop offset="48%" stop-color="#315345"/>
          <stop offset="55%" stop-color="#0d1411"/>
          <stop offset="100%" stop-color="#030504"/>
        </linearGradient>
        <radialGradient id="halo" cx="72%" cy="48%" r="58%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.13"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="rightClip"><rect x="700" width="500" height="675"/></clipPath>
      </defs>

      <rect width="1200" height="675" fill="url(#panel)"/>
      <rect width="1200" height="675" fill="url(#halo)"/>

      <g clip-path="url(#rightClip)" fill="none" stroke-linecap="round">
        <path d="M1190 -90 C860 60 840 190 1145 300 C1360 378 1250 570 820 760" stroke="url(#ribbon)" stroke-width="130"/>
        <path d="M1190 -90 C860 60 840 190 1145 300 C1360 378 1250 570 820 760" stroke="${accent}" stroke-opacity="0.27" stroke-width="3"/>
        <path d="M860 -80 C1110 80 1112 190 850 310 C660 398 770 545 1110 720" stroke="url(#ribbon)" stroke-width="94"/>
        <path d="M860 -80 C1110 80 1112 190 850 310 C660 398 770 545 1110 720" stroke="${accent}" stroke-opacity="0.2" stroke-width="3"/>
      </g>

      <rect x="42" y="34" width="58" height="58" rx="14" fill="#050807"/>
      <text x="118" y="72" fill="#ffffff" font-family="${FONT}" font-size="25" font-weight="700">Funded Guardian</text>

      <rect x="1010" y="35" width="148" height="50" rx="25" fill="#111513" stroke="#2d332f" stroke-width="2"/>
      <text x="1084" y="67" text-anchor="middle" fill="#d4d8d5" font-family="${FONT}" font-size="18" font-weight="700">${escapeXml(direction)} ${escapeXml(position.leverage)}x</text>

      <text x="42" y="196" fill="#ffffff" font-family="${FONT}" font-size="56" font-weight="700">${escapeXml(assetName)}</text>
      <text x="42" y="235" fill="#808783" font-family="${FONT}" font-size="24" font-weight="700">$${escapeXml(symbol)}</text>

      <rect x="42" y="267" width="610" height="140" fill="${accent}"/>
      <text x="74" y="365" fill="#030504" font-family="${FONT}" font-size="82" font-weight="700">${escapeXml(currency(position.realized_pnl, true))}</text>

      <text x="42" y="468" fill="#777e7a" font-family="${FONT}" font-size="18" font-weight="700">RETURN</text>
      <text x="420" y="468" text-anchor="end" fill="${accent}" font-family="${FONT}" font-size="20" font-weight="700">${escapeXml(returnPercent(position))}</text>
      <text x="42" y="506" fill="#777e7a" font-family="${FONT}" font-size="18" font-weight="700">ENTRY</text>
      <text x="420" y="506" text-anchor="end" fill="#ffffff" font-family="${FONT}" font-size="20" font-weight="700">${escapeXml(currency(position.entry_price))}</text>
      <text x="42" y="544" fill="#777e7a" font-family="${FONT}" font-size="18" font-weight="700">EXIT</text>
      <text x="420" y="544" text-anchor="end" fill="#ffffff" font-family="${FONT}" font-size="20" font-weight="700">${escapeXml(currency(position.exit_price))}</text>
      <text x="42" y="582" fill="#777e7a" font-family="${FONT}" font-size="18" font-weight="700">DURATION</text>
      <text x="420" y="582" text-anchor="end" fill="#ffffff" font-family="${FONT}" font-size="20" font-weight="700">${escapeXml(duration(position.opened_at, position.closed_at))}</text>

      <circle cx="70" cy="629" r="24" fill="#101512" stroke="${accent}" stroke-width="2"/>
      <text x="70" y="637" text-anchor="middle" fill="${accent}" font-family="${FONT}" font-size="21" font-weight="700">FG</text>
      <text x="108" y="625" fill="#ffffff" font-family="${FONT}" font-size="21" font-weight="700">${username}</text>
      <text x="108" y="649" fill="#757c78" font-family="${FONT}" font-size="14">Trade within the rules.</text>

      <text x="1158" y="630" text-anchor="end" fill="#68706b" font-family="${FONT}" font-size="14">Fees ${escapeXml(currency(position.fees))}  ·  Funding ${escapeXml(currency(position.funding))}</text>
    </svg>`;

  return sharp(Buffer.from(svg))
    .composite([{ input: logo, left: 42, top: 34 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
