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
  const logo = await sharp(logoPath).resize(88, 88, { fit: "contain" }).png().toBuffer();
  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f7f9f6"/>
          <stop offset="100%" stop-color="#edf2ed"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="675" fill="url(#wash)"/>
      <rect x="34" y="34" width="1132" height="607" rx="28" fill="#ffffff"/>
      <rect x="34" y="34" width="10" height="607" rx="5" fill="#12d96b"/>

      <rect x="76" y="66" width="88" height="88" rx="20" fill="#070a09"/>
      <text x="190" y="101" fill="#111512" font-family="DejaVu Sans, sans-serif" font-size="25" font-weight="700">Funded Guardian</text>
      <text x="190" y="134" fill="#7b847e" font-family="DejaVu Sans, sans-serif" font-size="17">Closed trade receipt</text>
      <text x="1122" y="102" text-anchor="end" fill="#111512" font-family="DejaVu Sans, sans-serif" font-size="19" font-weight="700">${escapeXml(closedDate(position.closed_at))}</text>
      <text x="1122" y="132" text-anchor="end" fill="#89918c" font-family="DejaVu Sans, sans-serif" font-size="15">MYFUNDEDPERPS</text>
      <line x1="76" y1="181" x2="1122" y2="181" stroke="#e4e8e4" stroke-width="2"/>

      <text x="76" y="240" fill="#8a938d" font-family="DejaVu Sans, sans-serif" font-size="17" font-weight="700" letter-spacing="2">${resultLabel}</text>
      <text x="76" y="338" fill="${accent}" font-family="DejaVu Sans, sans-serif" font-size="86" font-weight="700">${escapeXml(currency(position.realized_pnl))}</text>

      <text x="1122" y="252" text-anchor="end" fill="#111512" font-family="DejaVu Sans, sans-serif" font-size="54" font-weight="700">${symbol}</text>
      <rect x="899" y="278" width="112" height="42" rx="21" fill="${accent}"/>
      <text x="955" y="306" text-anchor="middle" fill="#071009" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700">${direction}</text>
      <text x="1122" y="306" text-anchor="end" fill="#667069" font-family="DejaVu Sans, sans-serif" font-size="18">${escapeXml(position.leverage)}x ${escapeXml(position.margin_mode.toUpperCase())}</text>

      <rect x="76" y="388" width="1046" height="132" rx="18" fill="#f4f6f3"/>
      <line x1="424" y1="412" x2="424" y2="496" stroke="#dce2dc" stroke-width="2"/>
      <line x1="772" y1="412" x2="772" y2="496" stroke="#dce2dc" stroke-width="2"/>
      <text x="108" y="430" fill="#7b847e" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="700">ENTRY PRICE</text>
      <text x="108" y="476" fill="#111512" font-family="DejaVu Sans, sans-serif" font-size="27" font-weight="700">${escapeXml(currency(position.entry_price))}</text>
      <text x="456" y="430" fill="#7b847e" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="700">EXIT PRICE</text>
      <text x="456" y="476" fill="#111512" font-family="DejaVu Sans, sans-serif" font-size="27" font-weight="700">${escapeXml(currency(position.exit_price))}</text>
      <text x="804" y="430" fill="#7b847e" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="700">POSITION SIZE</text>
      <text x="804" y="476" fill="#111512" font-family="DejaVu Sans, sans-serif" font-size="27" font-weight="700">${escapeXml(position.size)} ${symbol}</text>

      <text x="76" y="580" fill="#7b847e" font-family="DejaVu Sans, sans-serif" font-size="17">Fees  <tspan fill="#242a26" font-weight="700">${escapeXml(currency(position.fees))}</tspan></text>
      <text x="300" y="580" fill="#7b847e" font-family="DejaVu Sans, sans-serif" font-size="17">Funding  <tspan fill="#242a26" font-weight="700">${escapeXml(currency(position.funding))}</tspan></text>
      <text x="1122" y="580" text-anchor="end" fill="#7b847e" font-family="DejaVu Sans, sans-serif" font-size="17">Built for disciplined trading</text>
    </svg>`;

  return sharp(Buffer.from(svg))
    .composite([{ input: logo, left: 76, top: 66 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
