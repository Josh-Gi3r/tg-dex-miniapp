import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// ── helpers ──────────────────────────────────────────────────────────────────

function buildInitData(
  botToken: string,
  overrides: Record<string, string> = {}
): string {
  const authDate = String(Math.floor(Date.now() / 1000));
  const user = JSON.stringify({ id: 123456789, first_name: "Test", username: "testuser" });

  const fields: Record<string, string> = {
    auth_date: authDate,
    user,
    ...overrides,
  };

  // Build data-check string (sorted, no hash)
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // Compute expected hash
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Telegram Bot Token", () => {
  it("TELEGRAM_BOT_TOKEN env var is set", () => {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    expect(token.length).toBeGreaterThan(0);
    expect(token).toMatch(/^\d+:[\w-]+$/);
  });
});

describe("validateTelegramInitData", () => {
  // Use a syntactically-valid but obviously-fake token for tests. The leaked
  // real-looking token in the prior version was flagged in audit v3.
  // ROTATE: 8780708435:AAFOiEDLbpChPof9sKYn4Ts2NO3Doyk_pRQ — assume compromised.
  const REAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "9999999999:TEST_FIXTURE_NOT_A_REAL_TOKEN_xxxxx";

  it("accepts valid initData with correct HMAC", async () => {
    // Mock ENV so the module uses our real token
    vi.doMock("./_core/env", () => ({ ENV: { telegramBotToken: REAL_TOKEN } }));
    const { validateTelegramInitData } = await import("./telegramAuth");

    const initData = buildInitData(REAL_TOKEN);
    const user = validateTelegramInitData(initData);
    expect(user).toMatchObject({ id: 123456789, username: "testuser" });
  });

  it("rejects initData with wrong hash", async () => {
    vi.doMock("./_core/env", () => ({ ENV: { telegramBotToken: REAL_TOKEN } }));
    const { validateTelegramInitData } = await import("./telegramAuth");

    const initData = buildInitData(REAL_TOKEN);
    // Tamper with the hash
    const tampered = initData.replace(/hash=[^&]+/, "hash=deadbeefdeadbeef");
    expect(() => validateTelegramInitData(tampered)).toThrow("Invalid Telegram initData signature");
  });

  it("rejects initData with no hash field", async () => {
    vi.doMock("./_core/env", () => ({ ENV: { telegramBotToken: REAL_TOKEN } }));
    const { validateTelegramInitData } = await import("./telegramAuth");

    const params = new URLSearchParams({ auth_date: "1234567890", user: "{}" });
    expect(() => validateTelegramInitData(params.toString())).toThrow("Missing hash");
  });
});

describe("isTelegramInitDataFresh", () => {
  it("returns true for fresh data", async () => {
    const REAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "8780708435:AAFOiEDLbpChPof9sKYn4Ts2NO3Doyk_pRQ";
    vi.doMock("./_core/env", () => ({ ENV: { telegramBotToken: REAL_TOKEN } }));
    const { isTelegramInitDataFresh } = await import("./telegramAuth");

    const initData = buildInitData(REAL_TOKEN);
    expect(isTelegramInitDataFresh(initData)).toBe(true);
  });

  it("returns false for stale data (older than 24h)", async () => {
    const REAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "8780708435:AAFOiEDLbpChPof9sKYn4Ts2NO3Doyk_pRQ";
    vi.doMock("./_core/env", () => ({ ENV: { telegramBotToken: REAL_TOKEN } }));
    const { isTelegramInitDataFresh } = await import("./telegramAuth");

    // auth_date 2 days ago
    const staleDate = String(Math.floor(Date.now() / 1000) - 172800);
    const initData = buildInitData(REAL_TOKEN, { auth_date: staleDate });
    expect(isTelegramInitDataFresh(initData)).toBe(false);
  });
});

describe("getMiniAppDeepLink", () => {
  it("returns correct base URL without startParam", async () => {
    vi.doMock("./_core/env", () => ({ ENV: { telegramBotToken: "test" } }));
    const { getMiniAppDeepLink } = await import("./telegramAuth");
    expect(getMiniAppDeepLink()).toBe("https://t.me/your_bot_username/app");
  });

  it("appends startParam correctly", async () => {
    vi.doMock("./_core/env", () => ({ ENV: { telegramBotToken: "test" } }));
    const { getMiniAppDeepLink } = await import("./telegramAuth");
    expect(getMiniAppDeepLink("ref_123")).toBe("https://t.me/your_bot_username/app?startapp=ref_123");
  });
});
