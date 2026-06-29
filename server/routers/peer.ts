/**
 * ─── Peer (zkP2P) tRPC router ────────────────────────────────────────────────
 *
 * Fiat ⇄ crypto ramp surface. Reads (quotes/status/lists) are safe; writes
 * (signal/fulfill/createDeposit) are guarded by `assertPeerWriteReady` and need
 * FEATURE_PEER + a Base RPC + the user's wallet. See docs/PEER_INTEGRATION.md.
 *
 * Mounted in server/routers.ts behind ENV.peerEnabled.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { ENV } from "../_core/env";
import { assertRateLimit } from "../lib/production";
import {
  PEER_PAYMENT_PLATFORMS,
  PEER_FIAT_CURRENCIES,
  PEER_PLATFORM_KEYS,
} from "../../shared/peer-config";
import {
  peerGetBestQuotes,
  peerGetOrderbook,
  peerGetVaults,
  peerGetLeaderboard,
  peerSignalIntent,
  peerFulfillIntent,
  peerCancelIntent,
  peerCreateDeposit,
  peerSetAcceptingIntents,
  peerListUserIntents,
  peerListUserDeposits,
  peerGetIntentRow,
  peerGetOnchainIntent,
  peerMarkPaid,
} from "../lib/peer/peerService";

const sideEnum = z.enum(["onramp", "offramp"]);

export const peerRouter = router({
  /** Static config for the UI. The Cash feature is VISIBLE to everyone (browse +
   * quotes); `moneyEnabled` gates only the real-money action buttons. */
  config: protectedProcedure.query(() => ({
    visible: true,
    moneyEnabled: ENV.peerEnabled,
    writeReady: ENV.peerEnabled && Boolean(ENV.peerBaseRpcUrl),
    runtimeEnv: ENV.peerRuntimeEnv,
    platforms: PEER_PAYMENT_PLATFORMS,
    currencies: PEER_FIAT_CURRENCIES,
  })),

  // ── Liquidity orderbook (read-only — the live book of makers) ────────────
  orderbook: protectedProcedure
    .input(
      z.object({
        fiatCurrency: z.string().min(2).max(8).default("USD"),
        paymentPlatform: z.enum(PEER_PLATFORM_KEYS as [string, ...string[]]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertRateLimit(ctx.user.id, "peerOrderbook", 40);
      return peerGetOrderbook(input);
    }),

  vaults: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ input }) => peerGetVaults(input?.limit ?? 25)),

  leaderboard: protectedProcedure
    .input(z.object({ fiatCurrency: z.string().max(8).optional(), limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ input }) => peerGetLeaderboard(input?.fiatCurrency ?? "USD", input?.limit ?? 25)),

  // ── Quotes (read-only, no wallet needed) ─────────────────────────────────
  bestQuotes: protectedProcedure
    .input(
      z.object({
        side: sideEnum,
        fiatCurrency: z.string().min(2).max(8),
        amount: z.string().min(1).max(32),
        isExactFiat: z.boolean().optional(),
        userAddress: z.string().max(48).optional(),
        recipientAddress: z.string().max(48).optional(),
        destinationChainId: z.number().int().optional(),
        destinationToken: z.string().max(80).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertRateLimit(ctx.user.id, "peerQuote", 30);
      return peerGetBestQuotes(input);
    }),

  // ── Onramp writes ─────────────────────────────────────────────────────────
  signalIntent: protectedProcedure
    .input(
      z.object({
        side: sideEnum,
        depositId: z.string().min(1).max(80),
        processorName: z.enum(PEER_PLATFORM_KEYS as [string, ...string[]]),
        payeeDetails: z.string().min(1).max(80),
        fiatCurrency: z.string().min(2).max(8),
        usdcAmount: z.string().min(1).max(32),
        fiatAmount: z.string().min(1).max(32),
        conversionRate: z.string().min(1).max(40),
        toAddress: z.string().max(48).optional(),
        destinationChainId: z.number().int().optional(),
        destinationToken: z.string().max(80).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(ctx.user.id, "peerSignal", 10);
      return peerSignalIntent(ctx.user.id, input);
    }),

  fulfillIntent: protectedProcedure
    .input(
      z.object({
        intentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        // Buyer-TEE proof input captured client-side, or a Reclaim proof.
        proof: z.union([z.string(), z.record(z.string(), z.unknown())]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(ctx.user.id, "peerFulfill", 10);
      return peerFulfillIntent(ctx.user.id, {
        intentHash: input.intentHash as `0x${string}`,
        proof: input.proof,
      });
    }),

  cancelIntent: protectedProcedure
    .input(z.object({ intentHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }))
    .mutation(async ({ ctx, input }) => {
      return peerCancelIntent(ctx.user.id, input.intentHash as `0x${string}`);
    }),

  markPaid: protectedProcedure
    .input(z.object({ rowId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      return peerMarkPaid(ctx.user.id, input.rowId);
    }),

  // ── Offramp / liquidity-provider writes ──────────────────────────────────
  createDeposit: protectedProcedure
    .input(
      z.object({
        amount: z.string().min(1).max(32),
        minIntent: z.string().min(1).max(32),
        maxIntent: z.string().min(1).max(32),
        legs: z
          .array(
            z.object({
              platform: z.enum(PEER_PLATFORM_KEYS as [string, ...string[]]),
              fiatCurrency: z.string().min(2).max(8),
              conversionRate: z.string().min(1).max(40),
              offchainId: z.string().min(1).max(64),
              telegramUsername: z.string().max(40).optional(),
            }),
          )
          .min(1)
          .max(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(ctx.user.id, "peerCreateDeposit", 5);
      return peerCreateDeposit(ctx.user.id, input);
    }),

  setAcceptingIntents: protectedProcedure
    .input(z.object({ rowId: z.number().int(), accepting: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return peerSetAcceptingIntents(ctx.user.id, input.rowId, input.accepting);
    }),

  // ── Reads ────────────────────────────────────────────────────────────────
  myIntents: protectedProcedure.query(async ({ ctx }) => peerListUserIntents(ctx.user.id)),
  myDeposits: protectedProcedure.query(async ({ ctx }) => peerListUserDeposits(ctx.user.id)),

  intent: protectedProcedure
    .input(z.object({ rowId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const row = await peerGetIntentRow(ctx.user.id, input.rowId);
      if (!row) return null;
      const onchain = row.intentHash
        ? await peerGetOnchainIntent(row.intentHash as `0x${string}`)
        : null;
      return { row, onchain };
    }),
});
