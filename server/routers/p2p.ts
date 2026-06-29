/**
 * P2P Marketplace Router
 *
 * Full lifecycle of P2P liquidity ads:
 *   - Browse ads (swap / buy / sell modes)
 *   - Post new ads (any authenticated user)
 *   - Cancel own ads
 *   - Execute swap against an active ad (demo: instant simulated settlement)
 *   - View trader profiles
 *   - My ads and my order history
 *
 * Ad types:
 *   swap = stablecoin-to-stablecoin (MAIN FOCUS, instant on-chain settlement)
 *   buy  = on-ramp fiat->stablecoin
 *   sell = off-ramp stablecoin->fiat
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  p2pAds,
  p2pOrders,
  changerProfiles,
  users,
  transactions,
  ratings,
  promotions,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { sendMessage } from "../lib/telegram";
import { assertRateLimit } from "../lib/production";
import { eq, desc, and, lte, gte, or, sql } from "drizzle-orm";
import { getDexClient } from "../lib/dex/client";
import { getDecryptedDexCreds } from "../lib/dex/apiKey";
import { signAndBroadcastDeposit } from "../lib/dex/walletSigner";
import { signAndCancelOrder } from "../lib/dex/orderCanceller";

// DEMO_ADS array, DEMO_MODE flag, DemoAd type, sortDemoAds, promotionRank
// helper, tagDemo helper — all deleted in audit-v4 round. The previous
// DEMO_MODE === false force-disable still left ~360 lines of demo data
// in source as a footgun (one accidental flip → fake "DuongNguyenSwap" /
// "SGD_Liquidity_Pro" 99%+ completion-rate changers go live). Now there
// is no demo path at all. listAds returns [] when the DB is empty.

// Ensure the maker has a changer profile so their ads display with a real
// shop name + handle + reputation row instead of falling back to
// "Anonymous" via the leftJoin in listAds. Auto-creates one on first ad
// with sensible defaults pulled from the user record; subsequent calls
// just return the existing profile id.
async function ensureChangerProfile(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  user: { id: number; name?: string | null; telegramUsername?: string | null },
): Promise<number> {
  const existing = await db
    .select({ id: changerProfiles.id })
    .from(changerProfiles)
    .where(eq(changerProfiles.userId, user.id))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const fallbackName =
    user.name?.trim() ||
    (user.telegramUsername ? `@${user.telegramUsername}` : null) ||
    `Trader #${user.id}`;
  const [inserted] = await db.insert(changerProfiles).values({
    userId: user.id,
    displayName: fallbackName.slice(0, 64),
    telegramHandle: user.telegramUsername ?? null,
    isActive: true,
  });
  return Number(inserted.insertId);
}
import {
  placeOrderInternal,
  markPaidInternal,
  confirmReceivedInternal,
  raiseDisputeInternal,
} from "./p2p-actions";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const p2pRouter = router({
  /**
   * List active ads filtered by type, tokens, and optional amount.
   * Returns DB ads when available, falls back to demo seed data.
   */
  listAds: publicProcedure
    .input(
      z.object({
        adType: z.enum(["swap", "buy", "sell"]).default("swap"),
        fromToken: z.string().default("USDT"),
        toToken: z.string().optional(),
        amount: z.number().optional(),
        limit: z.number().min(1).max(100).default(30),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        return { ads: [], source: "live" as const };
      }

      try {
        const dbAds = await db
          .select({
            ad: p2pAds,
            poster: {
              displayName: changerProfiles.displayName,
              telegramHandle: changerProfiles.telegramHandle,
              completionRate: changerProfiles.completionRate,
              completionRate30d: changerProfiles.completionRate30d,
              totalOrdersFilled: changerProfiles.totalOrdersFilled,
              totalOrders30d: changerProfiles.totalOrders30d,
              avgSettlementMinutes: changerProfiles.avgSettlementMinutes,
              avgRating: changerProfiles.avgRating,
              location: changerProfiles.location,
            },
          })
          .from(p2pAds)
          .leftJoin(changerProfiles, eq(p2pAds.changerId, changerProfiles.id))
          .where(
            and(
              eq(p2pAds.adType, input.adType),
              eq(p2pAds.fromToken, input.fromToken),
              eq(p2pAds.status, "active"),
              input.toToken ? eq(p2pAds.toToken, input.toToken) : undefined,
              input.amount
                ? and(
                    lte(p2pAds.minOrder, String(input.amount)),
                    gte(p2pAds.maxOrder, String(input.amount))
                  )
                : undefined
            )
          )
          // Explicit promotion rank — the prior `desc(promotionTier)` sorted
          // the enum string alphabetically (pinned, none, highlighted, boosted)
          // which is wrong. Real priority: pinned > highlighted > boosted > none.
          // v1 audit finding #5.
          .orderBy(
            desc(sql`CASE ${p2pAds.promotionTier}
              WHEN 'pinned' THEN 4
              WHEN 'highlighted' THEN 3
              WHEN 'boosted' THEN 2
              ELSE 1
            END`),
            desc(p2pAds.totalFills),
          )
          .limit(input.limit);

        if (dbAds.length > 0) {
          return {
            ads: dbAds.map((row) => ({
              id: String(row.ad.id),
              posterId: row.ad.posterId,
              adType: row.ad.adType,
              fromToken: row.ad.fromToken,
              toToken: row.ad.toToken,
              rate: parseFloat(row.ad.rate),
              liquidity: parseFloat(row.ad.liquidity),
              liquidityRemaining: parseFloat(row.ad.liquidityRemaining),
              minOrder: parseFloat(row.ad.minOrder),
              maxOrder: parseFloat(row.ad.maxOrder),
              terms: row.ad.terms,
              status: row.ad.status,
              totalFills: row.ad.totalFills,
              promotionTier: row.ad.promotionTier,
              isDemo: false as const,
              poster: row.poster ?? {
                displayName: "Anonymous",
                telegramHandle: null,
                completionRate: 100,
                completionRate30d: 100,
                totalOrdersFilled: 0,
                totalOrders30d: 0,
                avgSettlementMinutes: 2,
                avgRating: 5,
                location: null,
              },
            })),
            source: "live" as const,
          };
        }
      } catch {
        // fall through
      }

      return { ads: [], source: "live" as const };
    }),

  /**
   * shopRoutes — every active shop ad as a SWAP route (taker POV) + the changer's
   * reputation, so the Swap can offer/recommend a TRUSTED shop alongside the cold
   * CLOB swap (the whole point: a person you trust, rate, chat — not an anonymous
   * fill). A shop ad (changer SELLS fromToken, taker PAYS toToken, ad.rate =
   * toToken-per-fromToken) serves a taker swap toToken→fromToken at 1/ad.rate.
   * Public, read-only. Settled by the P2P 3-leg burst, NOT the CLOB (INV-1).
   */
  shopRoutes: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { routes: [], tokens: [] as string[], fromTokens: [] as string[] };
    const rows = await db
      .select({
        ad: p2pAds,
        poster: {
          displayName: changerProfiles.displayName,
          telegramHandle: changerProfiles.telegramHandle,
          completionRate: changerProfiles.completionRate,
          totalOrdersFilled: changerProfiles.totalOrdersFilled,
          avgRating: changerProfiles.avgRating,
          location: changerProfiles.location,
        },
      })
      .from(p2pAds)
      .leftJoin(changerProfiles, eq(p2pAds.changerId, changerProfiles.id))
      .where(and(eq(p2pAds.adType, "swap"), eq(p2pAds.status, "active")))
      .limit(300);
    const routes = rows.map((r) => {
      const adRate = parseFloat(r.ad.rate); // toToken per fromToken
      const remaining = parseFloat(r.ad.liquidityRemaining); // fromToken units (the receive side)
      return {
        adId: Number(r.ad.id),
        from: r.ad.toToken, // taker pays
        to: r.ad.fromToken, // taker receives
        rate: adRate > 0 ? 1 / adRate : 0, // receive-per-pay (to per from)
        depthTo: remaining, // max receivable (in `to`)
        depthFrom: remaining * adRate, // max payable (in `from`)
        minOrder: parseFloat(r.ad.minOrder), // in `to` (fromToken) units
        maxOrder: parseFloat(r.ad.maxOrder),
        changer: {
          name: r.poster?.displayName ?? "Shop",
          handle: r.poster?.telegramHandle ?? null,
          rating: r.poster?.avgRating != null ? Number(r.poster.avgRating) : null,
          trades: r.poster?.totalOrdersFilled ?? 0,
          completionRate: r.poster?.completionRate != null ? Number(r.poster.completionRate) : null,
          location: r.poster?.location ?? null,
        },
      };
    });
    const tokens = [...new Set(routes.flatMap((r) => [r.from, r.to]))].sort();
    const fromTokens = [...new Set(routes.map((r) => r.from))].sort();
    return { routes, tokens, fromTokens };
  }),

  /** Get all unique token pairs available for a given ad type */
  getAvailablePairs: publicProcedure
    .input(z.object({ adType: z.enum(["swap", "buy", "sell"]).default("swap") }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (db) {
        try {
          const rows = await db
            .select({
              fromToken: p2pAds.fromToken,
              toToken: p2pAds.toToken,
            })
            .from(p2pAds)
            .where(and(eq(p2pAds.adType, input.adType), eq(p2pAds.status, "active")));
          const seen = new Set<string>();
          const live = rows.filter((r) => {
            const key = `${r.fromToken}:${r.toToken}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return live;
        } catch {
          /* fall through */
        }
      }

      return [];
    }),

  /**
   * Get a trader profile by Telegram handle.
   *
   * Demo-handle lookup deleted with DEMO_ADS. Wire to real changer_profiles
   * lookup by telegramHandle when the profile page needs it. For now returns
   * an empty profile shape so the client can render the empty state.
   */
  getTraderProfile: publicProcedure
    .input(z.object({ handle: z.string() }))
    .query(async ({ input }): Promise<{
      profile: {
        displayName: string;
        telegramHandle: string | null;
        completionRate: number;
        completionRate30d: number;
        totalOrdersFilled: number;
        totalOrders30d: number;
        avgSettlementMinutes: number;
        avgRating: number;
        location: string | null;
      } | null;
      ads: Array<{
        id: string;
        adType: "swap" | "buy" | "sell";
        fromToken: string;
        toToken: string;
        rate: number;
        minOrder: number;
        maxOrder: number;
      }>;
      feedback: Array<{ score: number; comment: string | null; createdAt: Date }>;
      source: "empty";
    } | null> => {
      void input;
      return {
        profile: null,
        ads: [],
        feedback: [],
        source: "empty" as const,
      };
    }),

  /**
   * Post a new P2P ad. Any authenticated user can post.
   *
   * For "swap" ads, the maker is expected to have already placed the order
   * on the venue (via runMarketMakerSetup) and pass the resulting settlementOrderId/
   * uuidInt through here so the row reflects the live on-chain state. When
   * absent, the row is created in legacy DB-only mode.
   */
  postAd: protectedProcedure
    .input(
      z.object({
        adType: z.enum(["swap", "buy", "sell"]),
        fromToken: z.string().min(1).max(16),
        toToken: z.string().min(1).max(16),
        rate: z.number().positive(),
        liquidity: z.number().positive(),
        minOrder: z.number().positive(),
        maxOrder: z.number().positive(),
        terms: z.string().max(500).optional(),
        paymentMethods: z.array(z.string()).optional(),
        settlementOrderId: z.string().optional(),
        settlementOrderUuidInt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.minOrder > input.maxOrder)
        throw new Error("Minimum order cannot exceed maximum order.");
      if (input.minOrder > input.liquidity)
        throw new Error("Minimum order cannot exceed total liquidity.");

      const db = await getDb();
      if (!db)
        return { success: true, adId: `sim_${Date.now()}`, simulated: true };

      const changerId = await ensureChangerProfile(db, ctx.user);
      const [inserted] = await db.insert(p2pAds).values({
        posterId: ctx.user.id,
        changerId,
        adType: input.adType,
        fromToken: input.fromToken,
        toToken: input.toToken,
        rate: String(input.rate),
        liquidity: String(input.liquidity),
        liquidityRemaining: String(input.liquidity),
        minOrder: String(input.minOrder),
        maxOrder: String(input.maxOrder),
        terms: input.terms ?? null,
        paymentMethods: input.paymentMethods
          ? JSON.stringify(input.paymentMethods)
          : null,
        status: "active",
        settlementOrderId: input.settlementOrderId ?? null,
        settlementOrderUuidInt: input.settlementOrderUuidInt ?? null,
        settlementOrderStatus: input.settlementOrderId ? "pending" : null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      return {
        success: true,
        adId: String(inserted.insertId),
        simulated: false,
      };
    }),

  /**
   * postAdLive — the REAL, vault-backed maker flow (server-orchestrated).
   *
   * A P2P shop ad is an app-DB offer backed by the maker's vault_available and
   * settled by the 3-leg burst — it is NOT a the venue CLOB order (INV-1: CLOB ≠ P2P
   * shops; INV-5: don't double-commit inventory). So, unlike `postAd` (bare DB row):
   *   1. checks the maker's the venue vault for `fromToken` inventory,
   *   2. deposits the shortfall from their wallet if needed (approve+deposit) so
   *      vault_available actually backs the offer,
   *   3. inserts the ad (status active, NO settlementOrderId — vault_available-backed).
   *
   * It does NOT post a the venue /orders limit order — that would freeze the inventory
   * (starving the burst) and leak it to the anonymous CLOB. CLOB liquidity is the
   * Open Book Bot's separate job. Testnet/imported-key flow: server signs deposits
   * with the maker's managed wallet.
   */
  postAdLive: protectedProcedure
    .input(
      z.object({
        fromToken: z.string().min(1).max(16),
        toToken: z.string().min(1).max(16),
        rate: z.number().positive(),
        liquidity: z.number().positive(),
        minOrder: z.number().positive(),
        maxOrder: z.number().positive(),
        terms: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(ctx.user.id, "postAd", 5);
      if (input.minOrder > input.maxOrder)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Minimum order cannot exceed maximum order." });
      if (input.minOrder > input.liquidity)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Minimum order cannot exceed total liquidity." });
      if (ENV.featureMainnet)
        throw new TRPCError({ code: "FORBIDDEN", message: "Vault-backed ads are testnet-only for now." });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Database unavailable" });

      const owner = ctx.user.walletAddress;
      if (!owner)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Import a wallet first (Me → Wallet) before creating a shop." });

      // 1. Resolve fromToken + read the maker's vault inventory.
      const client = getDexClient();
      const creds = await getDecryptedDexCreds(ctx.user.id);
      if (!creds)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Venue API key not provisioned — re-import your wallet." });
      const tokensRes = await client.getTokens();
      const tokens = (tokensRes as { tokens?: Array<{ symbol: string; address: string; decimals: number }> }).tokens
        ?? (tokensRes as unknown as Array<{ symbol: string; address: string; decimals: number }>);
      const fromTok = tokens.find((t) => t.symbol === input.fromToken);
      if (!fromTok)
        throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown token ${input.fromToken}` });

      const balRes = await client.getBalances(owner.toLowerCase(), creds);
      const fromRow = balRes.balances.find((b) => (b as { symbol?: string }).symbol === input.fromToken);
      const vaultAvail = fromRow ? Number((fromRow as { vault_available: string }).vault_available) / 10 ** fromTok.decimals : 0;

      // 2. Deposit the shortfall (wallet → vault) so the order is fully backed.
      if (vaultAvail < input.liquidity) {
        const shortfall = input.liquidity - vaultAvail;
        const shortfallRaw = (BigInt(Math.ceil(shortfall * 10 ** fromTok.decimals))).toString();
        const dep = await signAndBroadcastDeposit({
          userId: ctx.user.id,
          ownerAddress: owner,
          tokenAddress: fromTok.address,
          amountRaw: shortfallRaw,
        });
        if (!dep.ok)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Couldn't fund your vault with ${input.fromToken}: ${dep.detail}. Make sure your wallet holds enough ${input.fromToken}.`,
          });
      }

      // 3. Insert the ad — vault_available-backed, with NO the venue CLOB order.
      //    A P2P shop ad is an app-DB offer settled by the 3-leg burst against
      //    the maker's vault_available (reserve checks vault_available; the burst
      //    leg 2 withdraws from the vault to the taker). It MUST NOT post a the venue
      //    /orders limit order, because that would:
      //      (a) freeze the inventory (vault_frozen) so the burst can't withdraw
      //          it — the order and the burst fight over the same funds [INV-5
      //          double-commit; reserve would fail MAKER_INSUFFICIENT_VAULT], and
      //      (b) leak the shop's inventory to the anonymous CLOB where ANY external
      //          taker could fill it — defeating identity-locked P2P [INV-1: CLOB
      //          ≠ P2P shops, never conflate].
      //    CLOB liquidity is the Open Book Bot's job (a separate capped slice for
      //    the rates board, per D1), not the shop. The deposit above funded
      //    vault_available; that is what backs this ad.
      const changerId = await ensureChangerProfile(db, ctx.user);
      const [inserted] = await db.insert(p2pAds).values({
        posterId: ctx.user.id,
        changerId,
        adType: "swap",
        fromToken: input.fromToken,
        toToken: input.toToken,
        rate: String(input.rate),
        liquidity: String(input.liquidity),
        liquidityRemaining: String(input.liquidity),
        minOrder: String(input.minOrder),
        maxOrder: String(input.maxOrder),
        terms: input.terms ?? null,
        status: "active",
        // Vault_available-backed; NOT a CLOB order — no the venue order id.
        settlementOrderId: null,
        settlementOrderUuidInt: null,
        settlementOrderStatus: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      return {
        success: true,
        adId: String(inserted.insertId),
        vaultBacked: true,
      };
    }),

  /**
   * Phase A3 — partial-failure recovery for the market-maker setup flow.
   *
   * Three-step lifecycle:
   *   draftAd (status='paused', no deposit yet)
   *   → commitDeposit (records settlementDepositTxHash, still paused)
   *   → commitOrder (records settlementOrderId/UuidInt, status='active')
   *
   * If commitOrder fails (e.g. /orders 5xx), the row stays paused with
   * the deposit hash set — MyAdsSection surfaces a "Retry placement"
   * CTA so the user can re-sign + re-submit without re-depositing.
   *
   * The legacy postAd above bypasses this lifecycle for demo mode and
   * for ads that don't sit on the the venue book (fiat ramps).
   */
  draftAd: protectedProcedure
    .input(
      z.object({
        adType: z.literal("swap"),
        fromToken: z.string().min(1).max(16),
        toToken: z.string().min(1).max(16),
        rate: z.number().positive(),
        liquidity: z.number().positive(),
        minOrder: z.number().positive(),
        maxOrder: z.number().positive(),
        terms: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.minOrder > input.maxOrder)
        throw new Error("Minimum order cannot exceed maximum order.");
      if (input.minOrder > input.liquidity)
        throw new Error("Minimum order cannot exceed total liquidity.");
      const db = await getDb();
      if (!db) return { adId: -1, simulated: true };
      const changerId = await ensureChangerProfile(db, ctx.user);
      const [inserted] = await db.insert(p2pAds).values({
        posterId: ctx.user.id,
        changerId,
        adType: input.adType,
        fromToken: input.fromToken,
        toToken: input.toToken,
        rate: String(input.rate),
        liquidity: String(input.liquidity),
        liquidityRemaining: String(input.liquidity),
        minOrder: String(input.minOrder),
        maxOrder: String(input.maxOrder),
        terms: input.terms ?? null,
        // Draft rows are paused until commitOrder succeeds — they don't
        // appear in the Browse list, so an abandoned draft is invisible.
        status: "paused",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      return { adId: Number(inserted.insertId), simulated: false };
    }),

  commitDeposit: protectedProcedure
    .input(
      z.object({
        adId: z.number().int().positive(),
        depositTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { success: true, simulated: true };
      await db
        .update(p2pAds)
        .set({ settlementDepositTxHash: input.depositTxHash })
        .where(
          and(eq(p2pAds.id, input.adId), eq(p2pAds.posterId, ctx.user.id)),
        );
      return { success: true, simulated: false };
    }),

  commitOrder: protectedProcedure
    .input(
      z.object({
        adId: z.number().int().positive(),
        settlementOrderId: z.string(),
        settlementOrderUuidInt: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { success: true, simulated: true };
      await db
        .update(p2pAds)
        .set({
          status: "active",
          settlementOrderId: input.settlementOrderId,
          settlementOrderUuidInt: input.settlementOrderUuidInt,
          settlementOrderStatus: "pending",
        })
        .where(
          and(eq(p2pAds.id, input.adId), eq(p2pAds.posterId, ctx.user.id)),
        );
      return { success: true, simulated: false };
    }),

  /** Returns ads that need user attention: deposit succeeded but order
   *  placement never completed. UI surfaces a "Retry placement" CTA. */
  pendingPlacementAds: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(p2pAds)
      .where(
        and(
          eq(p2pAds.posterId, ctx.user.id),
          eq(p2pAds.status, "paused"),
        ),
      );
  }),

  /**
   * Cancel an active ad. Only the poster can cancel.
   *
   * If the ad has a the venue order attached, the client is expected to have
   * already signed and submitted the CancelOrder via runMarketMakerCancel
   * before calling this. the venue's 5-min cooldown is surfaced through the
   * dex.ordersCancel procedure.
   */
  cancelAd: protectedProcedure
    .input(z.object({ adId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { success: true, simulated: true };
      const ad = (await db.select().from(p2pAds)
        .where(and(eq(p2pAds.id, input.adId), eq(p2pAds.posterId, ctx.user.id))).limit(1))[0];
      if (!ad) return { success: false, simulated: false };
      // Best-effort: actually cancel the resting the venue order so it doesn't keep
      // sitting on the book after the ad is gone (cooldown 429s are tolerated —
      // the order will be cleaned up on a later pass / expiry).
      let orderCancelled: boolean | null = null;
      if (ad.settlementOrderId && ad.settlementOrderUuidInt && ctx.user.walletAddress) {
        const c = await signAndCancelOrder({
          userId: ctx.user.id, ownerAddress: ctx.user.walletAddress,
          orderId: ad.settlementOrderId, uuidInt: ad.settlementOrderUuidInt,
        });
        orderCancelled = c.ok;
      }
      await db.update(p2pAds)
        .set({ status: "cancelled", settlementOrderStatus: "cancelled" })
        .where(and(eq(p2pAds.id, input.adId), eq(p2pAds.posterId, ctx.user.id)));
      return { success: true, simulated: false, orderCancelled };
    }),

  /**
   * editAd — edit one of the caller's ads. For a SWAP ad, changing the rate or
   * liquidity can't mutate a resting CLOB order, so we cancel the old the venue order
   * and post a fresh one at the new price (respecting the venue's 5-min cancel
   * cooldown). terms/min/max-only edits (and fiat ads) just update the row.
   */
  editAd: protectedProcedure
    .input(
      z.object({
        adId: z.number(),
        rate: z.number().positive().optional(),
        liquidity: z.number().positive().optional(),
        minOrder: z.number().positive().optional(),
        maxOrder: z.number().positive().optional(),
        terms: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Database unavailable" });
      const ad = (await db.select().from(p2pAds)
        .where(and(eq(p2pAds.id, input.adId), eq(p2pAds.posterId, ctx.user.id))).limit(1))[0];
      if (!ad) throw new TRPCError({ code: "NOT_FOUND", message: "Ad not found" });

      const liqChanged = input.liquidity != null && input.liquidity !== Number(ad.liquidity);
      const newRate = input.rate ?? Number(ad.rate);
      const newLiq = input.liquidity ?? Number(ad.liquidity);

      // A P2P shop ad is vault_available-backed and settled by the 3-leg burst —
      // it is NOT a the venue CLOB order (INV-1: CLOB ≠ P2P shops; INV-5: don't double-
      // commit inventory), exactly like postAdLive. So editing rate/liquidity must
      // NOT post a CLOB order (the old `placeMakerOrder` repost froze the maker's
      // vault → starved the burst → the next taker's reserve failed
      // MAKER_INSUFFICIENT_VAULT, AND leaked the shop's inventory to the anonymous
      // book). Instead we only:
      //   (a) cancel + clear any LEGACY on-book order a pre-fix ad still carries
      //       (frees frozen vault inventory back to vault_available), and
      //   (b) deposit the shortfall if the maker RAISED liquidity, so the new size
      //       is genuinely backed (same as postAdLive) — no cosmetic over-advertise.
      if (ad.adType === "swap") {
        const owner = ctx.user.walletAddress;

        // (a) Cancel any legacy CLOB order from before the vault-backed fix.
        if (ad.settlementOrderId && ad.settlementOrderUuidInt && owner) {
          const c = await signAndCancelOrder({ userId: ctx.user.id, ownerAddress: owner, orderId: ad.settlementOrderId, uuidInt: ad.settlementOrderUuidInt });
          if (!c.ok && c.code === "COOLDOWN")
            throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Your current order is in its 5-minute cooldown — try again in ~${Math.ceil((c.retryAfterSec ?? 300) / 60)} min.` });
          // A non-cooldown cancel failure (order already gone/expired) is non-fatal —
          // we still clear the linkage below so the ad becomes purely vault-backed.
        }

        // (b) If liquidity went UP, deposit the shortfall so vault_available backs it.
        if (liqChanged && newLiq > Number(ad.liquidity)) {
          if (!owner) throw new TRPCError({ code: "BAD_REQUEST", message: "Import a wallet first to add liquidity to your shop." });
          const client = getDexClient();
          const creds = await getDecryptedDexCreds(ctx.user.id);
          // Don't let a liquidity INCREASE proceed without backing it — that would
          // re-create the cosmetic over-advertise (ad claims more than the vault
          // holds). Match postAdLive: hard-fail rather than update the row.
          if (!creds)
            throw new TRPCError({ code: "BAD_REQUEST", message: "Venue API key not provisioned — re-import your wallet to add liquidity." });
          const tokensRes = await client.getTokens();
          const tokens = (tokensRes as { tokens?: Array<{ symbol: string; address: string; decimals: number }> }).tokens
            ?? (tokensRes as unknown as Array<{ symbol: string; address: string; decimals: number }>);
          const fromTok = tokens.find((t) => t.symbol === ad.fromToken);
          if (fromTok) {
            const balRes = await client.getBalances(owner.toLowerCase(), creds);
            const fromRow = balRes.balances.find((b) => (b as { symbol?: string }).symbol === ad.fromToken);
            const vaultAvail = fromRow ? Number((fromRow as { vault_available: string }).vault_available) / 10 ** fromTok.decimals : 0;
            if (vaultAvail < newLiq) {
              const shortfall = newLiq - vaultAvail;
              const shortfallRaw = (BigInt(Math.ceil(shortfall * 10 ** fromTok.decimals))).toString();
              const dep = await signAndBroadcastDeposit({ userId: ctx.user.id, ownerAddress: owner, tokenAddress: fromTok.address, amountRaw: shortfallRaw });
              if (!dep.ok)
                throw new TRPCError({ code: "BAD_REQUEST", message: `Couldn't fund your vault with ${ad.fromToken}: ${dep.detail}. Make sure your wallet holds enough ${ad.fromToken}.` });
            }
          }
        }
      }

      // Single DB update for all editable fields. No CLOB order is ever posted;
      // any legacy the venue order linkage is cleared so the ad is purely vault-backed.
      await db.update(p2pAds).set({
        ...(input.rate != null ? { rate: String(newRate) } : {}),
        ...(input.liquidity != null ? { liquidity: String(newLiq), liquidityRemaining: String(newLiq) } : {}),
        ...(input.minOrder != null ? { minOrder: String(input.minOrder) } : {}),
        ...(input.maxOrder != null ? { maxOrder: String(input.maxOrder) } : {}),
        ...(input.terms != null ? { terms: input.terms } : {}),
        ...((ad.settlementOrderId || ad.settlementOrderUuidInt) ? { settlementOrderId: null, settlementOrderUuidInt: null, settlementOrderStatus: null } : {}),
      }).where(eq(p2pAds.id, ad.id));
      return { success: true, reposted: false };
    }),

  /**
   * Phase 7 — Apply a paid promotion to one of the caller's ads.
   *
   * The client is expected to have already broadcast the USDT transfer from
   * the user's wallet to the treasury (dex.transferBuild → sign → dex.txSend),
   * and pass the resulting txHash here. We don't (yet) verify the on-chain
   * receipt server-side; that's a follow-up integration with the venue's /fills
   * indexer or with our own RPC. For now, the txHash is stored as audit trail.
   */
  purchasePromotion: protectedProcedure
    .input(
      z.object({
        adId: z.number().int().positive(),
        tier: z.enum(["boosted", "highlighted", "pinned"]),
        // USDT paid (human units, e.g. "5" for the Pinned 24h tier)
        amountUsdt: z.string(),
        // Duration in hours (defaults to 24h to match the on-screen pricing)
        durationHours: z.number().int().positive().default(24),
        // On-chain proof of payment to treasury wallet
        txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ENV.appTreasuryWallet) {
        throw new Error(
          "Treasury wallet not configured (APP_TREASURY_WALLET unset)",
        );
      }
      const db = await getDb();
      if (!db) {
        return { success: true, simulated: true };
      }

      // Verify ad ownership
      const adRows = await db
        .select({ id: p2pAds.id, posterId: p2pAds.posterId, changerId: p2pAds.changerId })
        .from(p2pAds)
        .where(and(eq(p2pAds.id, input.adId), eq(p2pAds.posterId, ctx.user.id)))
        .limit(1);
      const ad = adRows[0];
      if (!ad) throw new Error("Ad not found or not owned by caller");

      // Resolve the changerId to attach to the promotion. Fall back to the
      // user's first changer profile when the ad doesn't have one linked.
      let changerId = ad.changerId ?? null;
      if (!changerId) {
        const cp = await db
          .select({ id: changerProfiles.id })
          .from(changerProfiles)
          .where(eq(changerProfiles.userId, ctx.user.id))
          .limit(1);
        changerId = cp[0]?.id ?? null;
      }
      if (!changerId) {
        throw new Error("No changer profile linked to this user");
      }

      const startsAt = new Date();
      const endsAt = new Date(startsAt.getTime() + input.durationHours * 60 * 60 * 1000);

      await db.insert(promotions).values({
        changerId,
        tier: input.tier,
        paidAmountUsdt: input.amountUsdt,
        startsAt,
        endsAt,
        txHash: input.txHash,
      });

      await db
        .update(p2pAds)
        .set({ promotionTier: input.tier, promotionExpiresAt: endsAt })
        .where(eq(p2pAds.id, input.adId));

      return { success: true, simulated: false, endsAt };
    }),

  /**
   * Records a completed swap in our DB and awards XP. The on-chain settlement
   * is performed *before* this call by the client via:
   *   1. trpc.dex.swapQuote   — get quote + typed data
   *   2. signTypedData          — Privy
   *   3. trpc.dex.swapExecute  — submit signed payload, returns trade_id+tx_hash
   *   4. trpc.p2p.executeSwap   — record in our DB (this procedure)
   *
   * For backwards compatibility while FEATURE_PRIVY_AUTH is off, the server
   * accepts a missing `settlementTradeId`+`txHash` and falls back to the demo
   * behaviour of generating a deterministic placeholder. The placeholder is
   * clearly flagged with `simulated: true` so the UI never claims a fake
   * hash is real.
   */
  executeSwap: protectedProcedure
    .input(
      z.object({
        adId: z.string(),
        fromToken: z.string(),
        toToken: z.string(),
        fromAmount: z.number().positive(),
        toAmount: z.number().positive(),
        rateUsed: z.number().positive(),
        advertiserHandle: z.string().optional(),
        // Live-mode fields (provided by the the venue swap flow). When omitted we
        // generate a placeholder; never used in production once Privy is on.
        settlementTradeId: z.string().optional(),
        txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Legacy Privy-era recorder. Its only callers are the now-dead Privy swap
      // orchestrator (client/src/lib/dex/swap.ts); the live P2P take is the
      // vault-backed 3-leg burst (shopSettlement). Audit medium #11: this used to
      // trust client amounts AND fabricate a 0xsim_ placeholder flagged
      // `simulated`. Now it HARD-REQUIRES a real on-chain txHash — no placeholder,
      // no fake fill — so it can't write a phantom record or pollute the
      // leaderboard. Without a real settlement tx it's retired (use the burst).
      if (!input.txHash) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This trade path is retired — use the shop trade." });
      }
      const txHash = input.txHash;
      const simulated = false;

      const db = await getDb();
      if (!db)
        return {
          success: true,
          orderId: `sim_${Date.now()}`,
          txHash,
          simulated,
          xpEarned: 10,
        };

      // Resolve the real changerId from the ad being filled. Hardcoding 1 here
      // (the v1 bug — code-review audit blocker) attributed every the venue-book
      // swap to user id 1, breaking changer stats / ratings / leaderboards.
      // Numeric adId may come through as string from tRPC input.
      const numericAdId = Number(input.adId);
      let changerIdForOrder: number | null = null;
      if (Number.isFinite(numericAdId)) {
        const adRow = await db
          .select({ changerId: p2pAds.changerId, posterId: p2pAds.posterId })
          .from(p2pAds)
          .where(eq(p2pAds.id, numericAdId))
          .limit(1);
        if (adRow[0]) {
          changerIdForOrder = adRow[0].changerId ?? null;
          // Fall back to posterId's changer profile if the ad never bound a changer
          if (!changerIdForOrder && adRow[0].posterId) {
            const cp = await db
              .select({ id: changerProfiles.id })
              .from(changerProfiles)
              .where(eq(changerProfiles.userId, adRow[0].posterId))
              .limit(1);
            changerIdForOrder = cp[0]?.id ?? null;
          }
        }
      }
      if (!changerIdForOrder) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot resolve changer for adId ${input.adId} — refusing to record swap with unknown counterparty`,
        });
      }

      const [inserted] = await db.insert(p2pOrders).values({
        changerId: changerIdForOrder,
        takerId: ctx.user.id,
        fromToken: input.fromToken,
        toToken: input.toToken,
        fromAmount: String(input.fromAmount),
        toAmount: String(input.toAmount),
        rateUsed: String(input.rateUsed),
        status: "filled",
        txHash,
        settlementOrderId: input.settlementTradeId ?? null,
        filledAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      await db.insert(transactions).values({
        userId: ctx.user.id,
        type: "fill_order",
        fromToken: input.fromToken,
        toToken: input.toToken,
        fromAmount: String(input.fromAmount),
        toAmount: String(input.toAmount),
        txHash,
        status: "completed",
        xpEarned: 10,
      });

      await db
        .update(users)
        .set({ xp: ctx.user.xp + 10, totalTrades: ctx.user.totalTrades + 1 })
        .where(eq(users.id, ctx.user.id));

      return {
        success: true,
        orderId: String(inserted.insertId),
        txHash,
        simulated,
        xpEarned: 10,
      };
    }),

  /** Get the current user's posted ads */
  getMyAds: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(p2pAds)
      .where(eq(p2pAds.posterId, ctx.user.id))
      .orderBy(desc(p2pAds.createdAt))
      .limit(50);
  }),

  /** Get the current user's P2P trade history as taker */
  getMyOrders: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(p2pOrders)
      .where(eq(p2pOrders.takerId, ctx.user.id))
      .orderBy(desc(p2pOrders.createdAt))
      .limit(50);
  }),

  /** Place a real P2P order (P2P settlement or swap) */
  placeOrder: protectedProcedure
    .input(
      z.object({
        adId: z.number(),
        changerId: z.number(),
        fromToken: z.string(),
        toToken: z.string(),
        fromAmount: z.string(),
        toAmount: z.string().optional(),
        rateUsed: z.number(),
        spreadBps: z.number().optional(),
        adType: z.enum(["swap", "buy", "sell"]),
        fiatAmount: z.string().optional(),
        fiatCurrency: z.string().optional(),
        paymentMethod: z.string().optional(),
        advertiserHandle: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Legacy fiat (buy/sell) escrow lifecycle is DEPRECATED for v1 (SPEC §10.3)
      // and is broken on the live app: the client sends changerId:0 (poster.id is
      // never populated → orphaned, maker never notified — audit high #4), and the
      // escrow "release" had no real on-chain transfer (audit crit #1). Block it.
      // Real P2P = the 3-leg vault burst (shopSettlement.reserve + executeBurst).
      if (input.adType === "buy" || input.adType === "sell") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cash (fiat) P2P isn't available yet — trade a stablecoin shop instead.",
        });
      }
      const result = await placeOrderInternal({
        ...input,
        toAmount: input.toAmount ?? "0",
        takerId: ctx.user.id,
      });
      return { success: true, ...result };
    }),

  /** Taker marks fiat payment as sent → status: escrowed → payment_sent */
  markPaid: protectedProcedure
    .input(z.object({ orderId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await markPaidInternal({ orderId: input.orderId, userId: ctx.user.id });
      return { success: true };
    }),

  /**
   * Changer confirms fiat received → status: payment_sent → completed, escrow released.
   *
   * The on-chain stablecoin release is performed by the client BEFORE this
   * call (dex.transferBuild → sign via Privy → dex.txSend), and the resulting
   * txHash is passed through here. When omitted (Telegram bot inline-button
   * path) the order is marked completed in DB only — the changer is then
   * prompted to open the app to do the on-chain release.
   */
  confirmReceived: protectedProcedure
    .input(
      z.object({
        orderId: z.number(),
        releaseTxHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await confirmReceivedInternal({
        orderId: input.orderId,
        userId: ctx.user.id,
        releaseTxHash: input.releaseTxHash,
      });
      return { success: true };
    }),

  /** Either party raises a dispute → status: disputed */
  raiseDispute: protectedProcedure
    .input(z.object({ orderId: z.number(), reason: z.string().min(10).max(500) }))
    .mutation(async ({ ctx, input }) => {
      await raiseDisputeInternal({ orderId: input.orderId, userId: ctx.user.id, reason: input.reason });
      return { success: true };
    }),

  /** Get all active orders for the current user (as taker OR changer) */
  getActiveOrders: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const activeStatuses = ["pending", "escrowed", "payment_sent", "disputed"];
    // p2pOrders.changerId is a changer_profiles.id (NOT a userId) — audit crit #2.
    // Match the caller's OWN profile id for their maker-side orders.
    const myProfile = (await db.select({ id: changerProfiles.id }).from(changerProfiles).where(eq(changerProfiles.userId, ctx.user.id)).limit(1))[0];
    const allOrders = await db
      .select()
      .from(p2pOrders)
      .where(
        myProfile
          ? or(eq(p2pOrders.takerId, ctx.user.id), eq(p2pOrders.changerId, myProfile.id))
          : eq(p2pOrders.takerId, ctx.user.id)
      )
      .orderBy(desc(p2pOrders.createdAt))
      .limit(50);
    return allOrders.filter(o => activeStatuses.includes(o.status));
  }),

  /** Get a single order by ID (must be a party to the order) */
  getOrder: protectedProcedure
    .input(z.object({ orderId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      // p2pOrders.changerId is a changer_profiles.id (NOT a userId) — audit crit #2/#8.
      // Match the caller's OWN profile id for the maker-side access predicate.
      const myProfile = (await db.select({ id: changerProfiles.id }).from(changerProfiles).where(eq(changerProfiles.userId, ctx.user.id)).limit(1))[0];
      const rows = await db
        .select({
          order: p2pOrders,
          takerWalletAddress: users.walletAddress,
        })
        .from(p2pOrders)
        .leftJoin(users, eq(users.id, p2pOrders.takerId))
        .where(
          and(
            eq(p2pOrders.id, input.orderId),
            myProfile
              ? or(eq(p2pOrders.takerId, ctx.user.id), eq(p2pOrders.changerId, myProfile.id))
              : eq(p2pOrders.takerId, ctx.user.id),
          )
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      // Resolve the counterparty's Telegram so the client can open a real DM.
      // If the caller is the taker, the counterparty is the MAKER — whose userId
      // must be resolved from the changer profile (order.changerId is a profile id,
      // NOT a userId; resolving it directly DMs the wrong person — audit #8).
      const order = row.order;
      const isTaker = order.takerId === ctx.user.id;
      let counterpartyUserId: number | null = null;
      if (isTaker) {
        if (order.changerId != null) {
          const mk = (await db.select({ userId: changerProfiles.userId }).from(changerProfiles).where(eq(changerProfiles.id, order.changerId)).limit(1))[0];
          counterpartyUserId = mk?.userId ?? null;
        }
      } else {
        counterpartyUserId = order.takerId;
      }
      let counterpartyTelegram: string | null = null;
      if (counterpartyUserId != null) {
        const cp = (await db.select({ u: users.telegramUsername }).from(users).where(eq(users.id, counterpartyUserId)).limit(1))[0];
        counterpartyTelegram = cp?.u ?? null;
      }
      // Flatten the joined shape so existing callers see the order's fields
      // at the top level (backwards-compat) plus the new takerWalletAddress.
      return {
        ...order,
        takerWalletAddress: row.takerWalletAddress ?? null,
        counterpartyTelegram,
      };
    }),

  /**
   * messageCounterparty — taker↔maker chat that works WITHOUT a public @username.
   * Resolves the other party correctly (the maker's userId comes from the changer
   * profile — `p2pOrders.changerId` is a changer_profiles.id, NOT a userId, so
   * getOrder's direct users lookup is wrong), then the bot DMs them at their
   * stored telegramChatId. They read it in Telegram (from @your_bot_username) and
   * open the app to reply. Honest "no_chat" when they never started the bot — no
   * fake delivery, and never DMs the wrong person.
   */
  messageCounterparty: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive(), text: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Database unavailable" });
      assertRateLimit(ctx.user.id, `msg:${input.orderId}`, 5);
      const order = (await db.select().from(p2pOrders).where(eq(p2pOrders.id, input.orderId)).limit(1))[0];
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      // Maker's userId via the changer profile (changerId = changer_profiles.id).
      let makerUserId: number | null = null;
      if (order.changerId != null) {
        const cp = (await db.select({ userId: changerProfiles.userId }).from(changerProfiles).where(eq(changerProfiles.id, order.changerId)).limit(1))[0];
        makerUserId = cp?.userId ?? null;
      }
      const isTaker = order.takerId === ctx.user.id;
      const isMaker = makerUserId === ctx.user.id;
      if (!isTaker && !isMaker) throw new TRPCError({ code: "FORBIDDEN", message: "You're not part of this order." });
      const counterpartyUserId = isTaker ? makerUserId : order.takerId;
      if (counterpartyUserId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Couldn't resolve the other party." });
      const cp = (await db.select({ chatId: users.telegramChatId, username: users.telegramUsername }).from(users).where(eq(users.id, counterpartyUserId)).limit(1))[0];
      const counterpartyUsername = cp?.username ?? null;
      if (!cp?.chatId) {
        return { delivered: false, reason: "no_chat" as const, counterpartyUsername };
      }
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const sender = ctx.user.telegramUsername ? `@${esc(ctx.user.telegramUsername)}` : "A trader";
      const ok = await sendMessage(
        Number(cp.chatId),
        `💬 <b>DEX App · Order #${input.orderId}</b>\n${sender}: ${esc(input.text)}\n\nReply in the app.`,
      );
      return { delivered: ok, reason: ok ? ("sent" as const) : ("send_failed" as const), counterpartyUsername };
    }),

  /** Submit a rating for a completed trade */
  submitRating: protectedProcedure
    .input(z.object({
      orderId: z.number(),
      score: z.number().int().min(1).max(5),
      comment: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      // p2pOrders.changerId is a changer_profiles.id (NOT a userId) — audit crit #2.
      const myProfile = (await db.select({ id: changerProfiles.id }).from(changerProfiles).where(eq(changerProfiles.userId, ctx.user.id)).limit(1))[0];
      const orderRows = await db
        .select()
        .from(p2pOrders)
        .where(
          and(
            eq(p2pOrders.id, input.orderId),
            myProfile
              ? or(eq(p2pOrders.takerId, ctx.user.id), eq(p2pOrders.changerId, myProfile.id))
              : eq(p2pOrders.takerId, ctx.user.id),
          )
        )
        .limit(1);

      const order = orderRows[0];
      if (!order) throw new Error("Order not found");
      if (order.status !== "completed") throw new Error("Can only rate completed orders");

      const isTaker = order.takerId === ctx.user.id;
      // ratings.rateeId is a userId. When rating the maker, resolve the maker's
      // userId from the changer profile (order.changerId is a profile id — writing
      // it directly corrupted reputation against the wrong user; audit crit #2).
      let ratedUserId: number | null;
      if (isTaker) {
        ratedUserId = order.changerId != null
          ? ((await db.select({ userId: changerProfiles.userId }).from(changerProfiles).where(eq(changerProfiles.id, order.changerId)).limit(1))[0]?.userId ?? null)
          : null;
      } else {
        ratedUserId = order.takerId;
      }
      if (!ratedUserId) throw new Error("Cannot determine who to rate");

      // Check not already rated
      if (isTaker && order.isRatedByTaker) throw new Error("Already rated");
      if (!isTaker && order.isRatedByChanger) throw new Error("Already rated");

      await db.insert(ratings).values({
        raterId: ctx.user.id,
        rateeId: ratedUserId,
        orderId: input.orderId,
        score: input.score,
        comment: input.comment,
      });

      // Mark as rated
      await db
        .update(p2pOrders)
        .set(isTaker ? { isRatedByTaker: true } : { isRatedByChanger: true })
        .where(eq(p2pOrders.id, input.orderId));

      return { success: true };
    }),

  /** Store the user's Telegram chat ID (called on app open) */
  storeChatId: protectedProcedure
    .input(z.object({ telegramChatId: z.number(), telegramUsername: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { success: false };
      // SECURITY: only the chatId is written from client input. telegramUsername
      // is NOT — it's set solely from validated Telegram initData at login
      // (oauth.ts). Letting the client set it here let any user claim a victim's
      // @handle, and send.resolveRecipient maps @handle → wallet, so a spoofed
      // handle would redirect someone else's send to the attacker's wallet.
      await db
        .update(users)
        .set({ telegramChatId: input.telegramChatId })
        .where(eq(users.id, ctx.user.id));
      return { success: true };
    }),
});
