import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import {
  getChangerByUserId,
  getChangerRates,
  listActiveChangers,
  upsertChangerProfile,
  upsertChangerRate,
  getUserById,
} from "../db";

export const shopRouter = router({
  // Get the current user's changer profile
  getMyProfile: protectedProcedure.query(async ({ ctx }) => {
    const profile = await getChangerByUserId(ctx.user.id);
    const rates = profile ? await getChangerRates(profile.id) : [];
    return { profile, rates };
  }),

  // Set up or update changer profile
  setupProfile: protectedProcedure
    .input(
      z.object({
        displayName: z.string().min(2).max(64),
        bio: z.string().max(280).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await upsertChangerProfile(ctx.user.id, input);
      return { success: true };
    }),

  // Toggle changer active status
  toggleActive: protectedProcedure
    .input(z.object({ isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const profile = await getChangerByUserId(ctx.user.id);
      if (!profile) throw new Error("No changer profile found. Set up your profile first.");
      await upsertChangerProfile(ctx.user.id, { displayName: profile.displayName, isActive: input.isActive });
      return { success: true };
    }),

  // Set or update a rate for a currency pair
  setRate: protectedProcedure
    .input(
      z.object({
        fromToken: z.string(),
        toToken: z.string(),
        spreadBps: z.number().min(0).max(500), // 0-5%
        minAmount: z.string(),
        maxAmount: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const profile = await getChangerByUserId(ctx.user.id);
      if (!profile) throw new Error("Set up your changer profile first.");
      await upsertChangerRate(
        profile.id,
        input.fromToken,
        input.toToken,
        input.spreadBps,
        input.minAmount,
        input.maxAmount
      );
      return { success: true };
    }),

  // List all active changers for the Shop tab
  listShop: publicProcedure
    .input(
      z.object({
        fromToken: z.string().optional(),
        toToken: z.string().optional(),
        sortBy: z.enum(["reputation", "volume", "rating"]).default("reputation"),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input }) => {
      const changers = await listActiveChangers(input.limit);
      // Attach rates to each changer
      const withRates = await Promise.all(
        changers.map(async (c) => {
          const rates = await getChangerRates(c.id);
          const filteredRates =
            input.fromToken && input.toToken
              ? rates.filter((r) => r.fromToken === input.fromToken && r.toToken === input.toToken)
              : rates;
          return { ...c, rates: filteredRates };
        })
      );
      // Filter out changers with no matching rates if filter is applied
      const filtered =
        input.fromToken && input.toToken ? withRates.filter((c) => c.rates.length > 0) : withRates;
      return filtered;
    }),

  // Get a single changer's public profile
  getChangerProfile: publicProcedure
    .input(z.object({ changerId: z.number() }))
    .query(async ({ input }) => {
      const { getDb } = await import("../db");
      const { changerProfiles, users } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      const result = await db
        .select()
        .from(changerProfiles)
        .innerJoin(users, eq(changerProfiles.userId, users.id))
        .where(eq(changerProfiles.id, input.changerId))
        .limit(1);
      if (!result[0]) return null;
      const rates = await getChangerRates(input.changerId);
      return { ...result[0].changer_profiles, user: result[0].users, rates };
    }),
});
