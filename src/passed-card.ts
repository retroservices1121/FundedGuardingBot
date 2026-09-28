import path from "node:path";
import sharp from "sharp";
import type { ChallengeAccount } from "./types.js";
import { isPassedAccount } from "./mfp.js";

const escapeXml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[char]!);

export async function createPassedAccountCard(account: ChallengeAccount, username?: string) {
  if (!isPassedAccount(account)) throw new Error("A passed evaluation is required to create this card.");
  const logo = await sharp(path.join(process.cwd(), "assets", "funded-guardian-logo.png"))
    .resize(76, 76, { fit: "contain" }).png().toBuffer();
  const accountSize = typeof account.starting_balance === "number" && Number.isFinite(account.starting_balance)
    ? account.starting_balance.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "Challenge account";
  const display = username ? `@${username.replace(/^@/, "")}` : "Guardian trader";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#101d17"/><stop offset="1" stop-color="#050a07"/></linearGradient></defs>
    <rect width="1200" height="675" fill="url(#bg)"/>
    <path d="M0 0h1200v9H0z" fill="#31d394"/>
    <path d="M788 0L1200 412V0ZM1010 675L1200 485v190Z" fill="#31d394" opacity=".06"/>
    <path d="M835 173h250v250H835z" fill="none" stroke="#31d394" stroke-opacity=".25" stroke-width="2" transform="rotate(45 960 298)"/>
    <path d="M863 201h194v194H863z" fill="none" stroke="#31d394" stroke-opacity=".17" stroke-width="2" transform="rotate(45 960 298)"/>
    <g fill="#f4f7f5" font-family="DejaVu Sans, sans-serif">
      <text x="140" y="97" font-size="29" font-weight="bold">FUNDED GUARDIAN</text>
      <text x="88" y="218" fill="#31d394" font-size="22" font-weight="bold" letter-spacing="5">CHALLENGE MILESTONE</text>
      <text x="84" y="328" font-size="72" font-weight="bold">Evaluation</text>
      <text x="84" y="417" font-size="80" font-weight="bold">passed.</text>
      <text x="88" y="483" font-size="27" fill="#b0bfb5">${escapeXml(display.slice(0, 32))}</text>
      <text x="88" y="539" font-size="24" fill="#31d394">${escapeXml(accountSize)}</text>
      <text x="88" y="625" fill="#8e9d94" font-size="18">Guardian celebration card  |  Official certificate: MyFundedPerps</text>
    </g>
    <path d="M84 568H1114" stroke="#314b3b" stroke-width="2"/>
  </svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: logo, top: 42, left: 45 }]).png().toBuffer();
}
