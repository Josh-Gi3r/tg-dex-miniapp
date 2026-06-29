/**
 * ─── P2P Actions (Internal) ───────────────────────────────────────────────────
 *
 * Internal action functions that can be called from:
 *   1. tRPC procedures (via the p2p router)
 *   2. Telegram bot webhook callbacks (inline button presses)
 *
 * These functions are NOT tRPC procedures themselves — they are plain async
 * functions that accept typed inputs and return results.
 */

import { eq, and, or } from "drizzle-orm";
import { getDb } from "../db";
import { p2pOrders, users, changerProfiles, transactions } from "../../drizzle/schema";
import { sendMessage, sendMessageWithButtons } from "../lib/telegram";
import { awardPoints } from "./referral";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlaceOrderInput {
  adId: number;
  changerId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  rateUsed: number;
  spreadBps?: number;
  adType: "swap" | "buy" | "sell";
  fiatAmount?: string;
  fiatCurrency?: string;
  paymentMethod?: string;
  takerId: number;
  advertiserHandle?: string;
}

export interface PlaceOrderResult {
  orderId: number;
  status: string;
  advertiserHandle?: string;
}

// ─── placeOrderInternal ───────────────────────────────────────────────────────

/**
 * Places a P2P order and locks escrow (DB lock).
 * For fiat orders (buy/sell): status → escrowed immediately.
 * For swap orders: status → filled immediately (simulated).
 * Notifies the changer via Telegram bot.
 */
export async function placeOrderInternal(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const isFiat = input.adType === "buy" || input.adType === "sell";
  const initialStatus = isFiat ? "escrowed" : "filled";

  const [inserted] = await db.insert(p2pOrders).values({
    adId: input.adId,
    changerId: input.changerId,
    takerId: input.takerId,
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAmount: input.fromAmount,
    toAmount: input.toAmount,
    rateUsed: String(input.rateUsed),
    spreadBps: input.spreadBps,
    adType: input.adType,
    fiatAmount: input.fiatAmount,
    fiatCurrency: input.fiatCurrency,
    paymentMethod: input.paymentMethod,
    status: initialStatus,
    escrowLockedAt: isFiat ? new Date() : undefined,
  });

  const orderId = Number((inserted as { insertId?: number }).insertId ?? 0);

  // Notify the changer via Telegram bot
  if (isFiat) {
    const changerRows = await db
      .select({ telegramChatId: users.telegramChatId, telegramUsername: users.telegramUsername })
      .from(users)
      .where(eq(users.id, input.changerId))
      .limit(1);

    const changer = changerRows[0];
    if (changer?.telegramChatId) {
      const takerRows = await db
        .select({ telegramUsername: users.telegramUsername, name: users.name })
        .from(users)
        .where(eq(users.id, input.takerId))
        .limit(1);
      const taker = takerRows[0];
      const takerName = taker?.telegramUsername ? `@${taker.telegramUsername}` : (taker?.name ?? "A user");

      await sendMessage(
        changer.telegramChatId,
        `🔔 <b>New P2P Order #${orderId}</b>\n\n` +
        `${takerName} wants to ${input.adType === "buy" ? "buy" : "sell"} <b>${input.fromAmount} ${input.fromToken}</b>\n` +
        `Rate: <b>${input.rateUsed} ${input.toToken}</b>\n` +
        `Payment: <b>${input.paymentMethod ?? "TBD"}</b>\n\n` +
        `💬 Chat with them to arrange fiat payment details.\n` +
        `Open the app to manage this order.`,
      );
    }
  }

  return { orderId, status: initialStatus, advertiserHandle: input.advertiserHandle };
}

// ─── markPaidInternal ─────────────────────────────────────────────────────────

/**
 * Marks a fiat order as paid by the taker.
 * Status: escrowed → payment_sent
 * Sends a Telegram notification to the changer with a "Payment Received" inline button.
 */
export async function markPaidInternal(input: { orderId: number; userId: number }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const orderRows = await db
    .select()
    .from(p2pOrders)
    .where(and(eq(p2pOrders.id, input.orderId), eq(p2pOrders.takerId, input.userId)))
    .limit(1);

  const order = orderRows[0];
  if (!order) throw new Error("Order not found or you are not the taker");
  if (order.status !== "escrowed") throw new Error(`Cannot mark paid — order status is '${order.status}'`);

  await db
    .update(p2pOrders)
    .set({ status: "payment_sent", paidAt: new Date() })
    .where(eq(p2pOrders.id, input.orderId));

  // Notify the changer with inline "Payment Received" + "Raise Dispute" buttons
  const changerRows = await db
    .select({ telegramChatId: users.telegramChatId, telegramUsername: users.telegramUsername })
    .from(users)
    .where(eq(users.id, order.changerId))
    .limit(1);

  const changer = changerRows[0];
  if (changer?.telegramChatId) {
    const takerRows = await db
      .select({ telegramUsername: users.telegramUsername, name: users.name })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    const taker = takerRows[0];
    const takerName = taker?.telegramUsername ? `@${taker.telegramUsername}` : (taker?.name ?? "Your trading partner");

    await sendMessageWithButtons(
      changer.telegramChatId,
      `💸 <b>Payment Sent — Order #${input.orderId}</b>\n\n` +
      `${takerName} has marked the fiat payment as sent.\n` +
      `Amount: <b>${order.fromAmount} ${order.fromToken}</b>\n\n` +
      `Once you confirm receipt of the fiat payment, tap <b>Payment Received</b> to release the escrow.`,
      [
        [
          { text: "✅ Payment Received", callback_data: `confirm_received:${input.orderId}` },
          { text: "⚠️ Raise Dispute", callback_data: `raise_dispute:${input.orderId}` },
        ],
      ],
    );
  }
}

// ─── confirmReceivedInternal ──────────────────────────────────────────────────

/**
 * Confirms fiat payment received by the changer.
 * Status: payment_sent → completed
 * Releases escrow (DB), awards XP + points, notifies taker.
 */
export async function confirmReceivedInternal(input: {
  orderId: number;
  userId?: number;
  telegramId?: string;
  /**
   * On-chain tx hash from the changer's /transfer broadcast. When provided,
   * it's persisted on the order and shown in the trade-completed notification.
   * When absent we fall back to demo mode — the order is marked completed in
   * DB only. Once Privy is on, the in-app confirmReceived button always
   * provides a real txHash; the Telegram bot inline-button path remains
   * DB-only and prompts the changer to release in-app.
   */
  releaseTxHash?: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  // Resolve userId from telegramId if needed (bot callback path)
  let changerId = input.userId;
  if (!changerId && input.telegramId) {
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramId, input.telegramId))
      .limit(1);
    changerId = userRows[0]?.id;
  }
  if (!changerId) throw new Error("User not found");

  const orderRows = await db
    .select()
    .from(p2pOrders)
    .where(and(eq(p2pOrders.id, input.orderId), eq(p2pOrders.changerId, changerId)))
    .limit(1);

  const order = orderRows[0];
  if (!order) throw new Error("Order not found or you are not the changer");
  if (order.status !== "payment_sent") throw new Error(`Cannot confirm — order status is '${order.status}'`);

  // If the bot inline-button path triggered this (no releaseTxHash), the
  // changer hasn't actually released the on-chain stablecoin yet — only
  // the DB state will move. Hold the order at 'payment_sent' and notify
  // the changer to open the app and complete the on-chain release. The
  // in-app `confirmReceived` mutation always provides a releaseTxHash
  // and goes the normal path below.
  const isBotPath = !input.releaseTxHash && input.telegramId;

  if (isBotPath) {
    const changerRows = await db
      .select({ telegramChatId: users.telegramChatId })
      .from(users)
      .where(eq(users.id, changerId))
      .limit(1);
    const changer = changerRows[0];
    if (changer?.telegramChatId) {
      await sendMessage(
        changer.telegramChatId,
        `📝 <b>Order #${input.orderId} — On-chain release needed</b>\n\n` +
        `You confirmed fiat receipt, but the stablecoin release happens on-chain. ` +
        `Open the app and tap "Release escrow" on this order to complete the trade.\n\n` +
        `Until then the taker is still waiting on their <b>${order.fromAmount} ${order.fromToken}</b>.`,
      );
    }
    // Don't mark completed — the on-chain step is pending
    return;
  }

  // In-app path: REFUSE to mark complete without a real on-chain release tx.
  // The legacy fiat-escrow release was gated on the dead Privy live-mode flag
  // path, so releaseTxHash arrives undefined and the order would silently flip
  // to 'completed' with NO stablecoin transfer — a fund-loss lie (audit crit #1).
  // Block honestly until a server-signed release is wired. The 3-leg burst
  // (shopSettlement.executeBurst) is the real, working P2P settlement path.
  if (!input.releaseTxHash) {
    throw new Error(
      "On-chain release isn't available yet — we won't mark this trade complete until the stablecoin is actually released on-chain. (Legacy fiat escrow is deprecated; use a swap shop.)",
    );
  }

  await db
    .update(p2pOrders)
    .set({
      status: "completed",
      completedAt: new Date(),
      isRatedByChanger: false,
      isRatedByTaker: false,
      // Persist on-chain release hash when the in-app flow provided one.
      ...(input.releaseTxHash ? { txHash: input.releaseTxHash } : {}),
    })
    .where(eq(p2pOrders.id, input.orderId));

  // Award XP + points to both parties
  if (order.takerId) {
    await awardPoints({ userId: order.takerId, delta: 10, reason: "trade_completed", relatedOrderId: input.orderId });
  }
  await awardPoints({ userId: changerId, delta: 10, reason: "trade_completed", relatedOrderId: input.orderId });

  // Record transactions
  if (order.takerId) {
    await db.insert(transactions).values({
      userId: order.takerId,
      type: "fill_order",
      fromToken: order.fromToken,
      toToken: order.toToken,
      fromAmount: order.fromAmount,
      toAmount: order.toAmount ?? "0",
      status: "completed",
      relatedOrderId: input.orderId,
      xpEarned: 10,
    });
  }

  // Notify taker that escrow is released
  if (order.takerId) {
    const takerRows = await db
      .select({ telegramChatId: users.telegramChatId })
      .from(users)
      .where(eq(users.id, order.takerId))
      .limit(1);
    const taker = takerRows[0];
    if (taker?.telegramChatId) {
      await sendMessage(
        taker.telegramChatId,
        `✅ <b>Trade Complete — Order #${input.orderId}</b>\n\n` +
        `Your payment has been confirmed and the escrow has been released.\n` +
        `<b>${order.fromAmount} ${order.fromToken}</b> → <b>${order.toAmount ?? "?"} ${order.toToken}</b>\n\n` +
        `Open the app to rate your trading partner and claim your XP.`,
      );
    }
  }

  // Update changer stats. `db.$count` returns Promise<number> — must be
  // awaited before assignment, otherwise the un-awaited Promise gets serialized
  // into the column. v1 audit finding #8.
  const filledCount = await db.$count(p2pOrders, eq(p2pOrders.changerId, changerId));
  await db
    .update(changerProfiles)
    .set({ totalOrdersFilled: filledCount })
    .where(eq(changerProfiles.userId, changerId));
}

// ─── raiseDisputeInternal ─────────────────────────────────────────────────────

/**
 * Raises a dispute on an order.
 * Status: escrowed | payment_sent → disputed
 * Notifies admin via owner notification.
 */
export async function raiseDisputeInternal(input: {
  orderId: number;
  userId?: number;
  telegramId?: string;
  reason: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  let userId = input.userId;
  if (!userId && input.telegramId) {
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramId, input.telegramId))
      .limit(1);
    userId = userRows[0]?.id;
  }
  if (!userId) throw new Error("User not found");

  const orderRows = await db
    .select()
    .from(p2pOrders)
    .where(
      and(
        eq(p2pOrders.id, input.orderId),
        or(eq(p2pOrders.takerId, userId), eq(p2pOrders.changerId, userId)),
      ),
    )
    .limit(1);

  const order = orderRows[0];
  if (!order) throw new Error("Order not found or you are not a party to this order");
  if (!["escrowed", "payment_sent"].includes(order.status)) {
    throw new Error(`Cannot raise dispute — order status is '${order.status}'`);
  }

  await db
    .update(p2pOrders)
    .set({ status: "disputed", disputeReason: input.reason })
    .where(eq(p2pOrders.id, input.orderId));

  // Notify admin via owner notification
  try {
    const { notifyOwner } = await import("../_core/notification");
    await notifyOwner({
      title: `⚠️ P2P Dispute — Order #${input.orderId}`,
      content: `User ${userId} raised a dispute.\nReason: ${input.reason}\nOrder: ${order.fromAmount} ${order.fromToken} → ${order.toAmount ?? "?"} ${order.toToken}`,
    });
  } catch (err) {
    console.error("[P2P] Failed to notify admin of dispute:", err);
  }
}
