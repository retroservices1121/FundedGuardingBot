import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTelegramInitData } from "../src/telegram-auth.js";

const token = "123456:telegram-test-token";

function signedInitData(user = { id: 42, first_name: "Ada", username: "guardian" }) {
  const values = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "test-query",
    user: JSON.stringify(user),
  });
  const checkString = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  values.set("hash", createHmac("sha256", secret).update(checkString).digest("hex"));
  return values.toString();
}

describe("Telegram Mini App authentication", () => {
  it("accepts authentic Telegram init data", () => {
    expect(validateTelegramInitData(signedInitData(), token)).toMatchObject({
      id: 42,
      first_name: "Ada",
      username: "guardian",
    });
  });

  it("rejects a modified Telegram identity", () => {
    const values = new URLSearchParams(signedInitData());
    values.set("user", JSON.stringify({ id: 99, first_name: "Mallory" }));
    expect(() => validateTelegramInitData(values.toString(), token)).toThrow("invalid");
  });
});
