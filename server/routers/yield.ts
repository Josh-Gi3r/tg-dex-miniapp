/**
 * ─── Yield Bot DEX Router ────────────────────────────────────────────────────────
 *
 * User-facing surface for the pooled yield bot.
 *
 *   me        — returns the user's open position + their accrued shares
 *               valued at the latest cycle's NAV. Returns null if they
 *               haven't deposited.
 *   stats     — pool-wide stats (TVL, last cycle NAV, 24h pnl), used by
 *               the Earn tab even before the user deposits.
 *   deposit   — records a deposit. In demo mode this is bookkeeping only;
 *               in production it expects the deposit tx hash so the
 *               worker can verify on-chain receipt before issuing shares.
 *   withdraw  — flags the position as pending_withdraw. The worker
 *               liquidates and posts the tx hash on the next cycle.
 *   runCycle  — admin-only manual trigger (cron normally hits the
 *               internal HTTP endpoint).
 *   cycles    — last N cycle snapshots for the NAV chart.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq, sum } from "drizzle-orm";
import { z } from "zod";
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from "../_core/trpc";
import { getDb } from "../db";
import { yieldCycles, yieldPositions } from "../../drizzle/schema";
import { getRiskLimits } from "../lib/yield/risk";
import { isYieldBotConfigured, getYieldBotAddress } from "../lib/yield/wallet";
import { runYieldCycle } from "../lib/yield/worker";

async function getLatestNavPerShare(): Promise<number> {
  const db = await getDb();
  if (!db) return 1;
  const [latest] = await db
    .select()
    .from(yieldCycles)
    .orderBy(desc(yieldCycles.createdAt))
    .limit(1);
  if (!latest) return 1;
  const shares = Number(latest.totalShares);
  if (shares <= 0) return 1;
  return Number(latest.totalAssets) / shares;
}

export const yieldRouter = router({
  stats: publicProcedure.query(async () => {
    const db = await getDb();
    const limits = getRiskLimits();
    const baseStats = {
      configured: isYieldBotConfigured(),
      killed: limits.killSwitch,
      maxPoolUsdc: limits.maxPoolSizeUsdc,
      maxPerUserUsdc: limits.maxPerUserUsdc,
      performanceFeeBps: limits.performanceFeeBps,
      botAddress: getYieldBotAddress(),
      tvlUsdc: 0,
      navPerShare: 1,
      lastCyclePnlBps: 0,
      cycles24h: 0,
    };
    if (!db) return baseStats;

    const [tvlRow] = await db
      .select({ tvl: sum(yieldPositions.depositedAmount) })
      .from(yieldPositions)
      .where(eq(yieldPositions.status, "active"));
    const [latestCycle] = await db
      .select()
      .from(yieldCycles)
      .orderBy(desc(yieldCycles.createdAt))
      .limit(1);

    return {
      ...baseStats,
      tvlUsdc: Number(tvlRow?.tvl ?? 0),
      navPerShare: latestCycle
        ? Number(latestCycle.totalShares) > 0
          ? Number(latestCycle.totalAssets) / Number(latestCycle.totalShares)
          : 1
        : 1,
      lastCyclePnlBps: latestCycle ? Number(latestCycle.pnlBps) : 0,
    };
  }),

  me: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const positions = await db
      .select()
      .from(yieldPositions)
      .where(eq(yieldPositions.userId, ctx.user.id));
    if (positions.length === 0) return null;

    const navPerShare = await getLatestNavPerShare();
    const active = positions.filter((p) => p.status !== "withdrawn");
    const aggregate = active.reduce(
      (acc, p) => {
        acc.deposited += Number(p.depositedAmount);
        acc.shares += Number(p.shares);
        return acc;
      },
      { deposited: 0, shares: 0 },
    );
    return {
      positions,
      summary: {
        totalDepositedUsdc: aggregate.deposited,
        totalShares: aggregate.shares,
        currentValueUsdc: aggregate.shares * navPerShare,
        pnlUsdc: aggregate.shares * navPerShare - aggregate.deposited,
        pnlBps:
          aggregate.deposited > 0
            ? ((aggregate.shares * navPerShare - aggregate.deposited) /
                aggregate.deposited) *
              10_000
            : 0,
      },
    };
  }),

  deposit: protectedProcedure
    .input(
      z.object({
        amountUsdc: z.number().positive(),
        ownerAddress: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/),
        depositTxHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const limits = getRiskLimits();
      if (limits.killSwitch) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Yield bot is paused — deposits temporarily disabled.",
        });
      }
      if (input.amountUsdc > limits.maxPerUserUsdc) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Per-user cap is ${limits.maxPerUserUsdc} USDC.`,
        });
      }

      const [tvlRow] = await db
        .select({ tvl: sum(yieldPositions.depositedAmount) })
        .from(yieldPositions)
        .where(eq(yieldPositions.status, "active"));
      const tvl = Number(tvlRow?.tvl ?? 0);
      if (tvl + input.amountUsdc > limits.maxPoolSizeUsdc) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Pool would exceed ${limits.maxPoolSizeUsdc} USDC cap.`,
        });
      }

      const navPerShare = await getLatestNavPerShare();
      const sharesIssued = input.amountUsdc / navPerShare;

      await db.insert(yieldPositions).values({
        userId: ctx.user.id,
        depositedAmount: input.amountUsdc.toFixed(6),
        shares: sharesIssued.toFixed(12),
        ownerAddress: input.ownerAddress,
        depositTxHash: input.depositTxHash ?? null,
        status: "active",
      });
      return { sharesIssued, navPerShare };
    }),

  withdraw: protectedProcedure
    .input(z.object({ positionId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [pos] = await db
        .select()
        .from(yieldPositions)
        .where(
          and(
            eq(yieldPositions.id, input.positionId),
            eq(yieldPositions.userId, ctx.user.id),
          ),
        );
      if (!pos) throw new TRPCError({ code: "NOT_FOUND" });
      if (pos.status === "withdrawn" || pos.status === "pending_withdraw") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Position already in withdraw flow.",
        });
      }
      await db
        .update(yieldPositions)
        .set({ status: "pending_withdraw" })
        .where(eq(yieldPositions.id, pos.id));
      return { ok: true };
    }),

  pause: protectedProcedure
    .input(z.object({ positionId: z.number(), paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [pos] = await db
        .select()
        .from(yieldPositions)
        .where(
          and(
            eq(yieldPositions.id, input.positionId),
            eq(yieldPositions.userId, ctx.user.id),
          ),
        );
      if (!pos) throw new TRPCError({ code: "NOT_FOUND" });
      if (pos.status === "withdrawn" || pos.status === "pending_withdraw") {
        throw new TRPCError({ code: "BAD_REQUEST" });
      }
      await db
        .update(yieldPositions)
        .set({ status: input.paused ? "paused" : "active" })
        .where(eq(yieldPositions.id, pos.id));
      return { ok: true };
    }),

  cycles: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(yieldCycles)
        .orderBy(desc(yieldCycles.createdAt))
        .limit(input?.limit ?? 50);
    }),

  runCycle: adminProcedure.mutation(async () => {
    return runYieldCycle();
  }),
});
