import { z } from "zod";
import { eq, and, count, sql } from "drizzle-orm";
import { getDb } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { questCompletions, transactions, users } from "../../drizzle/schema";
import { awardPoints } from "./referral";
import { ENV } from "../_core/env";

// Sepolia-preview gate: while FEATURE_MAINNET=false, only referral quests
// pay XP/points. Every other quest still records a completion (so progress
// persists) but XP accrues into users.pendingQuestXp and points are
// withheld. A cutover migration credits both at mainnet flip.
function shouldGateForBeta(quest: QuestDef): boolean {
  if (ENV.featureMainnet) return false;
  return quest.requirement.type !== "referral";
}

// ─── Quest Definitions ────────────────────────────────────────────────────────

export interface QuestDef {
  id: string;
  category: "trading" | "social" | "partner" | "streak";
  title: string;
  description: string;
  xpReward: number;
  icon: string;
  requirement: {
    type: "swap_count" | "swap_volume" | "send_count" | "p2p_count" | "login_streak" | "referral" | "manual";
    value: number;
  };
  repeatable: boolean;
}

export const QUEST_DEFINITIONS: QuestDef[] = [
  // Trading quests
  {
    id: "first_swap",
    category: "trading",
    title: "First Swap",
    description: "Complete your first token swap",
    xpReward: 100,
    icon: "⇄",
    requirement: { type: "swap_count", value: 1 },
    repeatable: false,
  },
  {
    id: "swap_5",
    category: "trading",
    title: "Getting Started",
    description: "Complete 5 swaps",
    xpReward: 250,
    icon: "📈",
    requirement: { type: "swap_count", value: 5 },
    repeatable: false,
  },
  {
    id: "swap_25",
    category: "trading",
    title: "Active Trader",
    description: "Complete 25 swaps",
    xpReward: 750,
    icon: "🏃",
    requirement: { type: "swap_count", value: 25 },
    repeatable: false,
  },
  {
    id: "volume_100",
    category: "trading",
    title: "Century Club",
    description: "Trade $100 total volume",
    xpReward: 200,
    icon: "💯",
    requirement: { type: "swap_volume", value: 100 },
    repeatable: false,
  },
  {
    id: "volume_1000",
    category: "trading",
    title: "Grand Trader",
    description: "Trade $1,000 total volume",
    xpReward: 500,
    icon: "💰",
    requirement: { type: "swap_volume", value: 1000 },
    repeatable: false,
  },
  {
    id: "volume_10000",
    category: "trading",
    title: "Whale",
    description: "Trade $10,000 total volume",
    xpReward: 2000,
    icon: "🐋",
    requirement: { type: "swap_volume", value: 10000 },
    repeatable: false,
  },
  // Send quests
  {
    id: "first_send",
    category: "trading",
    title: "First Send",
    description: "Send tokens to another wallet",
    xpReward: 150,
    icon: "↗",
    requirement: { type: "send_count", value: 1 },
    repeatable: false,
  },
  {
    id: "send_5",
    category: "trading",
    title: "Generous Sender",
    description: "Send tokens 5 times",
    xpReward: 400,
    icon: "🎁",
    requirement: { type: "send_count", value: 5 },
    repeatable: false,
  },
  // P2P quests
  {
    id: "first_p2p",
    category: "trading",
    title: "P2P Pioneer",
    description: "Complete your first P2P trade",
    xpReward: 200,
    icon: "🤝",
    requirement: { type: "p2p_count", value: 1 },
    repeatable: false,
  },
  {
    id: "p2p_5",
    category: "trading",
    title: "P2P Veteran",
    description: "Complete 5 P2P trades",
    xpReward: 600,
    icon: "🏆",
    requirement: { type: "p2p_count", value: 5 },
    repeatable: false,
  },
  // Streak quests
  {
    id: "streak_3",
    category: "streak",
    title: "3-Day Streak",
    description: "Log in 3 days in a row",
    xpReward: 150,
    icon: "🔥",
    requirement: { type: "login_streak", value: 3 },
    repeatable: false,
  },
  {
    id: "streak_7",
    category: "streak",
    title: "Week Warrior",
    description: "Log in 7 days in a row",
    xpReward: 400,
    icon: "🔥",
    requirement: { type: "login_streak", value: 7 },
    repeatable: false,
  },
  {
    id: "streak_30",
    category: "streak",
    title: "Monthly Master",
    description: "Log in 30 days in a row",
    xpReward: 2000,
    icon: "🌟",
    requirement: { type: "login_streak", value: 30 },
    repeatable: false,
  },
  // Social quests
  {
    id: "first_referral",
    category: "social",
    title: "Spread the Word",
    description: "Refer your first friend to this app",
    xpReward: 500,
    icon: "🔗",
    requirement: { type: "referral", value: 1 },
    repeatable: false,
  },
  {
    id: "referral_5",
    category: "social",
    title: "Community Builder",
    description: "Refer 5 friends to this app",
    xpReward: 2000,
    icon: "👥",
    requirement: { type: "referral", value: 5 },
    repeatable: false,
  },
  // Partner quests
  {
    id: "visit_asktian",
    category: "partner",
    title: "Seek Your Destiny",
    description: "Visit Asktian - web3 spiritual destiny platform",
    xpReward: 200,
    icon: "☯️",
    requirement: { type: "manual", value: 1 },
    repeatable: false,
  },
  {
    id: "visit_youapp",
    category: "partner",
    title: "Discover the World",
    description: "Explore YouApp - local experiences platform",
    xpReward: 200,
    icon: "🌍",
    requirement: { type: "manual", value: 1 },
    repeatable: false,
  },
  {
    id: "share_app",
    category: "social",
    title: "App Ambassador",
    description: "Share this app on Telegram",
    xpReward: 100,
    icon: "📣",
    requirement: { type: "manual", value: 1 },
    repeatable: true,
  },
];

// ─── Helper: compute quest progress for a user ────────────────────────────────

async function computeProgress(userId: number) {
  const db = await getDb();
  if (!db) {
    return {
      swapCount: 0,
      sendCount: 0,
      p2pCount: 0,
      referralCount: 0,
      totalVolumeUsd: 0,
      loginStreak: 0,
      completedIds: new Set<string>(),
    };
  }

  // Get user stats
  const [userRow] = await db
    .select({ loginStreak: users.loginStreak, totalVolumeUsd: users.totalVolumeUsd })
    .from(users)
    .where(eq(users.id, userId));

  // Count swaps
  const [swapRow] = await db
    .select({ cnt: count() })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.type, "swap")));
  const swapCount = swapRow?.cnt ?? 0;

  // Count sends
  const [sendRow] = await db
    .select({ cnt: count() })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.type, "send")));
  const sendCount = sendRow?.cnt ?? 0;

  // Count P2P fills
  const [p2pRow] = await db
    .select({ cnt: count() })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.type, "fill_order")));
  const p2pCount = p2pRow?.cnt ?? 0;

  // Count referrals
  const [refRow] = await db
    .select({ cnt: count() })
    .from(users)
    .where(eq(users.referredBy, userId));
  const referralCount = refRow?.cnt ?? 0;

  // Get completed quest IDs
  const completed = await db
    .select({ questId: questCompletions.questId })
    .from(questCompletions)
    .where(eq(questCompletions.userId, userId));
  const completedIds = new Set(completed.map((r: { questId: string }) => r.questId));

  const totalVolumeUsd = parseFloat(String(userRow?.totalVolumeUsd ?? "0"));
  const loginStreak = userRow?.loginStreak ?? 0;

  return { swapCount, sendCount, p2pCount, referralCount, totalVolumeUsd, loginStreak, completedIds };
}

function getQuestCurrentValue(
  questDef: QuestDef,
  stats: {
    swapCount: number;
    sendCount: number;
    p2pCount: number;
    referralCount: number;
    totalVolumeUsd: number;
    loginStreak: number;
  }
): number {
  switch (questDef.requirement.type) {
    case "swap_count":   return stats.swapCount;
    case "swap_volume":  return stats.totalVolumeUsd;
    case "send_count":   return stats.sendCount;
    case "p2p_count":    return stats.p2pCount;
    case "login_streak": return stats.loginStreak;
    case "referral":     return stats.referralCount;
    case "manual":       return 0;
    default:             return 0;
  }
}

// ─── DEX Router ───────────────────────────────────────────────────────────────────

export const questsRouter = router({
  // List all quests with user progress
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const stats = await computeProgress(userId);

    return QUEST_DEFINITIONS.map((q) => {
      const isCompleted = stats.completedIds.has(q.id);
      const currentValue = getQuestCurrentValue(q, stats);
      const progress = Math.min(currentValue / q.requirement.value, 1);
      const canClaim =
        !isCompleted &&
        q.requirement.type !== "manual" &&
        progress >= 1;

      return { ...q, isCompleted, currentValue, progress, canClaim };
    });
  }),

  // Claim a completed auto-progress quest reward
  claim: protectedProcedure
    .input(z.object({ questId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const userId = ctx.user.id;
      const quest = QUEST_DEFINITIONS.find((q) => q.id === input.questId);
      if (!quest) throw new Error("Quest not found");

      const existing = await db
        .select()
        .from(questCompletions)
        .where(and(eq(questCompletions.userId, userId), eq(questCompletions.questId, input.questId)));
      if (existing.length > 0 && !quest.repeatable) throw new Error("Quest already claimed");

      if (quest.requirement.type !== "manual") {
        const stats = await computeProgress(userId);
        const currentValue = getQuestCurrentValue(quest, stats);
        if (currentValue < quest.requirement.value) throw new Error("Quest requirements not met");
      }

      const gated = shouldGateForBeta(quest);

      // Record completion either way so progress persists across mainnet
      // cutover; the xpAwarded column always reflects what the quest is
      // worth, the gate decides whether users.xp is touched today.
      await db.insert(questCompletions).values({ userId, questId: input.questId, xpAwarded: quest.xpReward });

      if (gated) {
        await db.update(users)
          .set({ pendingQuestXp: sql`${users.pendingQuestXp} + ${quest.xpReward}` })
          .where(eq(users.id, userId));
        return { success: true, xpAwarded: 0, queuedXp: quest.xpReward, gated: true };
      }

      await db.update(users).set({ xp: sql`${users.xp} + ${quest.xpReward}` }).where(eq(users.id, userId));
      // Award points for quest completion
      await awardPoints({ userId, delta: 5, reason: "quest_completed", relatedQuestId: input.questId });

      return { success: true, xpAwarded: quest.xpReward, gated: false };
    }),

  // Claim a manual quest (partner visit, share, etc.)
  claimManual: protectedProcedure
    .input(z.object({ questId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const userId = ctx.user.id;
      const quest = QUEST_DEFINITIONS.find((q) => q.id === input.questId && q.requirement.type === "manual");
      if (!quest) throw new Error("Quest not found or not a manual quest");

      const existing = await db
        .select()
        .from(questCompletions)
        .where(and(eq(questCompletions.userId, userId), eq(questCompletions.questId, input.questId)));
      if (existing.length > 0 && !quest.repeatable) throw new Error("Quest already claimed");

      const gated = shouldGateForBeta(quest);
      await db.insert(questCompletions).values({ userId, questId: input.questId, xpAwarded: quest.xpReward });

      if (gated) {
        await db.update(users)
          .set({ pendingQuestXp: sql`${users.pendingQuestXp} + ${quest.xpReward}` })
          .where(eq(users.id, userId));
        return { success: true, xpAwarded: 0, queuedXp: quest.xpReward, gated: true };
      }

      await db.update(users).set({ xp: sql`${users.xp} + ${quest.xpReward}` }).where(eq(users.id, userId));
      // Award points for manual quest completion
      await awardPoints({ userId, delta: 5, reason: "quest_completed", relatedQuestId: input.questId });

      return { success: true, xpAwarded: quest.xpReward, gated: false };
    }),
});
