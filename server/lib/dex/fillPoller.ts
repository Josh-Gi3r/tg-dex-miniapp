/**
 * ─── Cross-Channel Fill Poller ───────────────────────────────────────────────
 *
 * Once a maker's order is live on the venue (`p2pAds.settlementOrderId` set), any
 * trader on the web app or any other venue-integrated app can fill it.
 * The TG mini-app's "Take offer" path is just one of many entry points.
 *
 * This worker reconciles state by polling the venue for every active ad we
 * have a `settlementOrderId` for. When the poller detects new fills (i.e.
 * the venue's `filled_base_amount` exceeds what we've already recorded in
 * `p2pOrders`), it:
 *   - inserts a synthetic `p2pOrders` row so the maker sees the fill in
 *     History and MeTab balance reads stay honest
 *   - decrements `liquidityRemaining` on the ad
 *   - updates `settlementOrderStatus` when the venue marks the order settled or
 *     cancelled
 *
 * Auth: there's no service API key. We read each ad's poster, decrypt
 * their the venue creds, and call `GET /orders/{id}` per ad. Same pattern as
 * every other per-user the venue call in the codebase.
 *
 * Run via `POST /internal/fills/run` from cron-job.org (60s cadence).
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "../../db";
import { p2pAds, p2pOrders } from "../../../drizzle/schema";
import { getDexClient } from "./client";
import { getDecryptedDexCreds } from "./apiKey";

export interface FillCycleResult {
  startedAt: Date;
  endedAt: Date;
  adsScanned: number;
  adsUpdated: number;
  fillsInserted: number;
  errors: string[];
}

interface VenueOrderResponse {
  trade_id: string;
  status: "pending" | "matched" | "settled" | "failed" | "cancelled";
  filled_base_amount?: string | null;
  filled_quote_amount?: string | null;
  remaining_amount?: string | null;
  settlement_summary?: {
    status?: string | null;
    latest_tx_hash?: string | null;
  } | null;
}

const finite = (s: string | null | undefined, fallback = 0): number => {
  if (s == null) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

export async function runFillCycle(): Promise<FillCycleResult> {
  const startedAt = new Date();
  const result: FillCycleResult = {
    startedAt,
    endedAt: startedAt,
    adsScanned: 0,
    adsUpdated: 0,
    fillsInserted: 0,
    errors: [],
  };

  try {
    const db = await getDb();
    if (!db) {
      result.errors.push("db unavailable");
      result.endedAt = new Date();
      return result;
    }

    // Active set: any ad that still has a the venue order id and the venue-side
    // status that could still see fills. We deliberately leave 'settled'
    // and terminal statuses alone — they no longer move.
    const activeAds = await db
      .select()
      .from(p2pAds)
      .where(
        and(
          isNotNull(p2pAds.settlementOrderId),
          inArray(p2pAds.settlementOrderStatus, ["pending", "matched"]),
        ),
      );

    result.adsScanned = activeAds.length;
    if (activeAds.length === 0) {
      result.endedAt = new Date();
      return result;
    }

    const client = getDexClient();

    for (const ad of activeAds) {
      try {
        const creds = await getDecryptedDexCreds(ad.posterId);
        if (!creds) {
          // Maker hasn't provisioned a venue API key. Skip rather than
          // logging — common in the demo where users haven't connected
          // a wallet yet.
          continue;
        }
        const res = await fetch(
          `${client.base}/orders/${encodeURIComponent(ad.settlementOrderId!)}`,
          {
            headers: {
              Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
              Accept: "application/json",
            },
          },
        );
        if (!res.ok) {
          result.errors.push(`ad ${ad.id}: /orders ${res.status}`);
          continue;
        }
        const body = (await res.json()) as VenueOrderResponse;

        // Reconcile fills. liquidity - liquidityRemaining == "how much
        // we've already accounted for"; the venue's filled_base_amount is
        // authoritative. The delta is what arrived since last cycle.
        const accountedFill = finite(ad.liquidity as unknown as string)
          - finite(ad.liquidityRemaining as unknown as string);
        const totalFilled = finite(body.filled_base_amount, accountedFill);
        const delta = Math.max(0, totalFilled - accountedFill);

        const newStatus = body.status;
        let statusChanged = newStatus !== ad.settlementOrderStatus;
        let touched = false;

        if (delta > 0) {
          await db.insert(p2pOrders).values({
            adId: ad.id,
            changerId: ad.changerId ?? ad.posterId,
            takerId: null, // External channel — we don't know the taker
            fromToken: ad.fromToken,
            toToken: ad.toToken,
            fromAmount: String(delta),
            toAmount: String(delta * finite(ad.rate as unknown as string, 0)),
            rateUsed: ad.rate as unknown as string,
            adType: "swap",
            status: "filled",
            txHash: body.settlement_summary?.latest_tx_hash ?? null,
            settlementOrderId: ad.settlementOrderId,
            filledAt: new Date(),
          });
          result.fillsInserted += 1;

          const newRemaining = Math.max(
            0,
            finite(ad.liquidityRemaining as unknown as string) - delta,
          );
          await db
            .update(p2pAds)
            .set({
              liquidityRemaining: String(newRemaining),
              totalFills: (ad.totalFills ?? 0) + 1,
              settlementOrderStatus: newStatus,
            })
            .where(eq(p2pAds.id, ad.id));
          touched = true;
        } else if (statusChanged) {
          await db
            .update(p2pAds)
            .set({ settlementOrderStatus: newStatus })
            .where(eq(p2pAds.id, ad.id));
          touched = true;
        }

        if (touched) result.adsUpdated += 1;
      } catch (err) {
        result.errors.push(
          `ad ${ad.id}: ${(err as Error).message ?? String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(
      `cycle failed: ${(err as Error).message ?? String(err)}`,
    );
  }

  result.endedAt = new Date();
  return result;
}
