/**
 * ─── Shop Settlement — Drizzle-backed Deps ───────────────────────────────────
 *
 * Real DB implementation of the ShopSettlementDeps interface. Pure-logic
 * orchestrator lives in shopSettlement.ts; this file adapts it to MySQL
 * via Drizzle.
 *
 * Loaded lazily — needs DATABASE_URL set to function. Tests bypass this
 * entirely by injecting their own deps mock.
 */
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db";
import {
  shopSettlements,
  shopSettlementLegs,
  managedWalletCaps,
  p2pAds,
  type ShopSettlementStatus,
  type InsertShopSettlement,
} from "../../../drizzle/schema";

import type {
  LegKind,
  LegStatus,
  ReserveRequest,
  SettlementSnapshot,
  ShopSettlementDeps,
  SettlementEndpoint,
  SignerRole,
} from "./shopSettlement";

// ─── B1 + B2 — Atomic reserve helpers ──────────────────────────────────────
//
// Closes the TOCTOU + multi-taker-race holes flagged in AUDIT_v2_REPORT.md.
//
// At reserve time, we atomically:
//   1. Decrement p2pAds.liquidityRemaining (B2 — inventory lock)
//   2. If maker has managed wallet enabled, increment
//      managed_wallet_caps.daily_volume_used_usd (B1 — cap debit)
// Both within a SQL transaction. On cancel/expire/refund, the same helpers
// run in reverse to release the locks.

export interface ReservationDebitInput {
  adId: number;
  /**
   * Sell amount in HUMAN units (e.g. "100" or "100.5"), matching
   * p2pAds.liquidityRemaining's decimal(18,6) scale. Caller MUST convert
   * raw uint256 → human via token decimals before invoking. Mixing
   * raw and human here would underflow liquidityRemaining on the first
   * trade for any token with non-zero decimals — caught in v3 audit.
   */
  sellAmountHuman: string;
  makerUserId: number;
  sellAmountUsd: number;     // for daily cap accounting
  managedWalletActive: boolean;  // skip cap debit when maker has no managed wallet
}

export type ReservationDebitResult =
  | { ok: true }
  | {
      ok: false;
      code: "INSUFFICIENT_LIQUIDITY" | "MANAGED_WALLET_KILLED" | "DAILY_CAP_EXCEEDED";
      detail: string;
    };

/**
 * Atomic reserve-time debit. Inventory debit + (optional) cap debit run
 * inside a real DB transaction (`db.transaction(async (tx) => ...)`) so
 * either both apply or neither does. Returns ok or a structured failure
 * reason.
 *
 * Units: `sellAmountHuman` is the HUMAN amount (matches
 * p2pAds.liquidityRemaining decimal(18,6) scale). Caller MUST convert
 * uint256 raw → human via the token's decimals before invoking — the v3
 * audit found a raw/human mismatch here that would underflow on first
 * trade for any token with non-zero decimals.
 */
export async function debitReservation(
  input: ReservationDebitInput,
): Promise<ReservationDebitResult> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  try {
    return await db.transaction(async (tx) => {
      // Step 1: conditional debit of ad liquidity in HUMAN units.
      // The WHERE clause guards against negative values + non-active ads.
      const adResult = await tx
        .update(p2pAds)
        .set({
          liquidityRemaining: sql`${p2pAds.liquidityRemaining} - ${input.sellAmountHuman}`,
        })
        .where(
          and(
            eq(p2pAds.id, input.adId),
            sql`${p2pAds.liquidityRemaining} >= ${input.sellAmountHuman}`,
            eq(p2pAds.status, "active"),
          ),
        );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adAffected = (adResult as any).rowsAffected ?? (adResult as any)[0]?.affectedRows ?? 0;
      if (adAffected === 0) {
        // Throwing inside the transaction triggers rollback
        throw new ReservationDebitFailure({
          ok: false,
          code: "INSUFFICIENT_LIQUIDITY",
          detail: `Ad ${input.adId} has insufficient liquidityRemaining for ${input.sellAmountHuman} human units, or is not active`,
        });
      }

      // Step 2: cap debit (only if maker has managed wallet enabled)
      if (input.managedWalletActive) {
        const capResult = await tx
          .update(managedWalletCaps)
          .set({
            dailyVolumeUsedUsd: sql`${managedWalletCaps.dailyVolumeUsedUsd} + ${input.sellAmountUsd}`,
          })
          .where(
            and(
              eq(managedWalletCaps.userId, input.makerUserId),
              eq(managedWalletCaps.enabled, true),
              eq(managedWalletCaps.killed, false),
              sql`${managedWalletCaps.dailyVolumeUsedUsd} + ${input.sellAmountUsd} <= ${managedWalletCaps.dailyVolumeCapUsd}`,
            ),
          );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capAffected = (capResult as any).rowsAffected ?? (capResult as any)[0]?.affectedRows ?? 0;
        if (capAffected === 0) {
          // Read the cap row to determine precise reason (rollback happens via throw)
          const capRow = (await tx
            .select()
            .from(managedWalletCaps)
            .where(eq(managedWalletCaps.userId, input.makerUserId))
            .limit(1))[0];
          if (!capRow) {
            throw new ReservationDebitFailure({
              ok: false,
              code: "MANAGED_WALLET_KILLED",
              detail: "Maker has no managed wallet record",
            });
          }
          if (capRow.killed) {
            throw new ReservationDebitFailure({
              ok: false,
              code: "MANAGED_WALLET_KILLED",
              detail: capRow.killReason ?? "killed",
            });
          }
          throw new ReservationDebitFailure({
            ok: false,
            code: "DAILY_CAP_EXCEEDED",
            detail: `Daily cap ${capRow.dailyVolumeCapUsd} would be exceeded by +${input.sellAmountUsd}`,
          });
        }
      }

      return { ok: true as const };
    });
  } catch (err) {
    if (err instanceof ReservationDebitFailure) {
      return err.result;
    }
    throw err;
  }
}

class ReservationDebitFailure extends Error {
  constructor(public readonly result: Extract<ReservationDebitResult, { ok: false }>) {
    super(result.detail);
    this.name = "ReservationDebitFailure";
  }
}

/**
 * Release the reservation debits — called on cancel / expire / refund.
 *
 * Idempotent via the settlement's `locks_released_at` flag: first call sets
 * it + restores liquidity + cap; subsequent calls are no-ops. The v3 audit
 * caught that the prior implementation could double-credit liquidity if
 * called twice (e.g. by both the cancel path and the TTL worker for the
 * same settlement).
 *
 * Pass `settlementId` so the helper can atomically CAS the released flag.
 * If `settlementId` is omitted (legacy callers / cleanup scripts), the
 * helper falls back to non-idempotent behavior + warns.
 */
export async function releaseReservation(input: {
  settlementId?: number;  // required for idempotency; legacy callers may omit
  adId: number;
  sellAmountHuman: string;
  makerUserId: number;
  sellAmountUsd: number;
  managedWalletActive: boolean;
}): Promise<{ released: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  return await db.transaction(async (tx) => {
    // Idempotency guard: atomically claim the released flag. If already
    // set, return early without crediting back.
    if (input.settlementId !== undefined) {
      const result = await tx
        .update(shopSettlements)
        .set({})  // no other fields — only locks_released_at via raw SQL below
        .where(
          and(
            eq(shopSettlements.id, input.settlementId),
            sql`${shopSettlements.id} = ${input.settlementId}`,
          ),
        );
      // Use a separate raw SET because Drizzle's typed schema doesn't yet
      // include the new locks_released_at column (added via migration only).
      const claimResult = await tx.execute(
        sql.raw(
          `UPDATE shop_settlements
             SET locks_released_at = CURRENT_TIMESTAMP
             WHERE id = ${input.settlementId}
               AND locks_released_at IS NULL`,
        ),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const claimed = (claimResult as any).rowsAffected ?? (claimResult as any)[0]?.affectedRows ?? 0;
      // Suppress unused-result warning
      void result;
      if (claimed === 0) {
        // Already released by a previous caller — skip
        return { released: false };
      }
    }

    // Restore ad liquidity (HUMAN units)
    await tx
      .update(p2pAds)
      .set({
        liquidityRemaining: sql`${p2pAds.liquidityRemaining} + ${input.sellAmountHuman}`,
      })
      .where(eq(p2pAds.id, input.adId));

    // Restore managed-wallet daily cap usage
    if (input.managedWalletActive) {
      await tx
        .update(managedWalletCaps)
        .set({
          dailyVolumeUsedUsd: sql`GREATEST(${managedWalletCaps.dailyVolumeUsedUsd} - ${input.sellAmountUsd}, 0)`,
        })
        .where(eq(managedWalletCaps.userId, input.makerUserId));
    }

    return { released: true };
  });
}

/**
 * Re-check the maker's managed-wallet state at signed-leg time (B3 fix).
 * Returns true if maker is still authorized to release inventory. False if
 * the wallet was killed since reserve, or if some other invariant broke.
 */
export async function recheckManagedWallet(
  makerUserId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const row = (await db
    .select()
    .from(managedWalletCaps)
    .where(eq(managedWalletCaps.userId, makerUserId))
    .limit(1))[0];

  if (!row) {
    return { ok: false, reason: "no managed wallet record" };
  }
  if (!row.enabled) {
    return { ok: false, reason: "managed wallet disabled" };
  }
  if (row.killed) {
    return { ok: false, reason: row.killReason ?? "killed" };
  }
  return { ok: true };
}

export function createDbDeps(): ShopSettlementDeps {
  return {
    async insertSettlement(input: ReserveRequest & { uuid: string; reservedUntil: Date }) {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const row: InsertShopSettlement = {
        settlementUuid: input.uuid,
        adId: input.adId,
        makerUserId: input.makerUserId,
        takerUserId: input.takerUserId,
        sellToken: input.sellToken,
        buyToken: input.buyToken,
        sellAmountRaw: input.sellAmountRaw,
        buyAmountRaw: input.buyAmountRaw,
        sellDecimals: input.sellDecimals,
        buyDecimals: input.buyDecimals,
        rateUsed: input.rateUsed,
        makerAddress: input.makerAddress.toLowerCase(),
        takerAddress: input.takerAddress.toLowerCase(),
        status: "quoted",
        reservedUntil: input.reservedUntil,
      };

      const result = await db.insert(shopSettlements).values(row);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = ((result as any).insertId ?? (result as any)[0]?.insertId) as number;
      return { id };
    },

    async advanceStatus(
      settlementId: number,
      expectedFrom: ShopSettlementStatus,
      to: ShopSettlementStatus,
      extra,
    ) {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      // Optimistic concurrency: only update if current status matches expected.
      // Returns affectedRows; if 0, the transition was racey or already advanced.
      const updateFields: {
        status: ShopSettlementStatus;
        failureCode?: string;
        failureDetail?: string;
        completedAt?: Date;
      } = {
        status: to,
      };
      if (extra?.failureCode !== undefined) updateFields.failureCode = extra.failureCode;
      if (extra?.failureDetail !== undefined) updateFields.failureDetail = extra.failureDetail;
      if (extra?.completedAt !== undefined) updateFields.completedAt = extra.completedAt;

      const result = await db
        .update(shopSettlements)
        .set(updateFields)
        .where(
          and(
            eq(shopSettlements.id, settlementId),
            eq(shopSettlements.status, expectedFrom),
          ),
        );

      // Drizzle MySQL driver returns affectedRows on the result header.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const affected = (result as any).rowsAffected ?? (result as any)[0]?.affectedRows ?? 0;
      return affected > 0;
    },

    async insertLeg(input) {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const result = await db.insert(shopSettlementLegs).values({
        settlementId: input.settlementId,
        legNumber: input.legNumber,
        legKind: input.legKind as LegKind,
        settlementEndpoint: input.settlementEndpoint as SettlementEndpoint,
        idempotencyKey: input.idempotencyKey,
        signerAddress: input.signerAddress.toLowerCase(),
        signerRole: input.signerRole as SignerRole,
        status: "pending_signature",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = ((result as any).insertId ?? (result as any)[0]?.insertId) as number;
      return { id };
    },

    async updateLeg(legId, fields) {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const updateFields: Partial<{
        status: LegStatus;
        txHash: string;
        blockNumber: number;
        gasUsed: number;
        failureCode: string;
        failureDetail: string;
        broadcastAt: Date;
        confirmedAt: Date;
      }> = {};
      if (fields.status !== undefined) updateFields.status = fields.status;
      if (fields.txHash !== undefined) updateFields.txHash = fields.txHash;
      if (fields.blockNumber !== undefined) updateFields.blockNumber = fields.blockNumber;
      if (fields.gasUsed !== undefined) updateFields.gasUsed = fields.gasUsed;
      if (fields.failureCode !== undefined) updateFields.failureCode = fields.failureCode;
      if (fields.failureDetail !== undefined) updateFields.failureDetail = fields.failureDetail;
      if (fields.broadcastAt !== undefined) updateFields.broadcastAt = fields.broadcastAt;
      if (fields.confirmedAt !== undefined) updateFields.confirmedAt = fields.confirmedAt;

      await db
        .update(shopSettlementLegs)
        .set(updateFields)
        .where(eq(shopSettlementLegs.id, legId));
    },

    async loadSettlement(idOrUuid: number | string): Promise<SettlementSnapshot | null> {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const settlement = typeof idOrUuid === "number"
        ? (await db.select().from(shopSettlements).where(eq(shopSettlements.id, idOrUuid)).limit(1))[0]
        : (await db.select().from(shopSettlements).where(eq(shopSettlements.settlementUuid, idOrUuid)).limit(1))[0];

      if (!settlement) return null;

      const legs = await db
        .select()
        .from(shopSettlementLegs)
        .where(eq(shopSettlementLegs.settlementId, settlement.id));

      return { settlement, legs };
    },
  };
}
