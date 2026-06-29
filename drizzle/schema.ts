import {
  bigint,
  decimal,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  boolean,
  float,
} from "drizzle-orm/mysql-core";
import { nanoid } from "nanoid";

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  // Privy is the canonical identity once FEATURE_PRIVY_AUTH is on. Each Privy
  // user has a globally unique DID like "did:privy:abc123". Nullable so the
  // legacy cookie-auth path keeps working until cutover.
  privyDid: varchar("privyDid", { length: 80 }),
  telegramId: varchar("telegramId", { length: 32 }),
  telegramUsername: varchar("telegramUsername", { length: 64 }),
  telegramChatId: bigint("telegramChatId", { mode: "number" }),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  // Wallet — supplied by Privy (embedded or external). Server never holds keys.
  walletAddress: varchar("walletAddress", { length: 42 }),
  // Per-user the venue REST API credentials (provisioned lazily on first call after
  // Privy login). Secret is AES-256-GCM-encrypted via server/lib/crypto.ts.
  dexApiKey: varchar("dexApiKey", { length: 64 }),
  dexApiSecret: text("dexApiSecret"),
  // Testnet auto-fund-on-import status: null | "funding" | "ready" | "skipped" | "error:<msg>"
  testnetFundStatus: varchar("testnetFundStatus", { length: 160 }),
  // Gamification
  xp: int("xp").default(0).notNull(),
  level: mysqlEnum("level", ["novice", "trader", "dealer", "broker", "market_maker", "legend"])
    .default("novice")
    .notNull(),
  totalVolumeUsd: decimal("totalVolumeUsd", { precision: 18, scale: 2 }).default("0").notNull(),
  totalTrades: int("totalTrades").default(0).notNull(),
  referralCode: varchar("referralCode", { length: 16 }),
  referredBy: int("referredBy"),
  // Points (separate from XP — spendable currency for shop/boosts)
  points: int("points").default(0).notNull(),
  // XP accrued from non-referral quest claims while FEATURE_MAINNET=false.
  // A cutover migration credits this into users.xp and zeroes it out when
  // we flip to mainnet, so users keep all earned progress.
  pendingQuestXp: int("pendingQuestXp").default(0).notNull(),
  loginStreak: int("loginStreak").default(0).notNull(),
  lastLoginDate: timestamp("lastLoginDate"),
  // JSON array of onboarding keys the user has already seen (tutorial tabs +
  // explainer videos). Persisted server-side so it survives across app opens —
  // the Telegram WebView does NOT reliably keep localStorage.
  onboardingSeen: text("onboardingSeen"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Changer Profiles ─────────────────────────────────────────────────────────

export const changerProfiles = mysqlTable("changer_profiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  displayName: varchar("displayName", { length: 64 }).notNull(),
  bio: text("bio"),
  avatarUrl: text("avatarUrl"),
  isActive: boolean("isActive").default(false).notNull(),
  reputationScore: float("reputationScore").default(0).notNull(),
  avgRating: float("avgRating").default(0).notNull(),
  totalRatings: int("totalRatings").default(0).notNull(),
  completionRate: float("completionRate").default(100).notNull(),
  completionRate30d: float("completionRate30d").default(100).notNull(),
  totalOrdersFilled: int("totalOrdersFilled").default(0).notNull(),
  totalOrders30d: int("totalOrders30d").default(0).notNull(),
  avgSettlementMinutes: float("avgSettlementMinutes").default(2).notNull(),
  totalVolumeUsd: decimal("totalVolumeUsd", { precision: 18, scale: 2 }).default("0").notNull(),
  telegramHandle: varchar("telegramHandle", { length: 64 }),
  location: varchar("location", { length: 64 }),
  // Promotion
  promotionTier: mysqlEnum("promotionTier", ["none", "boosted", "highlighted", "pinned"])
    .default("none")
    .notNull(),
  promotionExpiresAt: timestamp("promotionExpiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ChangerProfile = typeof changerProfiles.$inferSelect;

// ─── Changer Rates ────────────────────────────────────────────────────────────

export const changerRates = mysqlTable("changer_rates", {
  id: int("id").autoincrement().primaryKey(),
  changerId: int("changerId").notNull(),
  fromToken: varchar("fromToken", { length: 16 }).notNull(),
  toToken: varchar("toToken", { length: 16 }).notNull(),
  spreadBps: int("spreadBps").default(30).notNull(), // basis points, e.g. 30 = 0.3%
  minAmount: decimal("minAmount", { precision: 18, scale: 6 }).default("1").notNull(),
  maxAmount: decimal("maxAmount", { precision: 18, scale: 6 }).default("10000").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ChangerRate = typeof changerRates.$inferSelect;

// ─── P2P Ads (Liquidity Positions) ──────────────────────────────────────────
// An ad is a standing liquidity offer posted by any user (not just registered changers).
// It represents pledged liquidity available for matching.

export const p2pAds = mysqlTable("p2p_ads", {
  id: int("id").autoincrement().primaryKey(),
  posterId: int("posterId").notNull(),          // user who posted the ad
  changerId: int("changerId"),                  // optional: linked changer profile
  // Ad type: swap = stablecoin-to-stablecoin (main), buy = on-ramp, sell = off-ramp
  adType: mysqlEnum("adType", ["swap", "buy", "sell"]).default("swap").notNull(),
  fromToken: varchar("fromToken", { length: 16 }).notNull(),  // token poster has
  toToken: varchar("toToken", { length: 16 }).notNull(),      // token poster wants
  // Rate: how many toToken per 1 fromToken
  rate: decimal("rate", { precision: 18, scale: 8 }).notNull(),
  // Available liquidity (fromToken amount)
  liquidity: decimal("liquidity", { precision: 18, scale: 6 }).notNull(),
  liquidityRemaining: decimal("liquidityRemaining", { precision: 18, scale: 6 }).notNull(),
  // Order limits (in fromToken)
  minOrder: decimal("minOrder", { precision: 18, scale: 6 }).default("10").notNull(),
  maxOrder: decimal("maxOrder", { precision: 18, scale: 6 }).notNull(),
  // Optional terms/notes shown to takers
  terms: text("terms"),
  // For on/off ramp ads: accepted payment methods (JSON array)
  paymentMethods: text("paymentMethods"),
  status: mysqlEnum("status", ["active", "paused", "cancelled", "exhausted"])
    .default("active")
    .notNull(),
  // Promotion
  promotionTier: mysqlEnum("promotionTier", ["none", "boosted", "highlighted", "pinned"])
    .default("none")
    .notNull(),
  promotionExpiresAt: timestamp("promotionExpiresAt"),
  // the venue limit-order linkage (Phase 5). Populated when the ad is "live on
  // the venue". Null for pure-database ads from before the cutover, or for fiat
  // ramps that don't sit on the order book.
  settlementOrderId: varchar("settlementOrderId", { length: 66 }),
  settlementOrderUuidInt: varchar("settlementOrderUuidInt", { length: 80 }),
  settlementOrderStatus: mysqlEnum("settlementOrderStatus", [
    "pending", "matched", "settled", "cancelled", "failed",
  ]),
  // Set when the maker has deposited liquidity into the Vault but the
  // signed Order has not yet been accepted by the venue. Lets the UI surface
  // a "Retry placement" CTA so a partial failure (deposit ok, order not)
  // doesn't strand funds in the vault with no recovery path.
  settlementDepositTxHash: varchar("settlementDepositTxHash", { length: 66 }),
  // Stats
  totalFills: int("totalFills").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  expiresAt: timestamp("expiresAt"),
}, (table) => ({
  // Cancellation lookup path: server matches incoming cancel callbacks by
  // settlementOrderId. Browse "active ads" filters on (posterId, status).
  settlementOrderIdx: index("idx_p2p_ads_settlement_order_id").on(table.settlementOrderId),
  posterStatusIdx: index("idx_p2p_ads_poster_status").on(table.posterId, table.status),
}));

export type P2PAd = typeof p2pAds.$inferSelect;

// ─── P2P Orders ───────────────────────────────────────────────────────────────

export const p2pOrders = mysqlTable("p2p_orders", {
  id: int("id").autoincrement().primaryKey(),
  adId: int("adId"),                              // linked ad (if placed via ad)
  changerId: int("changerId").notNull(),
  takerId: int("takerId"),
  fromToken: varchar("fromToken", { length: 16 }).notNull(),
  toToken: varchar("toToken", { length: 16 }).notNull(),
  fromAmount: decimal("fromAmount", { precision: 18, scale: 6 }).notNull(),
  toAmount: decimal("toAmount", { precision: 18, scale: 6 }),
  rateUsed: decimal("rateUsed", { precision: 18, scale: 8 }),
  spreadBps: int("spreadBps"),
  // Fiat fields (for buy/sell/on-ramp/off-ramp orders)
  adType: mysqlEnum("adType", ["swap", "buy", "sell"]).default("swap").notNull(),
  fiatAmount: decimal("fiatAmount", { precision: 18, scale: 2 }),
  fiatCurrency: varchar("fiatCurrency", { length: 8 }),
  paymentMethod: varchar("paymentMethod", { length: 64 }),
  // Full state machine
  status: mysqlEnum("status", [
    "pending",       // order placed, not yet escrowed
    "escrowed",      // stablecoin locked in escrow (DB lock)
    "payment_sent",  // fiat payer tapped 'I've Paid'
    "completed",     // fiat receiver confirmed, escrow released
    "cancelled",     // cancelled before escrow
    "disputed",      // dispute raised after escrow
    "resolved",      // admin resolved dispute
    "refunded",      // escrow returned to sender
    "filled",        // legacy: swap order filled
    "expired",       // order expired
  ])
    .default("pending")
    .notNull(),
  txHash: varchar("txHash", { length: 66 }),
  settlementOrderId: varchar("settlementOrderId", { length: 66 }),
  isRatedByTaker: boolean("isRatedByTaker").default(false).notNull(),
  isRatedByChanger: boolean("isRatedByChanger").default(false).notNull(),
  disputeReason: text("disputeReason"),
  adminNote: text("adminNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  escrowLockedAt: timestamp("escrowLockedAt"),
  paidAt: timestamp("paidAt"),
  completedAt: timestamp("completedAt"),
  filledAt: timestamp("filledAt"),
  expiresAt: timestamp("expiresAt"),
});

export type P2POrder = typeof p2pOrders.$inferSelect;

// ─── Send Claims (Cross-Currency Payments) ────────────────────────────────────

export const sendClaims = mysqlTable("send_claims", {
  id: int("id").autoincrement().primaryKey(),
  senderId: int("senderId").notNull(),
  recipientId: int("recipientId"),
  claimUuid: varchar("claimUuid", { length: 36 }).notNull().unique(),
  fromToken: varchar("fromToken", { length: 16 }).notNull(),
  toToken: varchar("toToken", { length: 16 }).notNull(),
  fromAmount: decimal("fromAmount", { precision: 18, scale: 6 }).notNull(),
  toAmount: decimal("toAmount", { precision: 18, scale: 6 }),
  estimatedToAmount: decimal("estimatedToAmount", { precision: 18, scale: 6 }),
  status: mysqlEnum("status", ["pending", "claimed", "expired", "cancelled"])
    .default("pending")
    .notNull(),
  txHash: varchar("txHash", { length: 66 }),
  recipientWallet: varchar("recipientWallet", { length: 42 }),
  message: text("message"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  claimedAt: timestamp("claimedAt"),
});

export type SendClaim = typeof sendClaims.$inferSelect;

// ─── Transactions ─────────────────────────────────────────────────────────────

export const transactions = mysqlTable("transactions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["swap", "send", "receive", "fill_order", "arb"])
    .notNull(),
  fromToken: varchar("fromToken", { length: 16 }).notNull(),
  toToken: varchar("toToken", { length: 16 }).notNull(),
  fromAmount: decimal("fromAmount", { precision: 18, scale: 6 }).notNull(),
  toAmount: decimal("toAmount", { precision: 18, scale: 6 }),
  valueUsd: decimal("valueUsd", { precision: 18, scale: 2 }),
  txHash: varchar("txHash", { length: 66 }),
  status: mysqlEnum("status", ["pending", "completed", "failed"])
    .default("pending")
    .notNull(),
  relatedOrderId: int("relatedOrderId"),
  relatedClaimId: int("relatedClaimId"),
  xpEarned: int("xpEarned").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Transaction = typeof transactions.$inferSelect;

// ─── Badges ───────────────────────────────────────────────────────────────────

export const badges = mysqlTable("badges", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  badgeSlug: varchar("badgeSlug", { length: 64 }).notNull(),
  earnedAt: timestamp("earnedAt").defaultNow().notNull(),
});

export type Badge = typeof badges.$inferSelect;

// ─── Ratings ──────────────────────────────────────────────────────────────────

export const ratings = mysqlTable("ratings", {
  id: int("id").autoincrement().primaryKey(),
  raterId: int("raterId").notNull(),
  rateeId: int("rateeId").notNull(),
  orderId: int("orderId").notNull(),
  score: int("score").notNull(), // 1-5
  comment: text("comment"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Rating = typeof ratings.$inferSelect;

// ─── Promotions ───────────────────────────────────────────────────────────────

export const promotions = mysqlTable("promotions", {
  id: int("id").autoincrement().primaryKey(),
  changerId: int("changerId").notNull(),
  tier: mysqlEnum("tier", ["boosted", "highlighted", "pinned"]).notNull(),
  paidAmountUsdt: decimal("paidAmountUsdt", { precision: 18, scale: 6 }).notNull(),
  startsAt: timestamp("startsAt").defaultNow().notNull(),
  endsAt: timestamp("endsAt").notNull(),
  txHash: varchar("txHash", { length: 66 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Promotion = typeof promotions.$inferSelect;

// ─── Quest Completions ────────────────────────────────────────────────────────

export const questCompletions = mysqlTable("quest_completions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  questId: varchar("questId", { length: 64 }).notNull(),
  completedAt: timestamp("completedAt").defaultNow().notNull(),
  xpAwarded: int("xpAwarded").default(0).notNull(),
});

export type QuestCompletion = typeof questCompletions.$inferSelect;

// ─── Wallet Keys ──────────────────────────────────────────────────────────────

export const walletKeys = mysqlTable("wallet_keys", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  address: varchar("address", { length: 42 }).notNull().unique(),
  encryptedKey: text("encryptedKey").notNull(),
  // true = the user imported their own private key; false = legacy auto-generated.
  imported: boolean("imported").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type WalletKey = typeof walletKeys.$inferSelect;

// ─ Referrals ───────────────────────────────────────────────────────────────────────────────
// One row per successful referral (referrer invited referee, referee signed up).

export const referrals = mysqlTable("referrals", {
  id: int("id").autoincrement().primaryKey(),
  referrerId: int("referrerId").notNull(),      // user who shared the link
  refereeId: int("refereeId").notNull().unique(), // new user who joined via link
  status: mysqlEnum("status", ["pending", "confirmed", "rewarded"])
    .default("pending")
    .notNull(),
  pointsAwarded: int("pointsAwarded").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  confirmedAt: timestamp("confirmedAt"),
  rewardedAt: timestamp("rewardedAt"),
});

export type Referral = typeof referrals.$inferSelect;

// ─ Points Transactions ──────────────────────────────────────────────────────────────────
// Immutable ledger of every points award/deduction.

export const pointsTransactions = mysqlTable("points_transactions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  delta: int("delta").notNull(),               // positive = earn, negative = spend
  reason: mysqlEnum("reason", [
    "referral_signup",   // referee signed up via your link
    "referral_trade",    // referee completed their first trade
    "trade_completed",   // you completed a trade
    "quest_completed",   // you finished a quest
    "milestone_reached", // volume/trade-count milestone
    "daily_login",       // daily login streak bonus
    "admin_grant",       // manual admin award
    "spend",             // points spent (shop, boost, etc.)
  ]).notNull(),
  relatedUserId: int("relatedUserId"),          // e.g. the referee for referral_signup
  relatedOrderId: int("relatedOrderId"),
  relatedQuestId: varchar("relatedQuestId", { length: 64 }),
  note: text("note"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PointsTransaction = typeof pointsTransactions.$inferSelect;

// ─── Social Links ─────────────────────────────────────────────────────────────
// One row per linked social account per user.

export const socialLinks = mysqlTable("social_links", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  platform: mysqlEnum("platform", ["x", "whatsapp", "gmail", "instagram", "linkedin"])
    .notNull(),
  handle: varchar("handle", { length: 256 }).notNull(),   // @username, phone, or email
  isVerified: boolean("isVerified").default(false).notNull(), // true once handle confirmed
  xpAwarded: int("xpAwarded").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type SocialLink = typeof socialLinks.$inferSelect;
export type InsertSocialLink = typeof socialLinks.$inferInsert;

// ─── Bot Recommendations (Phase R1: signal engine) ────────────────────────────
//
// The recommendation bot is a server-side worker that watches the venue + our DB
// every ~60s and emits actionable signals to subscribed users via Telegram +
// the in-app Signals tab. It does NOT execute trades — users follow signals
// manually through the existing Take-Offer / Cancel-Position / etc. flows.
// Outcome tracking (recommendation_outcomes) lets us prove which signal
// types actually result in profitable trades before we automate execution.

export const botRecommendations = mysqlTable("bot_recommendations", {
  id: int("id").autoincrement().primaryKey(),
  // best_rate | stale_offer | wide_spread | (future strategies)
  type: mysqlEnum("type", ["best_rate", "stale_offer", "wide_spread"]).notNull(),
  // FX pair the signal applies to, e.g. "USDT/XSGD" — null for portfolio-level
  marketSymbol: varchar("marketSymbol", { length: 32 }),
  // For best_rate / stale_offer: the related ad we're flagging
  relatedAdId: int("relatedAdId"),
  // Higher = more attractive. bps for best_rate (5 = 5bps better than market),
  // absolute bps drift for stale_offer, total spread for wide_spread.
  opportunityScore: float("opportunityScore").notNull(),
  // Free-form JSON payload — render fields like { rate, market, etherscan… }
  payload: text("payload").notNull(),
  // Soft expiry: signals stop showing after this. Worker also dedupes by
  // (type, marketSymbol, relatedAdId) within the active window so we don't
  // repeat the same alert every cycle.
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  typeIdx: index("idx_bot_rec_type_expires").on(table.type, table.expiresAt),
  adIdx: index("idx_bot_rec_ad").on(table.relatedAdId),
}));

export type BotRecommendation = typeof botRecommendations.$inferSelect;

export const recommendationSubscriptions = mysqlTable("recommendation_subscriptions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  // Comma-separated signal types this user wants. Default: all three.
  enabledTypes: varchar("enabledTypes", { length: 256 }).default("best_rate,stale_offer,wide_spread").notNull(),
  // Don't ping below this score (bps). Default 5.
  minScore: float("minScore").default(5).notNull(),
  // 'telegram' | 'in_app' | 'both' — default both.
  deliveryMethod: mysqlEnum("deliveryMethod", ["telegram", "in_app", "both"]).default("both").notNull(),
  // Cap delivery to N pings per hour. Default 5.
  maxPerHour: int("maxPerHour").default(5).notNull(),
  isPaused: boolean("isPaused").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdx: index("idx_rec_sub_user").on(table.userId),
}));

export type RecommendationSubscription = typeof recommendationSubscriptions.$inferSelect;

export const recommendationOutcomes = mysqlTable("recommendation_outcomes", {
  id: int("id").autoincrement().primaryKey(),
  recommendationId: int("recommendationId").notNull(),
  userId: int("userId").notNull(),
  // viewed=opened the signal; ignored=explicit dismiss; acted=clicked through;
  // resulted_in_trade=we tied it to an actual swap/order tx hash.
  action: mysqlEnum("action", ["delivered", "viewed", "ignored", "acted", "resulted_in_trade"]).notNull(),
  // When action=resulted_in_trade, the resulting tx hash (links the signal
  // to a real on-chain outcome — feeds the strategy-backtest analytics).
  resultTxHash: varchar("resultTxHash", { length: 66 }),
  // For acted/resulted_in_trade: bps of P&L attributed to following the
  // signal. Filled in during cycle accounting, nullable until then.
  realizedPnlBps: float("realizedPnlBps"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  recIdx: index("idx_rec_outcome_rec").on(table.recommendationId),
  userActionIdx: index("idx_rec_outcome_user_action").on(table.userId, table.action),
}));

export type RecommendationOutcome = typeof recommendationOutcomes.$inferSelect;

// ─── Yield Bot (Phase R2: pooled market-making) ───────────────────────────────
//
// Users opt-in by depositing USDC into a pooled bot-managed wallet. The bot
// runs market-making strategies (limit orders on the venue) across whitelisted
// FX pairs; PnL is shared pro-rata via shares (ERC-4626-style accounting:
// shares := deposit / nav-per-share at deposit time; withdrawals burn shares
// against current NAV).
//
// Three tables:
//   - yield_positions  — one row per (user, deposit). Holds shares + state.
//   - yield_cycles     — one row per bot tick. Captures NAV, fees, PnL bps.
//   - yield_fills      — one row per the venue fill the bot was party to.

export const yieldPositions = mysqlTable("yield_positions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  // USDC the user deposited (gross, before any fees).
  depositedAmount: decimal("depositedAmount", { precision: 20, scale: 6 }).notNull(),
  // Pro-rata claim on the pool. Withdrawn shares → currentNav * shares / totalShares.
  shares: decimal("shares", { precision: 30, scale: 12 }).notNull(),
  // active=earning; pending_withdraw=worker should liquidate next cycle;
  // withdrawn=position closed, kept for accounting; paused=user-paused
  // (still earning until they explicitly withdraw, but blocked from
  // top-ups while paused).
  status: mysqlEnum("status", ["active", "pending_withdraw", "withdrawn", "paused"]).default("active").notNull(),
  // Source/destination wallet. For Privy users this is the embedded wallet;
  // legacy users may withdraw to any address they sign for.
  ownerAddress: varchar("ownerAddress", { length: 42 }).notNull(),
  // Deposit / withdraw tx hashes for audit trail.
  depositTxHash: varchar("depositTxHash", { length: 66 }),
  withdrawTxHash: varchar("withdrawTxHash", { length: 66 }),
  withdrawnAmount: decimal("withdrawnAmount", { precision: 20, scale: 6 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdx: index("idx_yield_pos_user").on(table.userId),
  statusIdx: index("idx_yield_pos_status").on(table.status),
}));

export type YieldPosition = typeof yieldPositions.$inferSelect;

export const yieldCycles = mysqlTable("yield_cycles", {
  id: int("id").autoincrement().primaryKey(),
  // Pool-level snapshot at the end of the cycle (USDC).
  totalAssets: decimal("totalAssets", { precision: 30, scale: 6 }).notNull(),
  // Sum of all outstanding shares — for NAV-per-share calc.
  totalShares: decimal("totalShares", { precision: 30, scale: 12 }).notNull(),
  // Per-cycle delta (positive = profit, negative = drawdown). bps of NAV.
  pnlBps: float("pnlBps").notNull(),
  // Performance fee accrued this cycle (bps of profit, charged only on
  // positive cycles; goes to APP_TREASURY_WALLET on withdrawal-day sweep).
  feeBps: float("feeBps").default(0).notNull(),
  // Active strategies + open-order count, JSON-encoded for ops dashboards.
  status: text("status").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  createdIdx: index("idx_yield_cycle_created").on(table.createdAt),
}));

export type YieldCycle = typeof yieldCycles.$inferSelect;

export const yieldFills = mysqlTable("yield_fills", {
  id: int("id").autoincrement().primaryKey(),
  cycleId: int("cycleId").notNull(),
  // The the venue trade_id from POST /swap or POST /orders fill notification.
  settlementTradeId: varchar("settlementTradeId", { length: 66 }).notNull(),
  txHash: varchar("txHash", { length: 66 }).notNull(),
  pair: varchar("pair", { length: 32 }).notNull(),
  side: mysqlEnum("side", ["buy", "sell"]).notNull(),
  amountBase: decimal("amountBase", { precision: 30, scale: 6 }).notNull(),
  amountQuote: decimal("amountQuote", { precision: 30, scale: 6 }).notNull(),
  // bps of spread captured (positive = made money).
  realizedSpreadBps: float("realizedSpreadBps"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  cycleIdx: index("idx_yield_fill_cycle").on(table.cycleId),
  txIdx: index("idx_yield_fill_tx").on(table.txHash),
}));

export type YieldFill = typeof yieldFills.$inferSelect;

// ─── Shop Settlement (v2 — coordinated 3-leg stablecoin trade) ────────────────
//
// Replaces the older fiat-escrow flow on p2p_orders for stablecoin Shop trades.
// State machine per SPEC §10.2. The settlement_uuid is the idempotency key;
// re-submitting same uuid with same params returns the same row.

export const shopSettlementStatusEnum = [
  "quoted",
  "reserved",
  "payment_pending_signature",
  "payment_broadcast",
  "payment_confirmed",
  "release_pending_signature",
  "release_broadcast",
  "release_confirmed",
  "recycle_pending",
  "completed",
  "expired",
  "cancelled",
  "refund_required",
  "refund_pending",
  "refunded",
  "failed_manual_review",
] as const;

export type ShopSettlementStatus = (typeof shopSettlementStatusEnum)[number];

export const shopSettlements = mysqlTable("shop_settlements", {
  id: int("id").autoincrement().primaryKey(),
  settlementUuid: varchar("settlement_uuid", { length: 36 }).notNull().unique(),
  adId: int("ad_id").notNull(),
  makerUserId: int("maker_user_id").notNull(),
  takerUserId: int("taker_user_id").notNull(),
  sellToken: varchar("sell_token", { length: 16 }).notNull(),
  buyToken: varchar("buy_token", { length: 16 }).notNull(),
  sellAmountRaw: varchar("sell_amount_raw", { length: 64 }).notNull(),
  buyAmountRaw: varchar("buy_amount_raw", { length: 64 }).notNull(),
  sellDecimals: int("sell_decimals").notNull(),
  buyDecimals: int("buy_decimals").notNull(),
  rateUsed: decimal("rate_used", { precision: 18, scale: 8 }).notNull(),
  makerAddress: varchar("maker_address", { length: 42 }).notNull(),
  takerAddress: varchar("taker_address", { length: 42 }).notNull(),
  status: mysqlEnum("status", shopSettlementStatusEnum).default("quoted").notNull(),
  reservedUntil: timestamp("reserved_until"),
  failureCode: varchar("failure_code", { length: 64 }),
  failureDetail: text("failure_detail"),
  manualReviewNote: text("manual_review_note"),
  // Idempotency guard for releaseReservation — set on first call, prevents double-credit
  locksReleasedAt: timestamp("locks_released_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  makerStatusIdx: index("idx_settlement_maker_status").on(table.makerUserId, table.status),
  takerStatusIdx: index("idx_settlement_taker_status").on(table.takerUserId, table.status),
  statusExpiryIdx: index("idx_settlement_status_reserved_until").on(table.status, table.reservedUntil),
  adIdx: index("idx_settlement_ad").on(table.adId),
}));

export type ShopSettlement = typeof shopSettlements.$inferSelect;
export type InsertShopSettlement = typeof shopSettlements.$inferInsert;

export const shopSettlementLegs = mysqlTable("shop_settlement_legs", {
  id: int("id").autoincrement().primaryKey(),
  settlementId: int("settlement_id").notNull(),
  // Leg numbering: 1=payment, 2=release, 3=recycle, 99=refund
  legNumber: int("leg_number").notNull(),
  legKind: mysqlEnum("leg_kind", ["payment", "release", "recycle", "refund"]).notNull(),
  settlementEndpoint: mysqlEnum("settlement_endpoint", ["transfer", "withdraw", "deposit"]).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull().unique(),
  signerAddress: varchar("signer_address", { length: 42 }).notNull(),
  signerRole: mysqlEnum("signer_role", ["taker_privy", "taker_managed", "maker_managed"]).notNull(),
  status: mysqlEnum("status", ["pending_signature", "broadcast", "confirmed", "failed"]).default("pending_signature").notNull(),
  txHash: varchar("tx_hash", { length: 66 }),
  blockNumber: bigint("block_number", { mode: "number" }),
  gasUsed: bigint("gas_used", { mode: "number" }),
  failureCode: varchar("failure_code", { length: 64 }),
  failureDetail: text("failure_detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  broadcastAt: timestamp("broadcast_at"),
  confirmedAt: timestamp("confirmed_at"),
}, (table) => ({
  settlementLegIdx: index("idx_leg_settlement").on(table.settlementId, table.legNumber),
  txHashIdx: index("idx_leg_tx_hash").on(table.txHash),
}));

export type ShopSettlementLeg = typeof shopSettlementLegs.$inferSelect;
export type InsertShopSettlementLeg = typeof shopSettlementLegs.$inferInsert;

// ─── Managed-Shop-Wallet Caps (per-user opt-in policy) ────────────────────────
//
// Created only when a shopkeeper explicitly opts into automated bots /
// instant settlement. Stores caps + kill-switch state. Without this row
// (or `enabled=false`), the user has only their Privy embedded wallet —
// no server-managed signing surface.

export const managedWalletCaps = mysqlTable("managed_wallet_caps", {
  userId: int("user_id").primaryKey(),
  enabled: boolean("enabled").default(false).notNull(),
  perTradeCapUsd: decimal("per_trade_cap_usd", { precision: 18, scale: 2 }).default("500").notNull(),
  dailyVolumeCapUsd: decimal("daily_volume_cap_usd", { precision: 18, scale: 2 }).default("10000").notNull(),
  // CSV of allowed token symbols, e.g. "USDT,USDC,XSGD". Empty = no tokens.
  tokenAllowlist: varchar("token_allowlist", { length: 512 }).default("").notNull(),
  killed: boolean("killed").default(false).notNull(),
  killReason: varchar("kill_reason", { length: 256 }),
  consecutiveFailures: int("consecutive_failures").default(0).notNull(),
  autoPausedAt: timestamp("auto_paused_at"),
  dailyVolumeUsedUsd: decimal("daily_volume_used_usd", { precision: 18, scale: 2 }).default("0").notNull(),
  dailyWindowStartedAt: timestamp("daily_window_started_at").defaultNow().notNull(),
  enabledAt: timestamp("enabled_at"),
  enabledConsentHash: varchar("enabled_consent_hash", { length: 66 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  enabledKilledIdx: index("idx_managed_enabled").on(table.enabled, table.killed),
}));

export type ManagedWalletCap = typeof managedWalletCaps.$inferSelect;
export type InsertManagedWalletCap = typeof managedWalletCaps.$inferInsert;

// ─── Rate history ─────────────────────────────────────────────────────────────
// Time-series snapshots of the venue's executable rate + FX oracle mid per direction,
// written by the /internal/rate-log cron. Gives "the rate at that hour" (which
// the live API can't answer) and feeds price charts + the track record.
export const rateHistory = mysqlTable("rate_history", {
  id: int("id").autoincrement().primaryKey(),
  fromToken: varchar("fromToken", { length: 16 }).notNull(),
  toToken: varchar("toToken", { length: 16 }).notNull(),
  settlementRate: decimal("settlementRate", { precision: 24, scale: 10 }),
  oracleMid: decimal("oracleMid", { precision: 24, scale: 10 }),
  edgeBps: int("edgeBps"),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
});

export type RateHistoryRow = typeof rateHistory.$inferSelect;

// ─── Agent trades ─────────────────────────────────────────────────────────────
// Trades the trade-on-behalf agent executed for a user (Douglas's "AI that trades
// for you"): the edge it targeted, size, the venue trade id, status. Powers the P&L /
// track-record view. Testnet demonstration of a real mechanism.
export const agentTrades = mysqlTable("agent_trades", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  fromToken: varchar("fromToken", { length: 16 }).notNull(),
  toToken: varchar("toToken", { length: 16 }).notNull(),
  amountIn: varchar("amountIn", { length: 64 }),
  minOut: varchar("minOut", { length: 80 }),
  edgeBps: int("edgeBps"),
  settlementTradeId: varchar("settlementTradeId", { length: 80 }),
  status: varchar("status", { length: 48 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("idx_agent_trades_user").on(table.userId, table.createdAt),
}));

export type AgentTradeRow = typeof agentTrades.$inferSelect;

// ─── Peer (zkP2P) fiat ⇄ crypto ramp ────────────────────────────────────────
// On-ramp (buy) = user pays fiat → receives USDC. Off-ramp (sell) = user sends
// USDC → receives fiat from a maker. Settles on Base (8453). See
// docs/PEER_INTEGRATION.md. Amounts stored as decimal strings (USDC 6dp / rate
// 18dp) to avoid bigint/float loss.

export const peerIntents = mysqlTable("peer_intents", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  // "onramp" (buy crypto with fiat) | "offramp" (sell crypto for fiat)
  side: mysqlEnum("side", ["onramp", "offramp"]).notNull(),
  // zkP2P intent hash (0x… 32 bytes) once signalIntent lands
  intentHash: varchar("intentHash", { length: 66 }),
  depositId: varchar("depositId", { length: 80 }),
  paymentPlatform: varchar("paymentPlatform", { length: 32 }).notNull(),
  fiatCurrency: varchar("fiatCurrency", { length: 8 }).notNull(),
  // human-readable amounts for display
  fiatAmount: decimal("fiatAmount", { precision: 24, scale: 6 }),
  usdcAmount: decimal("usdcAmount", { precision: 24, scale: 6 }),
  conversionRate: varchar("conversionRate", { length: 40 }), // 18dp string
  // destination chain/token for the bought asset (onramp); usually Base USDC
  destinationChainId: int("destinationChainId"),
  destinationToken: varchar("destinationToken", { length: 80 }),
  recipientAddress: varchar("recipientAddress", { length: 48 }),
  payeeDetails: varchar("payeeDetails", { length: 80 }), // hashed payee id
  // quoted | signaled | paid | proving | fulfilled | bridged | cancelled | failed
  status: varchar("status", { length: 24 }).notNull().default("quoted"),
  signalTxHash: varchar("signalTxHash", { length: 66 }),
  fulfillTxHash: varchar("fulfillTxHash", { length: 66 }),
  bridgeTrackingUrl: varchar("bridgeTrackingUrl", { length: 256 }),
  referrerFeeBps: int("referrerFeeBps"),
  error: text("error"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdx: index("idx_peer_intents_user").on(table.userId, table.createdAt),
  hashIdx: index("idx_peer_intents_hash").on(table.intentHash),
}));

export type PeerIntentRow = typeof peerIntents.$inferSelect;

// Liquidity-provider deposits the user (or the venue) creates to offer off-ramp.
export const peerDeposits = mysqlTable("peer_deposits", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  // on-chain deposit id once createDeposit lands
  depositId: varchar("depositId", { length: 80 }),
  token: varchar("token", { length: 48 }).notNull(), // USDC on Base
  amount: decimal("amount", { precision: 24, scale: 6 }).notNull(),
  minIntent: decimal("minIntent", { precision: 24, scale: 6 }),
  maxIntent: decimal("maxIntent", { precision: 24, scale: 6 }),
  // JSON: [{ platform, fiatCurrency, conversionRate, offchainId }]
  paymentConfig: text("paymentConfig"),
  // active | paused | withdrawn
  status: varchar("status", { length: 16 }).notNull().default("active"),
  acceptingIntents: boolean("acceptingIntents").notNull().default(true),
  createTxHash: varchar("createTxHash", { length: 66 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdx: index("idx_peer_deposits_user").on(table.userId, table.createdAt),
}));

export type PeerDepositRow = typeof peerDeposits.$inferSelect;
