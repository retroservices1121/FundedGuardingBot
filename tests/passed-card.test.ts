import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { isPassedAccount } from "../src/mfp.js";
import { createPassedAccountCard } from "../src/passed-card.js";
import type { ChallengeAccount } from "../src/types.js";

const passed: ChallengeAccount = { id: "eval-123", name: "Select 25K", stage: "evaluation", status: "passed", starting_balance: 25000 };

describe("passed evaluation milestone", () => {
  it("identifies passed evaluations without treating active funded accounts as passed", () => {
    expect(isPassedAccount(passed)).toBe(true);
    expect(isPassedAccount({ ...passed, stage: "funded", status: "active" })).toBe(false);
    expect(isPassedAccount({ ...passed, status: "failed" })).toBe(false);
  });

  it("creates a PNG for a verified passed account and rejects other account states", async () => {
    const image = await createPassedAccountCard(passed, "trader");
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1200);
    await expect(createPassedAccountCard({ ...passed, status: "active" })).rejects.toThrow(/passed evaluation/);
  });
});
