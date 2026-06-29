import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import {
  getVolumeLeaderboard,
  getTrustLeaderboard,
  getRatesLeaderboard,
  getUserBadges,
  awardBadge,
  addXP,
  getUserById,
  getChangerByUserId,
} from "../db";

// Badge definitions
export const BADGE_DEFINITIONS = {
  first_swap: { name: "First Swap", emoji: "🔄", description: "Completed your first swap", xpReward: 50 },
  lion_city: { name: "Lion City", emoji: "🦁", description: "Traded 1,000 XSGD", xpReward: 100 },
  harimau: { name: "Harimau", emoji: "🐯", description: "Traded 1,000 MYRC", xpReward: 100 },
  garuda: { name: "Garuda", emoji: "🦅", description: "Traded 1,000,000 IDRX", xpReward: 100 },
  arb_hunter: { name: "Arb Hunter", emoji: "🎯", description: "Executed a triangular arbitrage", xpReward: 200 },
  volume_king: { name: "Volume King", emoji: "👑", description: "Reached $10,000 trading volume", xpReward: 300 },
  five_star: { name: "5-Star Changer", emoji: "⭐", description: "Received 10 five-star ratings", xpReward: 250 },
  speed_demon: { name: "Speed Demon", emoji: "⚡", description: "Filled 10 orders in under 1 minute", xpReward: 150 },
  social_butterfly: { name: "Social Butterfly", emoji: "🦋", description: "Referred 5 friends", xpReward: 200 },
  diamond_hands: { name: "Diamond Hands", emoji: "💎", description: "30-day login streak", xpReward: 500 },
  market_maker: { name: "Market Maker", emoji: "📊", description: "Filled 100 orders as a changer", xpReward: 400 },
  legend: { name: "Legend", emoji: "🏆", description: "Reached Legend level", xpReward: 1000 },
} as const;

export type BadgeSlug = keyof typeof BADGE_DEFINITIONS;

export const leaderboardRouter = router({
  // Get volume leaderboard (monthly)
  getVolumeBoard: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
      const users = await getVolumeLeaderboard(input.limit);
      return users.map((u, i) => ({
        rank: i + 1,
        userId: u.id,
        name: u.name || u.telegramUsername || `User #${u.id}`,
        level: u.level,
        totalVolumeUsd: u.totalVolumeUsd,
        totalTrades: u.totalTrades,
        xp: u.xp,
      }));
    }),

  // Get trust leaderboard (all-time reputation)
  getTrustBoard: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
      const changers = await getTrustLeaderboard(input.limit);
      return changers.map((c, i) => ({
        rank: i + 1,
        changerId: c.id,
        displayName: c.displayName,
        reputationScore: c.reputationScore,
        avgRating: c.avgRating,
        totalRatings: c.totalRatings,
        completionRate: c.completionRate,
        totalOrdersFilled: c.totalOrdersFilled,
      }));
    }),

  // Get best changers leaderboard (most active)
  getRatesBoard: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
      const changers = await getRatesLeaderboard(input.limit);
      return changers.map((c, i) => ({
        rank: i + 1,
        changerId: c.id,
        displayName: c.displayName,
        totalOrdersFilled: c.totalOrdersFilled,
        totalVolumeUsd: c.totalVolumeUsd,
        avgRating: c.avgRating,
      }));
    }),

  // Get current user's rank across all boards
  getMyRanks: protectedProcedure.query(async ({ ctx }) => {
    const [volumeBoard, trustBoard] = await Promise.all([
      getVolumeLeaderboard(100),
      getTrustLeaderboard(100),
    ]);

    const volumeRank = volumeBoard.findIndex((u) => u.id === ctx.user.id) + 1;
    const changer = await getChangerByUserId(ctx.user.id);
    const trustRank = changer ? trustBoard.findIndex((c) => c.userId === ctx.user.id) + 1 : 0;

    return {
      volumeRank: volumeRank || null,
      trustRank: trustRank || null,
    };
  }),

  // Get all badge definitions
  getBadgeDefinitions: publicProcedure.query(() => {
    return Object.entries(BADGE_DEFINITIONS).map(([slug, def]) => ({ slug, ...def }));
  }),

  // Get current user's badges
  getMyBadges: protectedProcedure.query(async ({ ctx }) => {
    const earned = await getUserBadges(ctx.user.id);
    const earnedSlugs = new Set(earned.map((b) => b.badgeSlug));
    const allBadges = Object.entries(BADGE_DEFINITIONS).map(([slug, def]) => ({
      slug,
      ...def,
      earned: earnedSlugs.has(slug),
      earnedAt: earned.find((b) => b.badgeSlug === slug)?.earnedAt ?? null,
    }));
    return allBadges;
  }),

  // Get current user's XP and level info
  getMyStats: protectedProcedure.query(async ({ ctx }) => {
    const user = await getUserById(ctx.user.id);
    if (!user) throw new Error("User not found");

    const levelThresholds = {
      novice: { min: 0, max: 99, next: "trader" },
      trader: { min: 100, max: 299, next: "dealer" },
      dealer: { min: 300, max: 799, next: "broker" },
      broker: { min: 800, max: 1999, next: "market_maker" },
      market_maker: { min: 2000, max: 4999, next: "legend" },
      legend: { min: 5000, max: Infinity, next: null },
    };

    const current = levelThresholds[user.level as keyof typeof levelThresholds];
    const xpInLevel = user.xp - current.min;
    const xpForNextLevel = current.max === Infinity ? 0 : current.max - current.min + 1;
    const progressPct = current.max === Infinity ? 100 : Math.round((xpInLevel / xpForNextLevel) * 100);

    return {
      xp: user.xp,
      level: user.level,
      nextLevel: current.next,
      xpInLevel,
      xpForNextLevel,
      progressPct,
      totalTrades: user.totalTrades,
      totalVolumeUsd: user.totalVolumeUsd,
      loginStreak: user.loginStreak,
    };
  }),

  // Award XP and check badges (called server-side after actions)
  awardXP: protectedProcedure
    .input(z.object({ amount: z.number().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      return addXP(ctx.user.id, input.amount);
    }),
});
