import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  Badge,
  ChangerProfile,
  ChangerRate,
  InsertUser,
  P2POrder,
  Rating,
  SendClaim,
  Transaction,
  User,
  badges,
  changerProfiles,
  changerRates,
  p2pOrders,
  ratings,
  sendClaims,
  transactions,
  users,
  socialLinks,
  SocialLink,
  InsertSocialLink,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};

  const fields = [
    "name", "email", "loginMethod", "telegramId", "telegramUsername",
    "walletAddress", "privyDid", "dexApiKey", "dexApiSecret",
  ] as const;
  for (const f of fields) {
    const v = user[f as keyof InsertUser];
    if (v !== undefined) {
      (values as any)[f] = v ?? null;
      updateSet[f] = v ?? null;
    }
  }

  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }

  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getUserById(id: number): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

export async function updateUserWallet(userId: number, walletAddress: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ walletAddress }).where(eq(users.id, userId));
}

export async function addXP(userId: number, xpAmount: number): Promise<{ newXp: number; leveledUp: boolean; newLevel: string }> {
  const db = await getDb();
  if (!db) return { newXp: 0, leveledUp: false, newLevel: "novice" };

  const user = await getUserById(userId);
  if (!user) return { newXp: 0, leveledUp: false, newLevel: "novice" };

  const newXp = (user.xp || 0) + xpAmount;
  const newLevel = calculateLevel(newXp);
  const leveledUp = newLevel !== user.level;

  await db.update(users).set({ xp: newXp, level: newLevel as any }).where(eq(users.id, userId));
  return { newXp, leveledUp, newLevel };
}

function calculateLevel(xp: number): string {
  if (xp >= 5000) return "legend";
  if (xp >= 2000) return "market_maker";
  if (xp >= 800) return "broker";
  if (xp >= 300) return "dealer";
  if (xp >= 100) return "trader";
  return "novice";
}

// ─── Changer Profiles ─────────────────────────────────────────────────────────

export async function getChangerByUserId(userId: number): Promise<ChangerProfile | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(changerProfiles).where(eq(changerProfiles.userId, userId)).limit(1);
  return result[0];
}

export async function upsertChangerProfile(
  userId: number,
  data: { displayName: string; bio?: string; isActive?: boolean }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await getChangerByUserId(userId);
  if (existing) {
    await db.update(changerProfiles).set({ ...data, updatedAt: new Date() }).where(eq(changerProfiles.userId, userId));
  } else {
    await db.insert(changerProfiles).values({ userId, displayName: data.displayName, bio: data.bio, isActive: data.isActive ?? false });
  }
}

export async function listActiveChangers(limit = 50): Promise<(ChangerProfile & { user: User })[]> {
  const db = await getDb();
  if (!db) return [];
  const result = await db
    .select()
    .from(changerProfiles)
    .innerJoin(users, eq(changerProfiles.userId, users.id))
    .where(eq(changerProfiles.isActive, true))
    .orderBy(desc(changerProfiles.reputationScore))
    .limit(limit);
  return result.map((r) => ({ ...r.changer_profiles, user: r.users }));
}

export async function updateChangerReputation(changerId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const changer = await db.select().from(changerProfiles).where(eq(changerProfiles.id, changerId)).limit(1);
  if (!changer[0]) return;

  const c = changer[0];
  const avgRating = c.avgRating || 0;
  const completionRate = c.completionRate || 100;
  const volumeUsd = parseFloat(c.totalVolumeUsd || "0");
  const volumeTier = Math.min(volumeUsd / 10000, 1); // 0-1 based on $10k max
  const speedScore = 0.8; // placeholder

  const score = avgRating * 20 + completionRate * 0.3 + volumeTier * 30 + speedScore * 20;
  await db.update(changerProfiles).set({ reputationScore: Math.min(score, 100) }).where(eq(changerProfiles.id, changerId));
}

// ─── Changer Rates ────────────────────────────────────────────────────────────

export async function getChangerRates(changerId: number): Promise<ChangerRate[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(changerRates).where(and(eq(changerRates.changerId, changerId), eq(changerRates.isActive, true)));
}

export async function upsertChangerRate(
  changerId: number,
  fromToken: string,
  toToken: string,
  spreadBps: number,
  minAmount: string,
  maxAmount: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select()
    .from(changerRates)
    .where(and(eq(changerRates.changerId, changerId), eq(changerRates.fromToken, fromToken), eq(changerRates.toToken, toToken)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(changerRates)
      .set({ spreadBps, minAmount, maxAmount, updatedAt: new Date() })
      .where(eq(changerRates.id, existing[0].id));
  } else {
    await db.insert(changerRates).values({ changerId, fromToken, toToken, spreadBps, minAmount, maxAmount });
  }
}

// ─── P2P Orders ───────────────────────────────────────────────────────────────

export async function createP2POrder(data: {
  changerId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  spreadBps: number;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(p2pOrders).values({
    ...data,
    status: "pending",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
  });
  return ((result as any).insertId ?? (result as any)[0]?.insertId) as number;
}

export async function getUserOrders(userId: number, limit = 20): Promise<P2POrder[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(p2pOrders)
    .where(eq(p2pOrders.takerId, userId))
    .orderBy(desc(p2pOrders.createdAt))
    .limit(limit);
}

// ─── Send Claims ──────────────────────────────────────────────────────────────

export async function createSendClaim(data: {
  senderId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  estimatedToAmount: string;
  message?: string;
  claimUuid: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(sendClaims).values({
    ...data,
    status: "pending",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
  });
  return ((result as any).insertId ?? (result as any)[0]?.insertId) as number;
}

export async function getSendClaimByUuid(uuid: string): Promise<SendClaim | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(sendClaims).where(eq(sendClaims.claimUuid, uuid)).limit(1);
  return result[0];
}

export async function getPendingClaimsBySender(senderId: number): Promise<SendClaim[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(sendClaims)
    .where(and(eq(sendClaims.senderId, senderId), eq(sendClaims.status, "pending")))
    .orderBy(desc(sendClaims.createdAt));
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function createTransaction(data: {
  userId: number;
  type: "swap" | "send" | "receive" | "fill_order" | "arb";
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount?: string;
  valueUsd?: string;
  txHash?: string;
  status?: "pending" | "completed" | "failed";
  xpEarned?: number;
  relatedOrderId?: number;
  relatedClaimId?: number;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(transactions).values({ ...data, status: data.status ?? "pending" });
  return ((result as any).insertId ?? (result as any)[0]?.insertId) as number;
}

export async function getUserTransactions(userId: number, limit = 30): Promise<Transaction[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}

// ─── Badges ───────────────────────────────────────────────────────────────────

export async function getUserBadges(userId: number): Promise<Badge[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(badges).where(eq(badges.userId, userId)).orderBy(desc(badges.earnedAt));
}

export async function awardBadge(userId: number, badgeSlug: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const existing = await db
    .select()
    .from(badges)
    .where(and(eq(badges.userId, userId), eq(badges.badgeSlug, badgeSlug)))
    .limit(1);
  if (existing[0]) return false; // already has it
  await db.insert(badges).values({ userId, badgeSlug });
  return true;
}

// ─── Ratings ──────────────────────────────────────────────────────────────────

export async function submitRating(data: {
  raterId: number;
  rateeId: number;
  orderId: number;
  score: number;
  comment?: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(ratings).values(data);

  // Update changer avg rating
  const changer = await getChangerByUserId(data.rateeId);
  if (changer) {
    const allRatings = await db.select().from(ratings).where(eq(ratings.rateeId, data.rateeId));
    const avg = allRatings.reduce((s, r) => s + r.score, 0) / allRatings.length;
    await db
      .update(changerProfiles)
      .set({ avgRating: avg, totalRatings: allRatings.length })
      .where(eq(changerProfiles.userId, data.rateeId));
    await updateChangerReputation(changer.id);
  }
}

export async function getChangerRatings(changerId: number, limit = 20): Promise<Rating[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(ratings)
    .where(eq(ratings.rateeId, changerId))
    .orderBy(desc(ratings.createdAt))
    .limit(limit);
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export async function getVolumeLeaderboard(limit = 20): Promise<User[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.totalVolumeUsd)).limit(limit);
}

export async function getTrustLeaderboard(limit = 20): Promise<ChangerProfile[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(changerProfiles)
    .where(eq(changerProfiles.isActive, true))
    .orderBy(desc(changerProfiles.reputationScore))
    .limit(limit);
}

export async function getRatesLeaderboard(limit = 20): Promise<ChangerProfile[]> {
  const db = await getDb();
  if (!db) return [];
  // Tightest average spread wins
  return db
    .select()
    .from(changerProfiles)
    .where(eq(changerProfiles.isActive, true))
    .orderBy(desc(changerProfiles.totalOrdersFilled))
    .limit(limit);
}

// ─── Social Links ─────────────────────────────────────────────────────────────

export async function getSocialLinks(userId: number): Promise<SocialLink[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(socialLinks).where(eq(socialLinks.userId, userId));
}

export async function upsertSocialLink(
  userId: number,
  platform: InsertSocialLink["platform"],
  handle: string,
  xpAwarded: number,
): Promise<SocialLink | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  // Check if already linked
  const existing = await db
    .select()
    .from(socialLinks)
    .where(and(eq(socialLinks.userId, userId), eq(socialLinks.platform, platform)))
    .limit(1);

  if (existing[0]) {
    // Update handle
    await db
      .update(socialLinks)
      .set({ handle, isVerified: true, updatedAt: new Date() })
      .where(eq(socialLinks.id, existing[0].id));
    const updated = await db.select().from(socialLinks).where(eq(socialLinks.id, existing[0].id)).limit(1);
    return updated[0];
  }

  // Insert new
  await db.insert(socialLinks).values({
    userId,
    platform,
    handle,
    isVerified: true,
    xpAwarded,
  });
  const inserted = await db
    .select()
    .from(socialLinks)
    .where(and(eq(socialLinks.userId, userId), eq(socialLinks.platform, platform)))
    .limit(1);
  return inserted[0];
}

export async function deleteSocialLink(userId: number, platform: InsertSocialLink["platform"]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(socialLinks).where(and(eq(socialLinks.userId, userId), eq(socialLinks.platform, platform)));
}

export async function getUserByTelegramId(telegramId: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.telegramId, telegramId)).limit(1);
  return result[0];
}
