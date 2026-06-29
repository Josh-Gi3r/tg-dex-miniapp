/**
 * ─── Telegram Bot Helper ─────────────────────────────────────────────────────
 *
 * Provides:
 *   - sendMessage(chatId, text, options?) — send a text message to a user
 *   - sendOrderNotification(chatId, text, inlineButtons?) — send with inline keyboard
 *   - registerWebhook(webhookUrl) — register the bot webhook with Telegram
 *   - handleWebhookUpdate(update, db) — process incoming Telegram updates
 *
 * The bot token is read from ENV.telegramBotToken.
 * All functions are no-ops if the token is not configured.
 *
 * NEVER import this file on the client side.
 */

import nodeCrypto from "node:crypto";
import { ENV } from "../_core/env";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: { id: number };
    };
    data?: string;
  };
}

// ─── Core Send Functions ──────────────────────────────────────────────────────

const BOT_API = "https://api.telegram.org/bot";

function getToken(): string | null {
  return (ENV as Record<string, unknown>).telegramBotToken as string | null ?? null;
}

/**
 * Send a plain text message to a Telegram chat.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  parseMode: "HTML" | "Markdown" | "MarkdownV2" = "HTML",
): Promise<boolean> {
  const token = getToken();
  if (!token) {
    console.warn("[TelegramBot] TELEGRAM_BOT_TOKEN not configured — skipping sendMessage");
    return false;
  }
  try {
    const res = await fetch(`${BOT_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    });
    const json = await res.json() as { ok: boolean; description?: string };
    if (!json.ok) {
      console.error("[TelegramBot] sendMessage failed:", json.description);
    }
    return json.ok;
  } catch (err) {
    console.error("[TelegramBot] sendMessage error:", err);
    return false;
  }
}

/**
 * Send a message with an inline keyboard to a Telegram chat.
 * Used for "Payment Received" / "Raise Dispute" action buttons.
 */
export async function sendMessageWithButtons(
  chatId: number,
  text: string,
  buttons: InlineButton[][],
  parseMode: "HTML" | "Markdown" | "MarkdownV2" = "HTML",
): Promise<boolean> {
  const token = getToken();
  if (!token) {
    console.warn("[TelegramBot] TELEGRAM_BOT_TOKEN not configured — skipping sendMessageWithButtons");
    return false;
  }
  try {
    const res = await fetch(`${BOT_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        reply_markup: {
          inline_keyboard: buttons,
        },
      }),
    });
    const json = await res.json() as { ok: boolean; description?: string };
    if (!json.ok) {
      console.error("[TelegramBot] sendMessageWithButtons failed:", json.description);
    }
    return json.ok;
  } catch (err) {
    console.error("[TelegramBot] sendMessageWithButtons error:", err);
    return false;
  }
}

/**
 * Answer a callback query (removes the loading spinner on the inline button).
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${BOT_API}${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text ?? "Done",
        show_alert: false,
      }),
    });
  } catch (err) {
    console.error("[TelegramBot] answerCallbackQuery error:", err);
  }
}

/**
 * Register the bot webhook with Telegram. Includes a Telegram secret_token
 * that Telegram MUST echo back in every POST to /api/telegram/webhook
 * (X-Telegram-Bot-Api-Secret-Token header). Without this, the endpoint
 * accepts arbitrary spoofed payloads from anyone who knows the URL —
 * caught in audit v3.
 *
 * Set TELEGRAM_WEBHOOK_SECRET in env. If unset, registration still works
 * but logs a warning, and verifyWebhookSecret() always returns true (lax
 * mode for legacy compat). Production should always set it.
 */
export async function registerWebhook(webhookUrl: string): Promise<boolean> {
  const token = getToken();
  if (!token) {
    console.warn("[TelegramBot] TELEGRAM_BOT_TOKEN not configured — skipping registerWebhook");
    return false;
  }
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) {
    console.warn(
      "[TelegramBot] TELEGRAM_WEBHOOK_SECRET not set — webhook will accept any POST. " +
      "Set this env var to gate inbound updates per Telegram's recommended pattern.",
    );
  }
  try {
    const body: Record<string, unknown> = { url: webhookUrl };
    if (secretToken) body.secret_token = secretToken;
    const res = await fetch(`${BOT_API}${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { ok: boolean; description?: string };
    console.log("[TelegramBot] Webhook registration:", json);
    return json.ok;
  } catch (err) {
    console.error("[TelegramBot] registerWebhook error:", err);
    return false;
  }
}

/**
 * Verify the secret_token Telegram echoes back in the
 * X-Telegram-Bot-Api-Secret-Token header. Call from the /api/telegram/webhook
 * route before processing the update.
 *
 * Returns true if:
 *   - TELEGRAM_WEBHOOK_SECRET is unset (lax mode — back-compat)
 *   - the header matches the configured secret
 * Otherwise returns false → the route should respond 401 + drop the update.
 */
export function verifyWebhookSecret(header: string | undefined): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;  // lax mode — back-compat when env unset
  if (!header) return false;
  // Use Node's crypto.timingSafeEqual to avoid timing-leak of header length.
  // For mismatched lengths we still run the compare against a padded buffer
  // so timing doesn't reveal which side was shorter — audit v4 fix.
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    const target = Buffer.alloc(b.length);
    a.copy(target, 0, 0, Math.min(a.length, b.length));
    const equal = nodeCrypto.timingSafeEqual(target, b);
    return equal && a.length === b.length;
  } catch {
    return false;
  }
}

// ─── Webhook Update Handler ───────────────────────────────────────────────────

/**
 * Process an incoming Telegram webhook update.
 *
 * Handles:
 *   1. /start messages — store the user's chat_id in the DB
 *   2. callback_query with data "confirm_received:{orderId}" — trigger confirmReceived
 *   3. callback_query with data "raise_dispute:{orderId}" — trigger raiseDispute
 */
export async function handleWebhookUpdate(update: TelegramUpdate): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // ── 1. Store chat_id when user sends any message (especially /start) ──────
  if (update.message?.from) {
    const telegramId = String(update.message.from.id);
    const chatId = update.message.chat.id;
    try {
      await db
        .update(users)
        .set({ telegramChatId: chatId })
        .where(eq(users.telegramId, telegramId));
    } catch (err) {
      console.error("[TelegramBot] Failed to store chat_id:", err);
    }

    // Respond to /start
    if (update.message.text?.startsWith("/start")) {
      await sendMessage(
        chatId,
        "👋 <b>Welcome!</b>\n\nYour Telegram account is now linked. You'll receive order notifications here.\n\n<a href=\"https://t.me/YOUR_BOT_USERNAME/app\">Open the app →</a>",
      );
    }
  }

  // ── 2. Handle inline button callbacks ────────────────────────────────────
  if (update.callback_query) {
    const { id: callbackId, from, data, message } = update.callback_query;
    const chatId = message?.chat.id;

    if (!data || !chatId) {
      await answerCallbackQuery(callbackId);
      return;
    }

    // Dynamically import to avoid circular deps
    const { confirmReceivedInternal, raiseDisputeInternal } = await import("../routers/p2p-actions");

    if (data.startsWith("confirm_received:")) {
      const orderId = parseInt(data.split(":")[1] ?? "0");
      const telegramId = String(from.id);
      try {
        await confirmReceivedInternal({ orderId, telegramId });
        await answerCallbackQuery(callbackId, "✅ Payment confirmed! Escrow released.");
        await sendMessage(chatId, "✅ <b>Payment confirmed.</b> The escrow has been released. Please rate your trading partner in the app.");
      } catch (err) {
        await answerCallbackQuery(callbackId, "❌ Error confirming payment. Please use the app.");
        console.error("[TelegramBot] confirm_received error:", err);
      }
    } else if (data.startsWith("raise_dispute:")) {
      const orderId = parseInt(data.split(":")[1] ?? "0");
      const telegramId = String(from.id);
      try {
        await raiseDisputeInternal({ orderId, telegramId, reason: "Raised via Telegram bot" });
        await answerCallbackQuery(callbackId, "⚠️ Dispute raised. Admin will review shortly.");
        await sendMessage(chatId, "⚠️ <b>Dispute raised.</b> Our team will review this order and contact both parties.");
      } catch (err) {
        await answerCallbackQuery(callbackId, "❌ Error raising dispute. Please use the app.");
        console.error("[TelegramBot] raise_dispute error:", err);
      }
    } else {
      await answerCallbackQuery(callbackId);
    }
  }
}
