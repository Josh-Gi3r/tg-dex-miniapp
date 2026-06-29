/**
 * ─── Owner Notifications ────────────────────────────────────────────────────
 *
 * Operational alerts to the project owner. Two delivery paths:
 *   1. Telegram DM if OWNER_TELEGRAM_CHAT_ID (or OWNER_OPEN_ID with the
 *      "tg_" prefix) is set and TELEGRAM_BOT_TOKEN is configured.
 *   2. Console fallback otherwise — every alert is still surfaced in
 *      the server log, so nothing gets silently dropped on a fresh
 *      deploy that hasn't wired up the chat id yet.
 *
 * No external service. No external notification service used.
 */
import { TRPCError } from "@trpc/server";
import { ENV } from "./env";
import { sendMessage } from "../lib/telegram";

export type NotificationPayload = {
  title: string;
  content: string;
};

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function validatePayload(input: NotificationPayload): NotificationPayload {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required.",
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required.",
    });
  }
  const title = input.title.trim().slice(0, TITLE_MAX_LENGTH);
  const content = input.content.trim().slice(0, CONTENT_MAX_LENGTH);
  return { title, content };
}

function getOwnerChatId(): number | null {
  const explicit = process.env.OWNER_TELEGRAM_CHAT_ID;
  if (explicit && /^-?\d+$/.test(explicit)) return Number(explicit);

  // OWNER_OPEN_ID is "tg_<telegramId>" for Telegram-authenticated owners.
  const openId = ENV.ownerOpenId;
  if (openId.startsWith("tg_")) {
    const id = openId.slice(3);
    if (/^-?\d+$/.test(id)) return Number(id);
  }
  return null;
}

export async function notifyOwner(
  payload: NotificationPayload,
): Promise<boolean> {
  const { title, content } = validatePayload(payload);
  const chatId = getOwnerChatId();
  const text = `*${title}*\n\n${content}`;

  if (chatId === null) {
    console.warn("[notifyOwner] No owner chat id configured. Alert:", title, content);
    return false;
  }

  try {
    await sendMessage(chatId, text, "Markdown");
    return true;
  } catch (err) {
    console.error("[notifyOwner] Telegram send failed:", err);
    return false;
  }
}
