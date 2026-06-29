/**
 * ─── Social Links DEX Router ──────────────────────────────────────────────────────
 *
 * Allows users to link their social accounts (X, WhatsApp, Gmail, Instagram,
 * LinkedIn) to their profile. Each new link awards XP and points.
 *
 * Linking is handle-entry style (user types their handle/email/phone).
 * isVerified is set to true immediately — a future improvement can add
 * real OAuth verification per platform.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getSocialLinks,
  upsertSocialLink,
  deleteSocialLink,
  addXP,
} from "../db";
import { awardPoints } from "./referral";

// XP awarded per platform on first link
const PLATFORM_XP: Record<string, number> = {
  x:         100,
  whatsapp:  75,
  gmail:     75,
  instagram: 50,
  linkedin:  50,
};

// Points awarded per platform on first link
const PLATFORM_POINTS: Record<string, number> = {
  x:         50,
  whatsapp:  40,
  gmail:     40,
  instagram: 25,
  linkedin:  25,
};

export const socialRouter = router({
  /** List all linked social accounts for the current user */
  list: protectedProcedure.query(async ({ ctx }) => {
    return getSocialLinks(ctx.user.id);
  }),

  /** Link or update a social account handle */
  link: protectedProcedure
    .input(
      z.object({
        platform: z.enum(["x", "whatsapp", "gmail", "instagram", "linkedin"]),
        handle: z.string().min(1).max(256).trim(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getSocialLinks(ctx.user.id);
      const alreadyLinked = existing.find((l) => l.platform === input.platform);

      const xpReward = alreadyLinked ? 0 : (PLATFORM_XP[input.platform] ?? 50);
      const pointsReward = alreadyLinked ? 0 : (PLATFORM_POINTS[input.platform] ?? 25);

      const link = await upsertSocialLink(
        ctx.user.id,
        input.platform,
        input.handle,
        xpReward,
      );

      // Award XP and points only on first link
      let leveledUp = false;
      let newLevel: string = ctx.user.level;
      if (!alreadyLinked && xpReward > 0) {
        const xpResult = await addXP(ctx.user.id, xpReward);
        leveledUp = xpResult.leveledUp;
        newLevel = xpResult.newLevel;
        await awardPoints({ userId: ctx.user.id, delta: pointsReward, reason: "quest_completed" });
      }

      return {
        link,
        xpAwarded: xpReward,
        pointsAwarded: pointsReward,
        leveledUp,
        newLevel,
        isFirstLink: !alreadyLinked,
      };
    }),

  /** Unlink a social account */
  unlink: protectedProcedure
    .input(z.object({ platform: z.enum(["x", "whatsapp", "gmail", "instagram", "linkedin"]) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await getSocialLinks(ctx.user.id);
      const link = existing.find((l) => l.platform === input.platform);
      if (!link) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Social link not found" });
      }
      await deleteSocialLink(ctx.user.id, input.platform);
      return { success: true };
    }),
});
