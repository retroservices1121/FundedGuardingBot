import { InlineKeyboard } from "grammy";
import type { ChallengeAccount, PositionView, TradeTicket } from "./types.js";
import { accountRisk } from "./risk.js";

export const money = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : "Unavailable";

export function accountMessage(account: ChallengeAccount, environment: string, dryRun: boolean) {
  const risk = accountRisk(account);
  const mode = dryRun ? "DRY RUN" : environment.toUpperCase();
  return [
    `🛡 Funded Guardian · ${mode}`,
    "",
    `${account.name ?? account.id}`,
    `Status: ${account.status ?? "unknown"}`,
    `Equity: ${money(risk.equity)}`,
    `Unrealized P&L: ${money(risk.unrealized_pnl)}`,
    `Available: ${money(risk.available_balance)}`,
    `Exposure: ${money(risk.gross_exposure)}`,
    "",
    `Daily loss room: ${money(risk.daily_loss_room)}`,
    `Max loss room: ${money(risk.max_loss_room)}`,
    `Profit target remaining: ${money(risk.remaining_profit_target)}`,
  ].join("\n");
}

export function tradeKeyboard() {
  return new InlineKeyboard()
    .text("BTC Long", "draft:BTC:buy")
    .text("BTC Short", "draft:BTC:sell")
    .row()
    .text("ETH Long", "draft:ETH:buy")
    .text("ETH Short", "draft:ETH:sell")
    .row()
    .text("SOL Long", "draft:SOL:buy")
    .text("SOL Short", "draft:SOL:sell")
    .row()
    .text("Refresh Status", "status");
}

export function ticketMessage(ticket: TradeTicket, dryRun: boolean) {
  const direction = ticket.side === "buy" ? "LONG" : "SHORT";
  return [
    `${dryRun ? "🧪" : "⚠️"} Confirm ${ticket.symbol} ${direction}`,
    "",
    `Risk at stop: ${money(ticket.riskUsd)}`,
    `Size: ${ticket.size}`,
    `Estimated entry: ${money(ticket.expectedPrice)}`,
    `Stop loss: ${money(ticket.stopLossPrice)}`,
    `Take profit: ${money(ticket.takeProfitPrice)}`,
    `Estimated notional: ${money(ticket.estimatedNotional)}`,
    `Estimated entry fee: ${money(ticket.estimatedFee)}`,
    "",
    `This quote expires shortly. ${dryRun ? "No order will be sent." : "Tap once to submit the protected order."}`,
  ].join("\n");
}

export function positionsMessage(positions: PositionView[]) {
  if (!positions.length) return "📭 No open positions on the selected account.";
  const visible = positions.slice(0, 10);
  const sections = visible.map((position) => {
    const direction = position.side === "long" ? "🟢 LONG" : "🔴 SHORT";
    return [
      `${direction} · ${position.symbol || position.coin}`,
      `Size: ${position.size} · ${position.leverage}× ${position.margin_mode}`,
      `Entry: ${money(position.entry_price)}`,
      `Current mark: ${money(position.markPrice)}`,
      `Estimated unrealized P&L: ${money(position.estimatedUnrealizedPnl)}`,
      `Liquidation: ${money(position.liquidation_price)}`,
    ].join("\n");
  });
  const footer = positions.length > visible.length ? `\n\nShowing 10 of ${positions.length} positions.` : "";
  return `📈 Open Positions (${positions.length})\n\n${sections.join("\n\n")}${footer}`;
}
