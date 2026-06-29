/**
 * ─── Signals DEX Router ──────────────────────────────────────────────────────────
 *
 * Frontend access points for the recommendation bot:
 *   recent           — list of currently-live signals (filterable + paginated)
 *   subscription     — get/update the caller's subscription preferences
 *   recordOutcome    — fire on view/ignore/act for analytics + rate cap
 *   runCycle         — admin-only manual cycle trigger (also called by cron)
 *   stats            — admin-only success-rate dashboard
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  adminProcedure,
  protectedProcedure,
  router,
} from "../_core/trpc";
import { getDb } from "../db";
import {
  botRecommendations,
  recommendationOutcomes,
  recommendationSubscriptions,
} from "../../drizzle/schema";
import { runSignalCycle } from "../lib/signals/worker";
import { STRATEGY_TYPES } from "../lib/signals/strategies";

const SignalTypeEnum = z.enum(["best_rate", "stale_offer", "wide_spread"]);

export const signalsRouter = router({
  /**
   * Live signal feed for the current user. By default returns up to 50
   * non-expired signals matching the caller's subscription. UI should poll
   * every 15-30s while the Signals tab is open.
   */
  recent: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(50),
          types: z.array(SignalTypeEnum).optional(),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const types: ("best_rate" | "stale_offer" | "wide_spread")[] =
        input.types ?? [...STRATEGY_TYPES];
      const now = new Date();
      const rows = await db
        .select()
        .from(botRecommendations)
        .where(
          and(
            inArray(botRecommendations.type, types),
            gt(botRecommendations.expiresAt, now),
          ),
        )
        .orderBy(desc(botRecommendations.opportunityScore))
        .limit(input.limit);

      // For stale_offer, filter to only the poster's own ads — no point
      // showing "Bob's offer is stale" to anyone except Bob.
      const userPosterIds = await db.execute(
        sql`SELECT id, posterId FROM p2p_ads WHERE id IN (${sql.join(
          rows.filter((r) => r.relatedAdId).map((r) => sql`${r.relatedAdId}`),
          sql`,`,
        )})`,
      ).catch(() => null);
      const adIdToPoster = new Map<number, number>();
      if (userPosterIds && Array.isArray((userPosterIds as any)[0])) {
        for (const row of (userPosterIds as any)[0] as Array<{
          id: number;
          posterId: number;
        }>) {
          adIdToPoster.set(row.id, row.posterId);
        }
      }

      return rows
        .filter((r) => {
          if (r.type !== "stale_offer") return true;
          const poster = r.relatedAdId ? adIdToPoster.get(r.relatedAdId) : null;
          return poster === ctx.user.id;
        })
        .map((r) => ({
          id: r.id,
          type: r.type,
          marketSymbol: r.marketSymbol,
          relatedAdId: r.relatedAdId,
          opportunityScore: r.opportunityScore,
          payload: JSON.parse(r.payload) as Record<string, unknown>,
          expiresAt: r.expiresAt,
          createdAt: r.createdAt,
        }));
    }),

  /** Returns the caller's subscription record, creating defaults if missing. */
  subscription: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      return {
        enabledTypes: STRATEGY_TYPES,
        minScore: 5,
        deliveryMethod: "both" as const,
        maxPerHour: 5,
        isPaused: false,
      };
    }
    const rows = await db
      .select()
      .from(recommendationSubscriptions)
      .where(eq(recommendationSubscriptions.userId, ctx.user.id))
      .limit(1);
    const row = rows[0];
    if (row) {
      return {
        enabledTypes: row.enabledTypes.split(",").map((s) => s.trim()),
        minScore: row.minScore,
        deliveryMethod: row.deliveryMethod,
        maxPerHour: row.maxPerHour,
        isPaused: row.isPaused,
      };
    }
    return {
      enabledTypes: STRATEGY_TYPES,
      minScore: 5,
      deliveryMethod: "both" as const,
      maxPerHour: 5,
      isPaused: false,
    };
  }),

  /** Upserts the caller's subscription preferences. */
  updateSubscription: protectedProcedure
    .input(
      z.object({
        enabledTypes: z.array(SignalTypeEnum).optional(),
        minScore: z.number().min(0).max(1000).optional(),
        deliveryMethod: z.enum(["telegram", "in_app", "both"]).optional(),
        maxPerHour: z.number().int().min(0).max(100).optional(),
        isPaused: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { success: true };

      const existing = await db
        .select()
        .from(recommendationSubscriptions)
        .where(eq(recommendationSubscriptions.userId, ctx.user.id))
        .limit(1);

      const enabledTypes = input.enabledTypes
        ? input.enabledTypes.join(",")
        : undefined;

      if (existing[0]) {
        await db
          .update(recommendationSubscriptions)
          .set({
            ...(enabledTypes !== undefined && { enabledTypes }),
            ...(input.minScore !== undefined && { minScore: input.minScore }),
            ...(input.deliveryMethod !== undefined && {
              deliveryMethod: input.deliveryMethod,
            }),
            ...(input.maxPerHour !== undefined && {
              maxPerHour: input.maxPerHour,
            }),
            ...(input.isPaused !== undefined && { isPaused: input.isPaused }),
          })
          .where(eq(recommendationSubscriptions.userId, ctx.user.id));
      } else {
        await db.insert(recommendationSubscriptions).values({
          userId: ctx.user.id,
          enabledTypes: enabledTypes ?? STRATEGY_TYPES.join(","),
          minScore: input.minScore ?? 5,
          deliveryMethod: input.deliveryMethod ?? "both",
          maxPerHour: input.maxPerHour ?? 5,
          isPaused: input.isPaused ?? false,
        });
      }
      return { success: true };
    }),

  /**
   * Records a viewed/ignored/acted/resulted_in_trade outcome for analytics.
   * Called from the UI on signal interactions; "delivered" is reserved for
   * the worker.
   */
  recordOutcome: protectedProcedure
    .input(
      z.object({
        recommendationId: z.number().int().positive(),
        action: z.enum(["viewed", "ignored", "acted", "resulted_in_trade"]),
        resultTxHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .optional(),
        realizedPnlBps: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { success: true };
      await db.insert(recommendationOutcomes).values({
        recommendationId: input.recommendationId,
        userId: ctx.user.id,
        action: input.action,
        resultTxHash: input.resultTxHash ?? null,
        realizedPnlBps: input.realizedPnlBps ?? null,
      });
      return { success: true };
    }),

  /**
   * Admin-only: kicks one signal-engine cycle. Hit this from a cron/scheduled
   * task every 60s. Returns the cycle's metrics so the cron can log/alert.
   */
  runCycle: adminProcedure.mutation(async () => {
    return runSignalCycle();
  }),

  /**
   * Admin-only: backtest-style success rate per signal type. Used to decide
   * which signals to keep, tune, or retire as the bot accumulates outcomes.
   */
  stats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        type: botRecommendations.type,
        action: recommendationOutcomes.action,
        count: sql<number>`count(*)`.mapWith(Number),
        avgPnlBps: sql<number | null>`avg(realizedPnlBps)`.mapWith((v) =>
          v === null ? null : Number(v),
        ),
      })
      .from(recommendationOutcomes)
      .innerJoin(
        botRecommendations,
        eq(botRecommendations.id, recommendationOutcomes.recommendationId),
      )
      .groupBy(botRecommendations.type, recommendationOutcomes.action);
    return rows;
  }),
});
