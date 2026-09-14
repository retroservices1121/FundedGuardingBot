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
        <linearGradient id="shieldStroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.72"/>
          <stop offset="55%" stop-color="#315345" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0.12"/>
        </linearGradient>
        <radialGradient id="halo" cx="72%" cy="48%" r="58%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.13"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <rect width="1200" height="675" fill="url(#panel)"/>
      <rect width="1200" height="675" fill="url(#halo)"/>

      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M930 112 L1100 171 V326 C1100 452 1031 544 930 595 C829 544 760 452 760 326 V171 Z" fill="#0b110e" fill-opacity="0.66" stroke="url(#shieldStroke)" stroke-width="11"/>
        <path d="M930 148 L1065 195 V323 C1065 421 1014 494 930 541 C846 494 795 421 795 323 V195 Z" stroke="#293b33" stroke-width="2"/>

        <rect x="834" y="382" width="42" height="85" rx="5" fill="${accent}" fill-opacity="0.22" stroke="${accent}" stroke-opacity="0.38" stroke-width="2"/>
        <rect x="900" y="330" width="42" height="137" rx="5" fill="${accent}" fill-opacity="0.36" stroke="${accent}" stroke-opacity="0.52" stroke-width="2"/>
        <rect x="966" y="263" width="42" height="204" rx="5" fill="${accent}" fill-opacity="0.58" stroke="${accent}" stroke-opacity="0.72" stroke-width="2"/>
        <path d="M828 349 L900 294 L951 311 L1034 231" stroke="${accent}" stroke-width="7"/>
        <path d="M1004 230 L1035 230 L1035 261" stroke="${accent}" stroke-width="7"/>

        <circle cx="930" cy="205" r="10" fill="${accent}" stroke="none"/>
        <path d="M930 215 V238" stroke="${accent}" stroke-width="5"/>
        <path d="M807 228 H776 M1084 228 H1053" stroke="${accent}" stroke-opacity="0.45" stroke-width="4"/>
        <circle cx="776" cy="228" r="6" fill="${accent}" fill-opacity="0.55" stroke="none"/>
        <circle cx="1084" cy="228" r="6" fill="${accent}" fill-opacity="0.55" stroke="none"/>
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
