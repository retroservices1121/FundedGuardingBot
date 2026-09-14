import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramMiniAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export function validateTelegramInitData(initData: string, botToken: string, maxAgeSeconds = 3600) {
  const values = new URLSearchParams(initData);
  const suppliedHash = values.get("hash");
  const authDate = Number(values.get("auth_date"));
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) throw new Error("Telegram authentication is missing.");
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) {
    throw new Error("Telegram authentication expired. Reopen the Mini App.");
  }

  values.delete("hash");
  const checkString = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  const supplied = Buffer.from(suppliedHash, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Telegram authentication is invalid.");
  }

  const encodedUser = values.get("user");
  if (!encodedUser) throw new Error("Telegram user information is unavailable.");
  const user = JSON.parse(encodedUser) as TelegramMiniAppUser;
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("Telegram user information is invalid.");
  return user;
}
