/**
 * ─── Swap DEX Router ──────────────────────────────────────────────────────────────
 *
 * Handles FX swap execution and transaction history.
 *
 * DEMO MODE: Swaps are simulated — no on-chain execution occurs.
 * PRODUCTION (Idea 3): Wire recordSwap to executeOnChainSwap() from
 * server/lib/production.ts once SEPOLIA_RPC_URL / MAINNET_RPC_URL is available.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { createTransaction, getUserTransactions, updateUserWallet } from "../db";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { awardPoints, POINT_RULES } from "./referral";
import { getLiveRate } from "../lib/production";
import { getDexClient } from "../lib/dex/client";

/** Validates a positive decimal number string (e.g. "1.5", "100"). */
const positiveDecimalString = z
  .string()
  .refine((v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0, {
    message: "Amount must be a positive number",
  });

export const swapRouter = router({
  /** Register or update the wallet address for the current user. */
  registerWallet: protectedProcedure
    .input(
      z.object({
        walletAddress: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await updateUserWallet(ctx.user.id, input.walletAddress);
      return { success: true };
    }),

  /**
   * Record a completed swap transaction and award XP.
   * In production this will also trigger the on-chain swap before recording.
   */
  recordSwap: protectedProcedure
    .input(
      z.object({
        fromToken: z.string().min(1).max(20),
        toToken: z.string().min(1).max(20),
        fromAmount: positiveDecimalString,
        toAmount: positiveDecimalString,
        valueUsd: z.string().optional(),
        txHash: z.string().optional(),
        type: z.enum(["swap", "arb"]).default("swap"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.fromToken === input.toToken) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "fromToken and toToken must differ",
        });
      }

      const xpEarned = input.type === "arb" ? 30 : 10;
      const txId = await createTransaction({
        userId: ctx.user.id,
        type: input.type,
        fromToken: input.fromToken,
        toToken: input.toToken,
        fromAmount: input.fromAmount,
        toAmount: input.toAmount,
        valueUsd: input.valueUsd,
        txHash: input.txHash,
        status: "completed",
        xpEarned,
      });

      // Award points for completing a trade
      await awardPoints({
        userId: ctx.user.id,
        delta: POINT_RULES.trade_completed,
        reason: "trade_completed",
        relatedOrderId: txId ?? undefined,
        note: `${input.fromToken} → ${input.toToken}`,
      });

      // Check trade milestones (10, 50, 100, 500 trades)
      const db = await getDb();
      if (db) {
        const userRow = await db
          .select({ totalTrades: users.totalTrades })
          .from(users)
          .where(eq(users.id, ctx.user.id))
          .limit(1);
        const totalTrades = (userRow[0]?.totalTrades ?? 0) + 1;
        if ([10, 50, 100, 500].includes(totalTrades)) {
          await awardPoints({
            userId: ctx.user.id,
            delta: POINT_RULES.milestone_reached,
            reason: "milestone_reached",
            note: `Milestone: ${totalTrades} trades completed`,
          });
        }
      }

      return { success: true, txId };
    }),

  /** Get transaction history for the current user. */
  getHistory: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      return getUserTransactions(ctx.user.id, input.limit);
    }),

  /**
   * Get the list of supported tokens from the venue /tokens (public, no auth).
   *
   * v2: thin wrapper over `dex.tokens` so this never returns a hardcoded
   * mainnet/testnet-mismatched list. Falls through to the same
   * `SUPPORTED_TOKENS` cold-cache fallback if the venue is unreachable.
   *
   * Shape preserved for back-compat with existing callers / swap.test.ts.
   */
  getSupportedTokens: publicProcedure.query(async () => {
    const client = getDexClient();
    try {
      const r = await client.getTokens();
      return {
        tokens: r.tokens.map((t) => ({
          symbol: t.symbol,
          name: t.symbol,
          currency: t.currency,
        })),
      };
    } catch {
      const fallback = (await import("@shared/venue-config")).SUPPORTED_TOKENS;
      return {
        tokens: Object.values(fallback).map((t) => ({
          symbol: t.symbol,
          name: t.name,
          currency: t.currency,
        })),
      };
    }
  }),

  /**
   * Get the live FX rate between two stablecoin symbols.
   * Backed by the venue's /fx/rate oracle pipeline.
   *
   * Returns { rate: number, source: "live" | "fallback", lastUpdated: ISO }
   * Always resolves — failures degrade to source='fallback' with rate=0
   * rather than throwing, so the UI can decide what to show.
   */
  getRate: publicProcedure
    .input(
      z.object({
        from: z.string().min(1).max(20),
        to: z.string().min(1).max(20),
      }),
    )
    .query(async ({ input }) => {
      if (input.from === input.to) {
        return {
          rate: 1,
          source: "live" as const,
          lastUpdated: new Date().toISOString(),
        };
      }
      try {
        const r = await getLiveRate(input.from, input.to);
        return {
          rate: r.rate,
          source: r.source,
          lastUpdated: r.lastUpdated.toISOString(),
        };
      } catch (err) {
        console.warn(`[swap.getRate] ${input.from}→${input.to} failed:`, err);
        return {
          rate: 0,
          source: "fallback" as const,
          lastUpdated: new Date().toISOString(),
        };
      }
    }),
});
