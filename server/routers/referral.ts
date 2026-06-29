/**
 * ─── Referral & Points DEX Router ─────────────────────────────────────────────────
 *
 * Handles:
 *   - Referral code generation (unique per user)
 *   - Tracking new signups via referral link
 *   - Points ledger (earn / spend)
 *   - Points stats for the Me tab
 *
 * FEATURE FLAGS
 * ─────────────
 * FEATURES.referralSystem  — controls whether referral links are active.
 *                            Keep OFF until launch. The DB schema and procedures
 *                            are always available; the flag only gates the UI
 *                            display and the trackSignup reward logic.
 * FEATURES.pointsEngine    — controls whether points are awarded for trades,
 *                            quests, milestones, etc.
 *
 * POINT RULES (configurable here)
 * ─────────────────────────────────
 *   Referral signup    → 100 pts to referrer
 *   Referee first trade→ 50 pts to referrer
 *   Trade completed    → 10 pts per trade to trader
 *   Quest completed    → 5 pts per quest
 *   Milestone (10 trades) → 200 pts
 *   Daily login        → 2 pts
 */

import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { users, referrals, pointsTransactions } from "../../drizzle/schema";
import { FEATURES } from "../../shared/features";

// ─── Point rule constants ────────────────────────────────────────────────────
export const POINT_RULES = {
  referral_signup: 100,      // referrer earns when referee signs up
  referral_trade: 50,        // referrer earns when referee completes first trade
  trade_completed: 10,       // trader earns per completed trade
  quest_completed: 5,        // user earns per quest completion
  milestone_reached: 200,    // bonus at 10/50/100/500 trade milestones
  daily_login: 2,            // daily login streak bonus
} as const;

// ─── Helper: generate a unique referral code ─────────────────────────────────
function generateReferralCode(userId: number): string {
  // Format: SFX-{userId padded 4 digits}-{4 random chars}
  const pad = String(userId).padStart(4, "0");
  const rand = nanoid(4).toUpperCase();
  return `SFX${pad}${rand}`;
}

// ─── Helper: award points to a user ──────────────────────────────────────────
export async function awardPoints(opts: {
  userId: number;
  delta: number;
  reason: typeof pointsTransactions.$inferInsert["reason"];
  relatedUserId?: number;
  relatedOrderId?: number;
  relatedQuestId?: string;
  note?: string;
}): Promise<void> {
  if (!FEATURES.pointsEngine) return;
  const db = await getDb();
  if (!db) return;

  await db.transaction(async (tx) => {
    // Insert ledger entry
    await tx.insert(pointsTransactions).values({
      userId: opts.userId,
      delta: opts.delta,
      reason: opts.reason,
      relatedUserId: opts.relatedUserId,
      relatedOrderId: opts.relatedOrderId,
      relatedQuestId: opts.relatedQuestId,
      note: opts.note,
    });

    // Update user's points balance (floor at 0)
    await tx
      .update(users)
      .set({ points: sql`GREATEST(0, points + ${opts.delta})` })
      .where(eq(users.id, opts.userId));
  });
}

// ─── DEX Router ──────────────────────────────────────────────────────────────────
export const referralRouter = router({
  /**
   * Get or create a unique referral code for the current user.
   * Returns the full Telegram deep-link URL and the raw code.
   */
  getMyCode: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      return {
        code: null,
        url: null,
        isEnabled: FEATURES.referralSystem,
      };
    }

    const userId = ctx.user.id;

    // Fetch existing code
    const row = await db
      .select({ referralCode: users.referralCode })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    let code = row[0]?.referralCode ?? null;

    // Auto-generate if missing
    if (!code) {
      code = generateReferralCode(userId);
      await db
        .update(users)
        .set({ referralCode: code })
        .where(eq(users.id, userId));
    }

    const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? "your_bot_username";
    const url = `https://t.me/${botUsername}?start=ref_${code}`;

    return {
      code,
      url,
      isEnabled: FEATURES.referralSystem,
    };
  }),

  /**
   * Called when a new user signs up via a referral link.
   * Idempotent — safe to call multiple times for the same referee.
   *
   * @param referralCode - the code from the deep link (ref_XXXXX)
   */
  trackSignup: publicProcedure
    .input(z.object({ referralCode: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      if (!FEATURES.referralSystem) {
        return { success: false, reason: "referral_system_disabled" };
      }

      const db = await getDb();
      if (!db) return { success: false, reason: "db_unavailable" };

      const refereeId = ctx.user?.id;
      if (!refereeId) return { success: false, reason: "not_authenticated" };

      // Find referrer by code
      const referrerRows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.referralCode, input.referralCode))
        .limit(1);

      const referrerId = referrerRows[0]?.id;
      if (!referrerId) return { success: false, reason: "invalid_code" };
      if (referrerId === refereeId) return { success: false, reason: "self_referral" };

      // Idempotency: check if already tracked
      const existing = await db
        .select({ id: referrals.id })
        .from(referrals)
        .where(eq(referrals.refereeId, refereeId))
        .limit(1);

      if (existing[0]) return { success: true, reason: "already_tracked" };

      // Record referral + award points
      await db.insert(referrals).values({
        referrerId,
        refereeId,
        status: "confirmed",
        pointsAwarded: POINT_RULES.referral_signup,
        confirmedAt: new Date(),
      });

      // Award points to referrer
      await awardPoints({
        userId: referrerId,
        delta: POINT_RULES.referral_signup,
        reason: "referral_signup",
        relatedUserId: refereeId,
        note: `Referee #${refereeId} signed up via your referral link`,
      });

      // Store referredBy on referee
      await db
        .update(users)
        .set({ referredBy: referrerId })
        .where(eq(users.id, refereeId));

      return { success: true, reason: "rewarded" };
    }),

  /**
   * Get referral stats for the current user:
   * - total referrals
   * - total points earned from referrals
   * - recent referral list
   */
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      return {
        totalReferrals: 0,
        totalPointsFromReferrals: 0,
        recentReferrals: [],
        isEnabled: FEATURES.referralSystem,
      };
    }

    const userId = ctx.user.id;

    const myReferrals = await db
      .select({
        id: referrals.id,
        status: referrals.status,
        pointsAwarded: referrals.pointsAwarded,
        createdAt: referrals.createdAt,
      })
      .from(referrals)
      .where(eq(referrals.referrerId, userId))
      .orderBy(desc(referrals.createdAt))
      .limit(20);

    const totalPointsFromReferrals = myReferrals.reduce(
      (sum, r) => sum + (r.pointsAwarded ?? 0),
      0,
    );

    return {
      totalReferrals: myReferrals.length,
      totalPointsFromReferrals,
      recentReferrals: myReferrals.map((r) => ({
        id: r.id,
        status: r.status,
        pointsAwarded: r.pointsAwarded,
        createdAt: r.createdAt,
      })),
      isEnabled: FEATURES.referralSystem,
    };
  }),

  /**
   * Get full points history for the current user.
   */
  getPointsHistory: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { balance: 0, history: [] };

      const userId = ctx.user.id;

      const [userRow, history] = await Promise.all([
        db
          .select({ points: users.points })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1),
        db
          .select()
          .from(pointsTransactions)
          .where(eq(pointsTransactions.userId, userId))
          .orderBy(desc(pointsTransactions.createdAt))
          .limit(input.limit),
      ]);

      return {
        balance: userRow[0]?.points ?? 0,
        history,
      };
    }),
});
