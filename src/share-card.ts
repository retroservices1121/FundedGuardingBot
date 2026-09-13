import path from "node:path";
import sharp from "sharp";
import type { Position } from "./types.js";

const WIDTH = 1200;
const HEIGHT = 675;

function escapeXml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

function currency(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function closedDate(timestamp?: number | null) {
  if (!timestamp) return "DATE UNAVAILABLE";
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(milliseconds).toLocaleDateString("en-US", {
    timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
  }).toUpperCase();
}

export function closedPositionCaption(position: Position, botUsername?: string) {
  const symbol = position.symbol || position.coin;
  const direction = position.side.toUpperCase();
  const pnl = currency(position.realized_pnl);
  const bot = botUsername ? `\n\nCreated with @${botUsername}` : "";
  return `${symbol} ${direction} closed · ${pnl} realized P&L${bot}\n\n#FundedGuardian #TradingDiscipline`;
}

export async function createClosedPositionShareCard(position: Position) {
  const pnl = position.realized_pnl ?? 0;
  const positive = pnl >= 0;
  const accent = positive ? "#00f26f" : "#ff4d67";
  const resultLabel = positive ? "PROFIT" : "LOSS";
  const symbol = escapeXml(position.symbol || position.coin);
  const direction = escapeXml(position.side.toUpperCase());
  const logoPath = path.join(process.cwd(), "assets", "funded-guardian-logo.png");
  const logo = await sharp(logoPath).resize(300, 300, { fit: "contain" }).png().toBuffer();
  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="glow" cx="22%" cy="50%" r="58%">
          <stop offset="0%" stop-color="#00f26f" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#00f26f" stop-opacity="0"/>
        </radialGradient>
        <pattern id="grid" width="52" height="52" patternUnits="userSpaceOnUse">
          <path d="M 52 0 L 0 0 0 52" fill="none" stroke="#00f26f" stroke-opacity="0.07" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="1200" height="675" fill="#070a09"/>
      <rect width="1200" height="675" fill="url(#grid)"/>
      <rect width="1200" height="675" fill="url(#glow)"/>
      <rect x="48" y="48" width="1104" height="579" rx="30" fill="#0b100e" stroke="#1f3129" stroke-width="2"/>
      <rect x="72" y="72" width="352" height="531" rx="24" fill="#080c0a" stroke="#153d28" stroke-width="2"/>
      <text x="248" y="520" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="2">FUNDED GUARDIAN</text>
      <text x="248" y="559" text-anchor="middle" fill="#91a59b" font-family="Arial, sans-serif" font-size="17" letter-spacing="3">TRADE WITHIN THE RULES</text>

      <text x="474" y="112" fill="#91a59b" font-family="Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="3">CLOSED POSITION</text>
      <text x="474" y="185" fill="#ffffff" font-family="Arial, sans-serif" font-size="62" font-weight="800">${symbol}</text>
      <rect x="474" y="207" width="126" height="40" rx="20" fill="${accent}" fill-opacity="0.15" stroke="${accent}" stroke-opacity="0.55"/>
      <text x="537" y="234" text-anchor="middle" fill="${accent}" font-family="Arial, sans-serif" font-size="19" font-weight="800">${direction}</text>
      <text x="628" y="234" fill="#91a59b" font-family="Arial, sans-serif" font-size="19">${escapeXml(position.leverage)}× ${escapeXml(position.margin_mode.toUpperCase())}</text>

      <text x="474" y="302" fill="#91a59b" font-family="Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="2">REALIZED ${resultLabel}</text>
      <text x="474" y="382" fill="${accent}" font-family="Arial, sans-serif" font-size="72" font-weight="800">${escapeXml(currency(position.realized_pnl))}</text>

      <line x1="474" y1="422" x2="1096" y2="422" stroke="#26332d" stroke-width="2"/>
      <text x="474" y="466" fill="#789087" font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="2">ENTRY</text>
      <text x="474" y="505" fill="#ffffff" font-family="Arial, sans-serif" font-size="27" font-weight="700">${escapeXml(currency(position.entry_price))}</text>
      <text x="692" y="466" fill="#789087" font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="2">EXIT</text>
      <text x="692" y="505" fill="#ffffff" font-family="Arial, sans-serif" font-size="27" font-weight="700">${escapeXml(currency(position.exit_price))}</text>
      <text x="910" y="466" fill="#789087" font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="2">SIZE</text>
      <text x="910" y="505" fill="#ffffff" font-family="Arial, sans-serif" font-size="27" font-weight="700">${escapeXml(position.size)}</text>

      <text x="474" y="566" fill="#789087" font-family="Arial, sans-serif" font-size="17">Fees ${escapeXml(currency(position.fees))}</text>
      <text x="700" y="566" fill="#789087" font-family="Arial, sans-serif" font-size="17">Funding ${escapeXml(currency(position.funding))}</text>
      <text x="1096" y="566" text-anchor="end" fill="#789087" font-family="Arial, sans-serif" font-size="17">${escapeXml(closedDate(position.closed_at))}</text>
    </svg>`;

  return sharp(Buffer.from(svg))
    .composite([{ input: logo, left: 98, top: 150 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
