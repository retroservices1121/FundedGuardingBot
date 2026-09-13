import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { closedPositionCaption, createClosedPositionShareCard } from "../src/share-card.js";

const position = {
  id: "p1", account_id: "a1", market_id: "binance|BTCUSDT", provider: "binance",
  symbol: "BTC", coin: "BTCUSDT", side: "long" as const, size: 0.06466, entry_price: 77_327,
  leverage: 2, margin_mode: "cross" as const, isolated_margin_extra: 0, status: "closed" as const,
  opened_at: 1, closed_at: 1_757_721_600_000, exit_price: 78_022.94, realized_pnl: 45,
  fees: 2.96, funding: -0.15,
};

describe("closed position share card", () => {
  it("renders a social-ready PNG", async () => {
    const card = await createClosedPositionShareCard(position);
    const metadata = await sharp(card).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(675);
  });

  it("creates a ready-to-copy caption", () => {
    const caption = closedPositionCaption(position, "FundedGuardianBot");
    expect(caption).toContain("BTC LONG closed");
    expect(caption).toContain("$45.00");
    expect(caption).toContain("@FundedGuardianBot");
  });
});
