/**
 * ─── Shop Settlement Background Workers ──────────────────────────────────────
 *
 * Three cron-driven workers that maintain settlement health:
 *
 *   ttlExpiryWorker     — flip reservations past reservedUntil to "expired"
 *   refundWorker        — fire refund leg on settlements in "refund_required"
 *   recycleRetryWorker  — retry recycle deposit for settlements stuck in
 *                          "recycle_pending" without a confirmed leg 3
 *
 * Each worker is idempotent — safe to call repeatedly. Designed to be invoked
 * from /internal/shop-settlement/run every ~60s, matching the existing 3
 * cron-cycle pattern (signals/yield/fills).
 *
 * The workers do not directly call the venue. They use the existing dex router
 * procedures via internal client invocation OR mark settlements for the
 * refund/recycle UI to surface to operators. For v1 the refund and recycle
 * paths log the action + advance state but do not auto-sign the venue txs from
 * here — that requires the maker's managed-shop-wallet key handling which
 * lives in a separate wallet-signing service. v1 ships with manual flow +
 * the state machine wired; the wallet-signing integration follows in v2.
 */

import { and, eq, lt, sql } from "drizzle-orm";

import { getDb } from "../../db";
import {
  shopSettlements,
  shopSettlementLegs,
  type ShopSettlement,
} from "../../../drizzle/schema";
import { releaseReservation } from "./shopSettlementDb";
import { signAndBroadcastDeposit, signAndBroadcastTransfer } from "./walletSigner";
import { getDexClient } from "./client";

// Raw → human conversion using the canonical decimals persisted on the
// settlement row. Workers MUST pass decimals from the row, never default.
// ARC has 2 decimals; defaulting to 6 mis-credits 10,000× (audit blocker #2).
function rawToHuman(raw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`rawToHuman: invalid decimals ${decimals}`);
  }
  const denom = 10n ** BigInt(decimals);
  const r = BigInt(raw);
  const whole = r / denom;
  const frac = r % denom;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

export interface WorkerCycleResult {
  worker: "ttl_expiry" | "refund" | "recycle_retry";
  scanned: number;
  acted: number;
  errors: number;
  durationMs: number;
}

// ─── 1. TTL expiry worker ────────────────────────────────────────────────────
//
// Finds shop_settlements in (quoted, reserved, payment_pending_signature)
// whose reservedUntil has passed, and flips them to "expired" while releasing
// the inventory + cap locks. Safe to call any frequency; race-free via
// optimistic CAS on status.

export async function runTtlExpiryWorker(now: Date = new Date()): Promise<WorkerCycleResult> {
  const start = Date.now();
  const result: WorkerCycleResult = {
    worker: "ttl_expiry",
    scanned: 0,
    acted: 0,
    errors: 0,
    durationMs: 0,
  };

  const db = await getDb();
  if (!db) {
    result.durationMs = Date.now() - start;
    return result;
  }

  // Pull expired candidates (small batch to avoid long tx)
  const candidates = (await db
    .select()
    .from(shopSettlements)
    .where(
      and(
        sql`${shopSettlements.status} IN ('quoted', 'reserved', 'payment_pending_signature')`,
        lt(shopSettlements.reservedUntil, now),
      ),
    )
    .limit(50)) as ShopSettlement[];

  result.scanned = candidates.length;

  for (const s of candidates) {
    try {
      // CAS — only one worker run flips it
      const updateResult = await db
        .update(shopSettlements)
        .set({
          status: "expired",
          failureCode: "TTL_EXPIRED",
          failureDetail: `Reservation expired at ${s.reservedUntil?.toISOString() ?? "unknown"}`,
        })
        .where(
          and(
            eq(shopSettlements.id, s.id),
            eq(shopSettlements.status, s.status),
          ),
        );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const affected = (updateResult as any).rowsAffected ?? (updateResult as any)[0]?.affectedRows ?? 0;
      if (affected > 0) {
        // Release reservation locks — idempotent via settlementId guard.
        // sellAmountHuman conservatively converted via 6-decimal default
        // (most the venue stablecoins). Caller already advanced status; the
        // release just restores ad liquidity + cap if not already done.
        await releaseReservation({
          settlementId: s.id,
          adId: s.adId,
          sellAmountHuman: rawToHuman(s.sellAmountRaw, s.sellDecimals),
          makerUserId: s.makerUserId,
          sellAmountUsd: 0,
          managedWalletActive: true,
        }).catch(() => {});
        result.acted++;
      }
    } catch {
      result.errors++;
    }
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ─── 2. Refund worker ────────────────────────────────────────────────────────
//
// Finds shop_settlements in "refund_required", actually executes the refund
// via the maker's managed-shop-wallet (signs + broadcasts /transfer back to
// taker), and on success advances to "refunded" through "refund_pending".
//
// v4: this used to only enqueue a leg row and rely on a separate signing
// service. The walletSigner.ts module now signs + broadcasts inline.

export async function runRefundWorker(): Promise<WorkerCycleResult> {
  const start = Date.now();
  const result: WorkerCycleResult = {
    worker: "refund",
    scanned: 0,
    acted: 0,
    errors: 0,
    durationMs: 0,
  };

  const db = await getDb();
  if (!db) {
    result.durationMs = Date.now() - start;
    return result;
  }

  const candidates = (await db
    .select()
    .from(shopSettlements)
    .where(eq(shopSettlements.status, "refund_required"))
    .limit(50)) as ShopSettlement[];

  result.scanned = candidates.length;

  // We need token address for the refund — fetch /tokens once per cycle
  const dexClient = getDexClient();
  const tokensRes = await dexClient.getTokens().catch(() => null);
  if (!tokensRes?.tokens?.length) {
    result.errors = candidates.length;
    result.durationMs = Date.now() - start;
    return result;
  }

  for (const s of candidates) {
    try {
      // Idempotency: skip if refund leg already broadcast/confirmed
      const existingLegs = await db
        .select()
        .from(shopSettlementLegs)
        .where(
          and(
            eq(shopSettlementLegs.settlementId, s.id),
            eq(shopSettlementLegs.legNumber, 99),
          ),
        );
      const hasNonFailedLeg = existingLegs.some(
        (l) => l.status === "broadcast" || l.status === "confirmed",
      );
      if (hasNonFailedLeg) continue;

      // Advance status with CAS (refund_required → refund_pending)
      const updateResult = await db
        .update(shopSettlements)
        .set({ status: "refund_pending" })
        .where(
          and(
            eq(shopSettlements.id, s.id),
            eq(shopSettlements.status, "refund_required"),
          ),
        );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const affected = (updateResult as any).rowsAffected ?? (updateResult as any)[0]?.affectedRows ?? 0;
      if (affected === 0) continue;

      // Find the buy-token contract address (this is what we're refunding)
      const buyTokenMeta = tokensRes.tokens.find((t) => t.symbol === s.buyToken);
      if (!buyTokenMeta) {
        // Mark for manual review
        await db
          .update(shopSettlements)
          .set({
            status: "failed_manual_review",
            failureCode: "REFUND_UNKNOWN_TOKEN",
            failureDetail: `Could not resolve buyToken ${s.buyToken} in the venue /tokens`,
          })
          .where(eq(shopSettlements.id, s.id));
        result.errors++;
        continue;
      }

      // Insert pending refund leg row
      const attempt = existingLegs.length;
      const idempotencyKey = `${s.settlementUuid}:99:${attempt}`;
      const insertRes = await db.insert(shopSettlementLegs).values({
        settlementId: s.id,
        legNumber: 99,
        legKind: "refund",
        settlementEndpoint: "transfer",
        idempotencyKey,
        signerAddress: s.makerAddress,
        signerRole: "maker_managed",
        status: "pending_signature",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legId = ((insertRes as any).insertId ?? (insertRes as any)[0]?.insertId) as number;

      // Sign + broadcast the refund transfer
      const signResult = await signAndBroadcastTransfer({
        userId: s.makerUserId,
        fromAddress: s.makerAddress,
        toAddress: s.takerAddress,
        tokenAddress: buyTokenMeta.address,
        amountRaw: s.buyAmountRaw,
      });

      if (signResult.ok) {
        await db
          .update(shopSettlementLegs)
          .set({
            status: "broadcast",
            txHash: signResult.txHash,
            broadcastAt: new Date(),
          })
          .where(eq(shopSettlementLegs.id, legId));
        result.acted++;
      } else {
        await db
          .update(shopSettlementLegs)
          .set({
            status: "failed",
            failureCode: signResult.code,
            failureDetail: signResult.detail,
          })
          .where(eq(shopSettlementLegs.id, legId));
        // If signing failed terminally (killed wallet, no creds), mark for manual review
        if (signResult.code === "WALLET_KILLED" || signResult.code === "WALLET_DISABLED" || signResult.code === "NO_MANAGED_WALLET") {
          await db
            .update(shopSettlements)
            .set({
              status: "failed_manual_review",
              failureCode: signResult.code,
              failureDetail: signResult.detail,
            })
            .where(eq(shopSettlements.id, s.id));
        }
        // Otherwise leave at refund_pending — next cycle retries
        result.errors++;
      }
    } catch (err) {
      console.error(`[refund-worker] settlement ${s.id} crashed:`, err);
      result.errors++;
    }
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ─── 3. Recycle retry worker ─────────────────────────────────────────────────
//
// Finds shop_settlements in "recycle_pending" whose recycle leg (leg 3)
// hasn't confirmed within a reasonable window (e.g., 5 minutes since
// broadcast). Inserts a retry leg with attempt+1 idempotency key. Bounded:
// max 3 retries per settlement, then mark "completed" (taker got their goods,
// maker just has funds in wallet — not in vault — acceptable failure mode).

const MAX_RECYCLE_RETRIES = 3;
const RECYCLE_STUCK_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes

export async function runRecycleRetryWorker(now: Date = new Date()): Promise<WorkerCycleResult> {
  const start = Date.now();
  const result: WorkerCycleResult = {
    worker: "recycle_retry",
    scanned: 0,
    acted: 0,
    errors: 0,
    durationMs: 0,
  };

  const db = await getDb();
  if (!db) {
    result.durationMs = Date.now() - start;
    return result;
  }

  const candidates = (await db
    .select()
    .from(shopSettlements)
    .where(eq(shopSettlements.status, "recycle_pending"))
    .limit(50)) as ShopSettlement[];

  result.scanned = candidates.length;

  // Fetch /tokens once per cycle for address resolution
  const dexClient = getDexClient();
  const tokensRes = await dexClient.getTokens().catch(() => null);

  for (const s of candidates) {
    try {
      const recycleLegs = await db
        .select()
        .from(shopSettlementLegs)
        .where(
          and(
            eq(shopSettlementLegs.settlementId, s.id),
            eq(shopSettlementLegs.legNumber, 3),
          ),
        );

      const sorted = [...recycleLegs].sort((a, b) =>
        (b.broadcastAt?.getTime() ?? 0) - (a.broadcastAt?.getTime() ?? 0),
      );
      const latest = sorted[0];

      const attemptCount = recycleLegs.length;
      if (attemptCount >= MAX_RECYCLE_RETRIES) {
        // Give up — complete the trade (taker already settled)
        await db
          .update(shopSettlements)
          .set({
            status: "completed",
            completedAt: now,
            failureCode: "RECYCLE_EXHAUSTED",
            failureDetail: `${MAX_RECYCLE_RETRIES} recycle attempts failed; funds in maker wallet`,
          })
          .where(
            and(
              eq(shopSettlements.id, s.id),
              eq(shopSettlements.status, "recycle_pending"),
            ),
          );
        result.acted++;
        continue;
      }

      // Conditions for actually attempting now:
      // - no leg yet (recycle_started fired but never inserted — first attempt)
      // - or latest is stale broadcast (no confirm)
      // - or latest failed
      const isFirstAttempt = !latest;
      const ageMs = now.getTime() - (latest?.broadcastAt?.getTime() ?? 0);
      const isStuck = latest?.status === "broadcast" && ageMs > RECYCLE_STUCK_WINDOW_MS;
      const justFailed = latest?.status === "failed";

      if (!isFirstAttempt && !isStuck && !justFailed) {
        continue;
      }

      // Sign + broadcast the deposit (recycle)
      if (!tokensRes?.tokens) {
        result.errors++;
        continue;
      }
      const buyTokenMeta = tokensRes.tokens.find((t) => t.symbol === s.buyToken);
      if (!buyTokenMeta) {
        result.errors++;
        continue;
      }

      const idempotencyKey = `${s.settlementUuid}:3:${attemptCount}`;
      const insertRes = await db.insert(shopSettlementLegs).values({
        settlementId: s.id,
        legNumber: 3,
        legKind: "recycle",
        settlementEndpoint: "deposit",
        idempotencyKey,
        signerAddress: s.makerAddress,
        signerRole: "maker_managed",
        status: "pending_signature",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legId = ((insertRes as any).insertId ?? (insertRes as any)[0]?.insertId) as number;

      const signResult = await signAndBroadcastDeposit({
        userId: s.makerUserId,
        ownerAddress: s.makerAddress,
        tokenAddress: buyTokenMeta.address,
        amountRaw: s.buyAmountRaw,
      });

      if (signResult.ok) {
        await db
          .update(shopSettlementLegs)
          .set({
            status: "broadcast",
            txHash: signResult.txHash,
            broadcastAt: new Date(),
          })
          .where(eq(shopSettlementLegs.id, legId));
        result.acted++;
      } else {
        await db
          .update(shopSettlementLegs)
          .set({
            status: "failed",
            failureCode: signResult.code,
            failureDetail: signResult.detail,
          })
          .where(eq(shopSettlementLegs.id, legId));
        result.errors++;
      }
    } catch (err) {
      console.error(`[recycle-worker] settlement ${s.id} crashed:`, err);
      result.errors++;
    }
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ─── Cycle runner — invoked by /internal/shop-settlement/run ─────────────────

export async function runShopSettlementCycle(): Promise<{
  ttl: WorkerCycleResult;
  refund: WorkerCycleResult;
  recycleRetry: WorkerCycleResult;
}> {
  const [ttl, refund, recycleRetry] = await Promise.all([
    runTtlExpiryWorker(),
    runRefundWorker(),
    runRecycleRetryWorker(),
  ]);
  return { ttl, refund, recycleRetry };
}

// In-memory cache of the last cycle result for the systemRouter /cronStatus
// surface. Mirrors the signals + yield workers' pattern.

let lastCycle:
  | (Awaited<ReturnType<typeof runShopSettlementCycle>> & { ranAt: Date })
  | null = null;

export function getLastShopSettlementCycle() {
  return lastCycle;
}

export async function runShopSettlementCycleTracked() {
  const r = await runShopSettlementCycle();
  lastCycle = { ...r, ranAt: new Date() };
  return r;
}
