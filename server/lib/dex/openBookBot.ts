/**
 * ─── Open Book Bot (continuous maker loop) ───────────────────────────────────
 *
 * Keeps the the venue CLOB populated from the seeded shops, and KEEPS IT MOVING:
 * each cycle it re-checks every posted order — if an order has filled (or is no
 * longer live), it clears the link so a fresh order is posted right away. Run on
 * a short cron (~1-2 min) and you get a non-stop "post → fill → re-post" loop.
 *
 * This is the CLOB system (separate from P2P burst). It makes each seed shop's
 * defined swap ad real on the book via placeMakerOrder.
 *
 * D1 (inventory split CLOB vs P2P) — conservative default: only a capped SLICE
 * per ad is posted; the venue freezes the posted amount, the rest stays
 * vault_available for P2P. The split enforces itself via the venue's accounting.
 *
 * ⚠️ Honest note: on testnet there's little outside taker flow, so orders rarely
 * fill on their own — the loop is production-ready and re-posts the moment a
 * fill happens (real flow on mainnet, or a taker walking the book in a demo).
 */
import { and, eq, gte, lte } from "drizzle-orm";

import { getDb } from "../../db";
import { users, p2pAds } from "../../../drizzle/schema";
import { placeMakerOrder } from "./orderSigner";
import { getDexClient } from "./client";
import { getDecryptedDexCreds } from "./apiKey";

const SEED_TG_MIN = 90000001;
const SEED_TG_MAX = 90000022;
const FUNDED = new Set(["USDT", "USDC", "XSGD", "JPYC", "EURT"]);
const OPEN_BOOK_SLICE_CAP = 8000;
const MAX_POSTS_PER_CYCLE = 40;

export interface OpenBookResult {
  scanned: number;
  posted: number;
  refilled: number; // re-posted after a fill/gone
  stillLive: number;
  skipped: number;
  errors: Array<{ adId: number; reason: string }>;
}

/** Is this posted order still resting on the book? null = unknown (leave it). */
async function orderStillLive(orderId: string, creds: { apiKey: string; apiSecret: string } | null): Promise<boolean | null> {
  const client = getDexClient();
  try {
    const res = await fetch(`${client.base}/orders/${encodeURIComponent(orderId)}`, {
      headers: {
        Accept: "application/json",
        ...(creds ? { Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}` } : {}),
      },
    });
    if (res.status === 404) return false; // gone
    if (!res.ok) return null; // unknown — don't touch
    const j = (await res.json()) as { status?: string; remaining_amount?: string };
    const status = (j.status ?? "").toLowerCase();
    if (["filled", "cancelled", "canceled", "closed", "expired"].includes(status)) return false;
    if (j.remaining_amount !== undefined && Number(j.remaining_amount) <= 0) return false;
    return true; // open / pending / partially filled
  } catch {
    return null; // network hiccup — leave it
  }
}

/**
 * One loop tick: re-check posted orders (clear filled/gone ones), then post a
 * fresh real order for every shop swap ad that isn't currently on the book.
 */
export async function runOpenBookCycle(): Promise<OpenBookResult> {
  const result: OpenBookResult = { scanned: 0, posted: 0, refilled: 0, stillLive: 0, skipped: 0, errors: [] };
  const db = await getDb();
  if (!db) return result;

  // Live-mid pricing: quote at the current FX oracle mid (± a small maker spread)
  // so the book tracks the real market and visibly moves, instead of a static
  // seed rate. Build a token→currency map + an in-cycle FX cache.
  const client = getDexClient();
  const ccyOf: Record<string, string> = {};
  try {
    const tk = await client.getTokens();
    for (const t of (tk.tokens ?? []) as Array<{ symbol: string; currency: string }>) ccyOf[t.symbol] = t.currency;
  } catch { /* fall back to seed rates */ }
  const fxCache = new Map<string, number | null>();
  const MAKER_SPREAD_BPS = 8; // ask a touch above mid (the shop's margin)
  async function liveRate(fromSym: string, toSym: string, fallback: number): Promise<number> {
    const fc = ccyOf[fromSym], tc = ccyOf[toSym];
    if (!fc || !tc) return fallback;
    if (fc === tc) return 1 * (1 + MAKER_SPREAD_BPS / 10000); // same-fiat ~peg + margin
    const key = `${fc}/${tc}`;
    if (!fxCache.has(key)) {
      try {
        const fx = await client.getFxRate(fc, tc);
        fxCache.set(key, fx ? Number(fx.rate) : null);
      } catch { fxCache.set(key, null); }
    }
    const mid = fxCache.get(key);
    return mid && mid > 0 ? mid * (1 + MAKER_SPREAD_BPS / 10000) : fallback;
  }

  const shops = await db
    .select({ id: users.id, addr: users.walletAddress })
    .from(users)
    .where(and(gte(users.telegramId, String(SEED_TG_MIN)), lte(users.telegramId, String(SEED_TG_MAX))));

  for (const shop of shops) {
    if (result.posted >= MAX_POSTS_PER_CYCLE) break;
    if (!shop.addr) continue;
    const creds = await getDecryptedDexCreds(shop.id);

    const ads = await db
      .select()
      .from(p2pAds)
      .where(and(eq(p2pAds.posterId, shop.id), eq(p2pAds.status, "active")));

    for (const ad of ads) {
      if (result.posted >= MAX_POSTS_PER_CYCLE) break;
      if (ad.adType !== "swap" || !FUNDED.has(ad.fromToken)) continue;
      result.scanned++;

      // 1. If it has a live order, re-check it. Clear the link if it's gone.
      let needsPost = !ad.settlementOrderId;
      let isRefill = false;
      if (ad.settlementOrderId) {
        const live = await orderStillLive(ad.settlementOrderId, creds);
        if (live === false) {
          await db.update(p2pAds).set({ settlementOrderId: null, settlementOrderUuidInt: null, settlementOrderStatus: "settled" }).where(eq(p2pAds.id, ad.id));
          needsPost = true;
          isRefill = true;
        } else {
          result.stillLive++;
          continue; // still resting — nothing to do
        }
      }

      // 2. Post a fresh real order.
      if (!needsPost) continue;
      const liquidity = Math.min(Number(ad.liquidity), OPEN_BOOK_SLICE_CAP);
      const rate = await liveRate(ad.fromToken, ad.toToken, Number(ad.rate));
      const placed = await placeMakerOrder({
        userId: shop.id,
        ownerAddress: shop.addr,
        fromSymbol: ad.fromToken,
        toSymbol: ad.toToken,
        liquidity,
        rate,
      });
      if (placed.ok) {
        await db
          .update(p2pAds)
          .set({ settlementOrderId: placed.orderId, settlementOrderUuidInt: placed.uuidInt, settlementOrderStatus: "pending" })
          .where(eq(p2pAds.id, ad.id));
        result.posted++;
        if (isRefill) result.refilled++;
      } else {
        result.skipped++;
        result.errors.push({ adId: ad.id, reason: `${placed.code}: ${placed.detail}` });
      }
    }
  }
  return result;
}
