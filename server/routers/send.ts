import { z } from "zod";
import { sql } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import {
  createSendClaim,
  getSendClaimByUuid,
  getPendingClaimsBySender,
  createTransaction,
  getDb,
} from "../db";
import { users } from "../../drizzle/schema";
import { assertRateLimit } from "../lib/production";
import { nanoid } from "nanoid";

export const sendRouter = router({
  /**
   * resolveRecipient — map a Telegram @username to a app user + their wallet.
   * Lets "send to @username" go DIRECT to their wallet when they're a funded
   * app user; the client falls back to a claim link when not found / no wallet.
   * Privacy: returns only walletAddress + a display name for a valid handle.
   */
  resolveRecipient: protectedProcedure
    .input(z.object({ handle: z.string().min(1).max(40) }))
    .query(async ({ ctx, input }) => {
      // Throttle: this maps @username → wallet address; cap to slow enumeration
      // (audit #14). Caller is always authenticated (protectedProcedure).
      assertRateLimit(ctx.user.id, "resolveRecipient", 15);
      const db = await getDb();
      const miss = { found: false as const, walletAddress: null, displayName: null };
      if (!db) return miss;
      const handle = input.handle.replace(/^@/, "").trim().toLowerCase();
      if (!/^[a-zA-Z0-9_]{3,32}$/.test(handle)) return miss;
      const row = (
        await db
          .select({
            walletAddress: users.walletAddress,
            username: users.telegramUsername,
            name: users.name,
          })
          .from(users)
          .where(sql`lower(${users.telegramUsername}) = ${handle}`)
          .limit(1)
      )[0];
      if (!row) return miss;
      return {
        found: true as const,
        // null when the user exists but hasn't imported a wallet → client uses claim link
        walletAddress: row.walletAddress ?? null,
        displayName: row.name ?? (row.username ? `@${row.username}` : `@${handle}`),
      };
    }),
  // Create a new cross-currency send claim and return a shareable link
  createClaim: protectedProcedure
    .input(
      z.object({
        fromToken: z.string(),
        toToken: z.string(),
        fromAmount: z.string(),
        estimatedToAmount: z.string(),
        message: z.string().max(140).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(ctx.user.id, "createClaim", 10);
      const claimUuid = nanoid(16);
      const claimId = await createSendClaim({
        senderId: ctx.user.id,
        fromToken: input.fromToken,
        toToken: input.toToken,
        fromAmount: input.fromAmount,
        estimatedToAmount: input.estimatedToAmount,
        message: input.message,
        claimUuid,
      });
      return {
        success: true,
        claimId,
        claimUuid,
        claimUrl: `https://t.me/your_bot_username/app?startapp=claim_${claimUuid}`,
      };
    }),

  // Get a claim by UUID (public - for recipients)
  getClaim: publicProcedure
    .input(z.object({ uuid: z.string() }))
    .query(async ({ input }) => {
      const claim = await getSendClaimByUuid(input.uuid);
      if (!claim) return null;
      // Don't expose internal IDs to public
      return {
        claimUuid: claim.claimUuid,
        fromToken: claim.fromToken,
        toToken: claim.toToken,
        fromAmount: claim.fromAmount,
        estimatedToAmount: claim.estimatedToAmount,
        message: claim.message,
        status: claim.status,
        expiresAt: claim.expiresAt,
      };
    }),

  // Claim funds (recipient calls this after connecting wallet)
  claimFunds: protectedProcedure
    .input(
      z.object({
        uuid: z.string(),
        recipientWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        txHash: z.string().optional(),
        actualToAmount: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const claim = await getSendClaimByUuid(input.uuid);
      if (!claim) throw new Error("Claim not found.");
      if (claim.status !== "pending") throw new Error(`Claim is already ${claim.status}.`);
      if (new Date() > claim.expiresAt) throw new Error("This claim has expired.");

      const { getDb } = await import("../db");
      const { sendClaims } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available.");

      await db
        .update(sendClaims)
        .set({
          status: "claimed",
          recipientId: ctx.user.id,
          recipientWallet: input.recipientWallet,
          toAmount: input.actualToAmount,
          txHash: input.txHash,
          claimedAt: new Date(),
        })
        .where(eq(sendClaims.claimUuid, input.uuid));

      // Record transactions for both sender and recipient
      await createTransaction({
        userId: claim.senderId,
        type: "send",
        fromToken: claim.fromToken,
        toToken: claim.toToken,
        fromAmount: claim.fromAmount,
        toAmount: input.actualToAmount,
        txHash: input.txHash,
        status: "completed",
        xpEarned: 15,
        relatedClaimId: claim.id,
      });

      await createTransaction({
        userId: ctx.user.id,
        type: "receive",
        fromToken: claim.fromToken,
        toToken: claim.toToken,
        fromAmount: claim.fromAmount,
        toAmount: input.actualToAmount,
        txHash: input.txHash,
        status: "completed",
        xpEarned: 5,
        relatedClaimId: claim.id,
      });

      return { success: true };
    }),

  // Get all pending claims created by the current user
  getMyClaims: protectedProcedure.query(async ({ ctx }) => {
    return getPendingClaimsBySender(ctx.user.id);
  }),

  // Cancel a pending claim
  cancelClaim: protectedProcedure
    .input(z.object({ uuid: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const claim = await getSendClaimByUuid(input.uuid);
      if (!claim) throw new Error("Claim not found.");
      if (claim.senderId !== ctx.user.id) throw new Error("Not your claim.");
      if (claim.status !== "pending") throw new Error("Claim cannot be cancelled.");

      const { getDb } = await import("../db");
      const { sendClaims } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available.");

      await db.update(sendClaims).set({ status: "cancelled" }).where(eq(sendClaims.claimUuid, input.uuid));
      return { success: true };
    }),
});
