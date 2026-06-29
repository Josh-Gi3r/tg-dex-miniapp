import { createHmac, createHash } from "crypto";
import { ENV } from "./_core/env";

/**
 * Validates Telegram WebApp initData using HMAC-SHA256.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns the parsed user object if valid, throws if invalid.
 */
export function validateTelegramInitData(initData: string): Record<string, unknown> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("Missing hash in initData");

  // Build the data-check string (all fields except hash, sorted alphabetically)
  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // HMAC-SHA256(data-check-string, HMAC-SHA256("WebAppData", bot_token))
  const secretKey = createHmac("sha256", "WebAppData")
    .update(ENV.telegramBotToken)
    .digest();

  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (expectedHash !== hash) {
    throw new Error("Invalid Telegram initData signature");
  }

  // Parse and return the user object
  const userStr = params.get("user");
  if (!userStr) return {};
  try {
    return JSON.parse(userStr) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Checks if the initData is still fresh (within maxAgeSeconds).
 * Telegram recommends rejecting data older than 24h.
 */
export function isTelegramInitDataFresh(
  initData: string,
  maxAgeSeconds = 86400
): boolean {
  const params = new URLSearchParams(initData);
  const authDate = params.get("auth_date");
  if (!authDate) return false;
  const age = Math.floor(Date.now() / 1000) - parseInt(authDate, 10);
  return age >= 0 && age <= maxAgeSeconds;
}

/**
 * Generates a deep-link URL to open the Mini App directly.
 * e.g. https://t.me/your_bot_username/app?startapp=ref_123
 */
export function getMiniAppDeepLink(startParam?: string): string {
  const botUsername = ENV.telegramBotUsername || "your_bot_username";
  const base = `https://t.me/${botUsername}/app`;
  return startParam ? `${base}?startapp=${startParam}` : base;
}

/**
 * Generates a share URL for Telegram (t.me/share/url).
 */
export function getTelegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}
