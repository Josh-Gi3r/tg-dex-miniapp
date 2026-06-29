/**
 * ─── FEATURE FLAGS ────────────────────────────────────────────────────
 *
 * This file is the single source of truth for all production features.
 *
 * HOW IT WORKS
 * ─────────────
 * Set the environment variable FEATURE_MODE to "production" to enable all
 * real implementations. Leave it unset (or set to "demo") to keep the
 * simulated demo behaviour.
 *
 * Individual flags can also be toggled independently — useful for enabling
 * one idea at a time as APIs become available.
 *
 * ENVIRONMENT VARIABLES REQUIRED PER FLAG
 * ─────────────────────────────────────────
 * See SWITCH.md at the project root for the full cutover checklist.
 *
 * FLAG REGISTRY
 * ─────────────
 * idea1_realWallet          → Real secp256k1 keypair + AES-256-GCM encryption
 * idea2_liveRates           → the venue GraphQL subgraph rate feed
 * idea3_onChainSwap         → the venue Router contract swap execution
 * idea4_onChainSend         → ERC-20 transfer / cross-currency send
 * idea5_liveP2PAds          → P2P ads from DB (not hardcoded mock)
 * idea6_changerOnboarding   → Changer setup flow wired to DB
 * idea7_shopLiveData        → Shop tab wired to DB changers
 * idea8_gamification        → Real XP, badge auto-award, real leaderboard
 * idea9_telegramBot         → Bot webhook, notifications, deep links
 * idea10_telegramAuth       → initData auth (replaces cookie auth in TMA)
 * idea11_orderHistory       → Real transaction history + My Orders
 * idea12_rateAlerts         → Rate alert creation + bot notification
 * idea13_promotions         → Changer paid promotion tiers
 * idea14_ratings            → Post-trade rating + review system
 * idea15_security           → Rate limiting, CORS, amount limits
 * idea16_mainnet            → Mainnet token addresses + RPC
 */

const mode = (process.env.FEATURE_MODE ?? process.env.VITE_FEATURE_MODE ?? "demo") as "demo" | "production";

function flag(envKey: string, defaultInProduction: boolean): boolean {
  // Individual override takes priority
  const override = process.env[envKey] ?? (typeof import.meta !== "undefined" ? (import.meta as any).env?.[envKey] : undefined);
  if (override === "true") return true;
  if (override === "false") return false;
  // Fall back to global mode
  return mode === "production" ? defaultInProduction : false;
}

export const FEATURES = {
  /** Idea 1 — Real secp256k1 wallet + AES-256-GCM key encryption */
  idea1_realWallet: flag("FEATURE_REAL_WALLET", true),

  /** Idea 2 — Live rate feed from the venue GraphQL subgraph */
  idea2_liveRates: flag("FEATURE_LIVE_RATES", true),

  /** Idea 3 — On-chain swap via the venue Router contract */
  idea3_onChainSwap: flag("FEATURE_ONCHAIN_SWAP", true),

  /** Idea 4 — On-chain send (ERC-20 transfer / cross-currency) */
  idea4_onChainSend: flag("FEATURE_ONCHAIN_SEND", true),

  /** Idea 5 — Live P2P ads from DB changer profiles */
  idea5_liveP2PAds: flag("FEATURE_LIVE_P2P_ADS", true),

  /** Idea 6 — Changer onboarding flow wired to DB */
  idea6_changerOnboarding: flag("FEATURE_CHANGER_ONBOARDING", true),

  /** Idea 7 — Shop tab wired to real DB changers */
  idea7_shopLiveData: flag("FEATURE_SHOP_LIVE_DATA", true),

  /** Idea 8 — Real XP, badge auto-award, real leaderboard */
  idea8_gamification: flag("FEATURE_GAMIFICATION", true),

  /** Idea 9 — Telegram bot webhook + notifications */
  idea9_telegramBot: flag("FEATURE_TELEGRAM_BOT", true),

  /** Idea 10 — Telegram initData auth (replaces cookie auth inside TMA) */
  idea10_telegramAuth: flag("FEATURE_TELEGRAM_AUTH", true),

  /** Idea 11 — Real transaction history + My P2P Orders */
  idea11_orderHistory: flag("FEATURE_ORDER_HISTORY", true),

  /** Idea 12 — Rate alerts + bot notification on trigger */
  idea12_rateAlerts: flag("FEATURE_RATE_ALERTS", true),

  /** Idea 13 — Changer paid promotion tiers */
  idea13_promotions: flag("FEATURE_PROMOTIONS", true),

  /** Idea 14 — Post-trade rating and review system */
  idea14_ratings: flag("FEATURE_RATINGS", true),

  /** Idea 15 — Rate limiting, CORS hardening, amount limits */
  idea15_security: flag("FEATURE_SECURITY", true),

  /** Idea 16 — Mainnet token addresses + RPC endpoint */
  idea16_mainnet: flag("FEATURE_MAINNET", false), // OFF even in production until mainnet deploy

  /** Referral system — unique referral links, QR codes, points per signup/trade.
   *  Keep OFF until launch so referral links don't circulate prematurely. */
  referralSystem: flag("FEATURE_REFERRAL_SYSTEM", false),

  /** Points engine — full points ledger, milestones, shop spending */
  pointsEngine: flag("FEATURE_POINTS_ENGINE", true),
} as const;

export type FeatureKey = keyof typeof FEATURES;

/**
 * Returns a human-readable summary of all active flags.
 * Used in server startup logs.
 */
export function getFeatureSummary(): string {
  const active = Object.entries(FEATURES)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const inactive = Object.entries(FEATURES)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return [
    `FEATURE_MODE: ${mode}`,
    `Active (${active.length}): ${active.join(", ") || "none"}`,
    `Inactive (${inactive.length}): ${inactive.join(", ") || "none"}`,
  ].join("\n");
}
