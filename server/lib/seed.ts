/**
 * ─── Testnet Seed Data ────────────────────────────────────────────────────────
 *
 * Populates the tg-dex-miniapp database with a vibrant SEA-corridor changer
 * marketplace + chunky P2P shop ads so testers can browse a live-looking
 * app and place many swaps without exhausting liquidity.
 *
 * **TESTNET ONLY** — the endpoint that calls this refuses to run when
 * FEATURE_MAINNET=true. Synthetic telegramIds (90000000–99999999 range),
 * server-managed wallets, generous liquidity (25K–500K per ad).
 *
 * Idempotent: re-running deletes the previous seed data (users in the
 * synthetic telegramId range) and re-inserts. Safe to call repeatedly.
 */

import { eq, gte, lte, and, inArray } from "drizzle-orm";
import { Mnemonic, HDNodeWallet } from "ethers";
import { getDb } from "../db";
import {
  users,
  walletKeys,
  changerProfiles,
  changerRates,
  p2pAds,
  managedWalletCaps,
} from "../../drizzle/schema";
import { generateDeterministicWallet, encryptPrivateKey } from "./crypto";
import { getDexClient } from "./dex/client";

// Tokens each seed shop is allowed to trade via its managed wallet.
// Matches the deposit set in scripts/fund-seed-shops.mjs.
const SEED_TOKEN_ALLOWLIST = "USDT,USDC,XSGD,JPYC,EURT";

/**
 * Best-effort the venue API key provisioning for a seed shop's signing wallet.
 * Signs ManageApiKey EIP-712 + POSTs /api-keys. Returns creds or null on
 * any failure (non-fatal — the shop still exists, just can't be a maker
 * until a key is provisioned). Network-dependent; tolerates the venue downtime.
 */
async function provisionSeedApiKey(
  signer: HDNodeWallet,
): Promise<{ apiKey: string; apiSecret: string } | null> {
  try {
    const client = getDexClient();
    const cfg = await client.getConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const types = {
      ManageApiKey: [
        { name: "owner", type: "address" },
        { name: "action", type: "string" },
        { name: "timestamp", type: "uint256" },
      ],
    };
    const message = { owner: signer.address.toLowerCase(), action: "create", timestamp };
    const signature = await signer.signTypedData(cfg.eip712_domain, types, message);
    const res = await client.post<{ api_key?: string; api_secret?: string; secret?: string }>(
      "/api-keys",
      { owner_address: signer.address.toLowerCase(), action: "create", timestamp, signature, label: `seed-${signer.address.slice(0, 8)}` },
    );
    const apiKey = res.api_key;
    const apiSecret = res.api_secret ?? res.secret;
    if (!apiKey || !apiSecret) return null;
    return { apiKey, apiSecret };
  } catch (err) {
    console.warn(`[seed] API key provisioning failed for ${signer.address}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Synthetic telegramId range — these IDs identify seeded test users.
// Real Telegram user IDs are 1–10 digits; we reserve 90000000–99999999.
const SEED_TG_ID_MIN = 90000000;
const SEED_TG_ID_MAX = 99999999;

interface SeedAd {
  fromToken: string;
  toToken: string;
  rate: number;
  liquidity: number;
  minOrder: number;
  maxOrder: number;
  promotionTier?: "none" | "boosted" | "highlighted" | "pinned";
  terms?: string;
}

interface SeedChanger {
  displayName: string;
  telegramHandle: string;
  telegramId: number;
  location: string;
  bio: string;
  reputationScore: number;
  avgRating: number;
  totalRatings: number;
  totalOrdersFilled: number;
  totalOrders30d: number;
  completionRate: number;
  completionRate30d: number;
  avgSettlementMinutes: number;
  totalVolumeUsd: number;
  ads: SeedAd[];
}

// 22 changer personas spanning SEA + adjacent corridors, 4–7 ads each = 100+ ads.
// Rates within ±2% of live FX. Liquidity 25K–500K per ad. Mix of promotion
// tiers, terms text, fiat specialties, and personality tiers.
export const SEED_CHANGERS: SeedChanger[] = [
  // ─── Tier 1: Big desk, top of the leaderboard ──────────────────────────────
  {
    displayName: "Tiger Bay FX",
    telegramHandle: "tigerbayfx",
    telegramId: 90000001,
    location: "Singapore",
    bio: "Singapore's #1 USDT/SGD desk since 2022. Tightest spreads, 24/7 settlement, weekly volume USD 8M+. Bring me size.",
    reputationScore: 98,
    avgRating: 4.9,
    totalRatings: 1240,
    totalOrdersFilled: 8420,
    totalOrders30d: 612,
    completionRate: 99.6,
    completionRate30d: 99.8,
    avgSettlementMinutes: 0.6,
    totalVolumeUsd: 8420000,
    ads: [
      { fromToken: "USDT", toToken: "XSGD", rate: 1.2648, liquidity: 500000, minOrder: 100, maxOrder: 100000, promotionTier: "pinned", terms: "🏆 Largest XSGD desk on the venue. Same-block settlement. No fees on orders > 5K USDT." },
      { fromToken: "XSGD", toToken: "USDT", rate: 0.7915, liquidity: 400000, minOrder: 100, maxOrder: 80000, promotionTier: "highlighted", terms: "Reverse leg, same desk. Instant fill." },
      { fromToken: "USDC", toToken: "XSGD", rate: 1.2646, liquidity: 350000, minOrder: 100, maxOrder: 80000, promotionTier: "highlighted" },
      { fromToken: "USDT", toToken: "USDC", rate: 0.9999, liquidity: 500000, minOrder: 100, maxOrder: 100000, promotionTier: "boosted", terms: "Stablecoin-to-stablecoin. Net zero spread for orders > 10K." },
      { fromToken: "USDT", toToken: "TNSGD", rate: 1.2643, liquidity: 200000, minOrder: 100, maxOrder: 50000 },
      { fromToken: "XSGD", toToken: "USDC", rate: 0.7910, liquidity: 250000, minOrder: 100, maxOrder: 50000 },
    ],
  },
  // ─── Tier 2: Mantra Money - IDR specialist ──────────────────────────────────
  {
    displayName: "Mantra Money",
    telegramHandle: "mantramoney",
    telegramId: 90000002,
    location: "Jakarta",
    bio: "Indonesia's largest IDR/stablecoin desk. IDRX is my home base. Bahasa & English support, daily liquidity refresh at 9am WIB.",
    reputationScore: 95,
    avgRating: 4.8,
    totalRatings: 687,
    totalOrdersFilled: 4520,
    totalOrders30d: 384,
    completionRate: 99.1,
    completionRate30d: 99.3,
    avgSettlementMinutes: 0.9,
    totalVolumeUsd: 3820000,
    ads: [
      { fromToken: "USDT", toToken: "IDRX", rate: 17642, liquidity: 350000, minOrder: 50, maxOrder: 50000, promotionTier: "pinned", terms: "🇮🇩 Jakarta's biggest IDR desk. WhatsApp support for orders > 10K USDT." },
      { fromToken: "IDRX", toToken: "USDT", rate: 0.0000566, liquidity: 300000, minOrder: 100000, maxOrder: 50000000, promotionTier: "highlighted" },
      { fromToken: "USDC", toToken: "IDRX", rate: 17639, liquidity: 250000, minOrder: 50, maxOrder: 50000 },
      { fromToken: "USDT", toToken: "IDRT", rate: 17628, liquidity: 200000, minOrder: 50, maxOrder: 40000, promotionTier: "boosted" },
      { fromToken: "USDT", toToken: "XIDR", rate: 17651, liquidity: 180000, minOrder: 50, maxOrder: 35000 },
      { fromToken: "XSGD", toToken: "IDRX", rate: 13952, liquidity: 150000, minOrder: 100, maxOrder: 25000, terms: "Cross-fiat SGD→IDR. Save on the USDT round trip." },
    ],
  },
  // ─── Tier 2: Klang Valley FX - MYR specialist ───────────────────────────────
  {
    displayName: "Klang Valley FX",
    telegramHandle: "klangvalleyfx",
    telegramId: 90000003,
    location: "Kuala Lumpur",
    bio: "Malaysia's tightest USDT/MYR spreads. Operating since 2021. Daily KL-business-hours liquidity, weekend reduced.",
    reputationScore: 96,
    avgRating: 4.7,
    totalRatings: 521,
    totalOrdersFilled: 3410,
    totalOrders30d: 287,
    completionRate: 99.2,
    completionRate30d: 99.4,
    avgSettlementMinutes: 0.7,
    totalVolumeUsd: 2120000,
    ads: [
      { fromToken: "USDT", toToken: "MYRC", rate: 3.9272, liquidity: 300000, minOrder: 50, maxOrder: 60000, promotionTier: "highlighted", terms: "🇲🇾 Malaysia's largest MYR liquidity pool. Settles within 60 seconds." },
      { fromToken: "MYRC", toToken: "USDT", rate: 0.25469, liquidity: 250000, minOrder: 200, maxOrder: 150000 },
      { fromToken: "USDC", toToken: "MYRC", rate: 3.9268, liquidity: 220000, minOrder: 50, maxOrder: 50000 },
      { fromToken: "XSGD", toToken: "MYRC", rate: 3.1067, liquidity: 180000, minOrder: 50, maxOrder: 35000, promotionTier: "boosted", terms: "SGD→MYR cross-corridor. Cheaper than the USDT round trip for orders > 1K." },
      { fromToken: "USDT", toToken: "STBL", rate: 3.9258, liquidity: 120000, minOrder: 50, maxOrder: 25000 },
      { fromToken: "USDT", toToken: "JMYR", rate: 3.9262, liquidity: 80000, minOrder: 50, maxOrder: 18000 },
    ],
  },
  // ─── Tier 2: Mahal Crypto - PHP specialist ──────────────────────────────────
  {
    displayName: "Mahal Crypto",
    telegramHandle: "mahalcrypto",
    telegramId: 90000004,
    location: "Manila",
    bio: "PH-licensed remittance broker. PHPC + PHPX my specialty. OFW-friendly rates, no weekend gap.",
    reputationScore: 92,
    avgRating: 4.6,
    totalRatings: 412,
    totalOrdersFilled: 2280,
    totalOrders30d: 198,
    completionRate: 98.4,
    completionRate30d: 98.7,
    avgSettlementMinutes: 1.2,
    totalVolumeUsd: 1240000,
    ads: [
      { fromToken: "USDT", toToken: "PHPC", rate: 58.34, liquidity: 250000, minOrder: 50, maxOrder: 40000, promotionTier: "highlighted", terms: "🇵🇭 OFW-special rates. Lowest spread in Manila. Tagalog/English support." },
      { fromToken: "PHPC", toToken: "USDT", rate: 0.01714, liquidity: 200000, minOrder: 500, maxOrder: 2000000 },
      { fromToken: "USDC", toToken: "PHPC", rate: 58.31, liquidity: 180000, minOrder: 50, maxOrder: 35000 },
      { fromToken: "USDT", toToken: "PHPX", rate: 58.28, liquidity: 120000, minOrder: 50, maxOrder: 25000, promotionTier: "boosted" },
      { fromToken: "USDT", toToken: "PHT", rate: 58.42, liquidity: 80000, minOrder: 50, maxOrder: 18000 },
    ],
  },
  // ─── Tier 2: Hanoi Bridge - VND/THB cross-corridor ──────────────────────────
  {
    displayName: "Hanoi Bridge",
    telegramHandle: "hanoibridge",
    telegramId: 90000005,
    location: "Hanoi",
    bio: "VND and THB cross-corridor desk. Vietnamese & Thai liquidity in one shop. Same-day settlement guaranteed.",
    reputationScore: 90,
    avgRating: 4.7,
    totalRatings: 318,
    totalOrdersFilled: 1820,
    totalOrders30d: 162,
    completionRate: 98.1,
    completionRate30d: 98.6,
    avgSettlementMinutes: 1.4,
    totalVolumeUsd: 920000,
    ads: [
      { fromToken: "USDT", toToken: "VNDC", rate: 24822, liquidity: 180000, minOrder: 50, maxOrder: 30000, promotionTier: "boosted", terms: "🇻🇳 Vietnam's only VNDC desk on the venue. Same-business-day VND off-ramp." },
      { fromToken: "VNDC", toToken: "USDT", rate: 0.0000402, liquidity: 150000, minOrder: 500000, maxOrder: 800000000 },
      { fromToken: "USDT", toToken: "THBT", rate: 35.45, liquidity: 150000, minOrder: 50, maxOrder: 30000, terms: "🇹🇭 Thai baht specialist. Best for tourist FX." },
      { fromToken: "USDT", toToken: "THBK", rate: 35.42, liquidity: 100000, minOrder: 50, maxOrder: 20000 },
      { fromToken: "USDC", toToken: "VNDC", rate: 24819, liquidity: 120000, minOrder: 50, maxOrder: 25000 },
    ],
  },
  // ─── Tier 3: Specialty boutique - EUR corridor ──────────────────────────────
  {
    displayName: "Bangkok Eurodesk",
    telegramHandle: "bkkeurodesk",
    telegramId: 90000006,
    location: "Bangkok",
    bio: "EUR ↔ USD ↔ THB. Boutique desk serving European expats in Thailand. Premium rates for size.",
    reputationScore: 88,
    avgRating: 4.5,
    totalRatings: 184,
    totalOrdersFilled: 920,
    totalOrders30d: 76,
    completionRate: 97.8,
    completionRate30d: 98.2,
    avgSettlementMinutes: 2.1,
    totalVolumeUsd: 480000,
    ads: [
      { fromToken: "USDT", toToken: "EURT", rate: 0.9261, liquidity: 120000, minOrder: 100, maxOrder: 25000, promotionTier: "boosted", terms: "🇪🇺 EUR specialist for Asia. Bring USDT, take EURT, hold or spend." },
      { fromToken: "EURT", toToken: "USDT", rate: 1.0798, liquidity: 100000, minOrder: 100, maxOrder: 20000 },
      { fromToken: "USDC", toToken: "EURT", rate: 0.9258, liquidity: 80000, minOrder: 100, maxOrder: 18000 },
      { fromToken: "EURT", toToken: "THBT", rate: 38.27, liquidity: 60000, minOrder: 50, maxOrder: 12000, terms: "EUR→THB for expats settling in Thailand. One-leg cross-fiat." },
      { fromToken: "USDT", toToken: "EUROP", rate: 0.9263, liquidity: 50000, minOrder: 50, maxOrder: 10000 },
    ],
  },
  // ─── Tier 3: Solo trader vibes ──────────────────────────────────────────────
  {
    displayName: "OFW Express",
    telegramHandle: "ofwexpress",
    telegramId: 90000007,
    location: "Cebu",
    bio: "Solo broker serving Filipino OFWs sending money home. Small orders welcome, no minimum. WhatsApp 24/7.",
    reputationScore: 84,
    avgRating: 4.4,
    totalRatings: 142,
    totalOrdersFilled: 680,
    totalOrders30d: 88,
    completionRate: 96.8,
    completionRate30d: 97.4,
    avgSettlementMinutes: 2.4,
    totalVolumeUsd: 218000,
    ads: [
      { fromToken: "USDT", toToken: "PHPC", rate: 58.21, liquidity: 60000, minOrder: 10, maxOrder: 8000, promotionTier: "boosted", terms: "💚 Small orders welcome. 10 USDT minimum. Family-friendly rates." },
      { fromToken: "USDT", toToken: "PHPX", rate: 58.18, liquidity: 40000, minOrder: 10, maxOrder: 6000 },
      { fromToken: "USDC", toToken: "PHPC", rate: 58.20, liquidity: 35000, minOrder: 10, maxOrder: 6000 },
      { fromToken: "XSGD", toToken: "PHPC", rate: 46.05, liquidity: 25000, minOrder: 20, maxOrder: 4000, terms: "Singapore-Philippines corridor. Daily limit applies." },
    ],
  },
  // ─── Tier 3: Lion City Trader - SG niche ────────────────────────────────────
  {
    displayName: "Lion City Trader",
    telegramHandle: "lioncitytrader",
    telegramId: 90000008,
    location: "Singapore",
    bio: "SG-based OTC desk. USD pairs only — keep it simple, keep spreads tight. No fiat ramps.",
    reputationScore: 87,
    avgRating: 4.6,
    totalRatings: 234,
    totalOrdersFilled: 1180,
    totalOrders30d: 142,
    completionRate: 98.2,
    completionRate30d: 98.5,
    avgSettlementMinutes: 1.0,
    totalVolumeUsd: 642000,
    ads: [
      { fromToken: "USDT", toToken: "XSGD", rate: 1.2641, liquidity: 200000, minOrder: 100, maxOrder: 40000, terms: "Pure SGD ↔ USD. No corridor surcharge." },
      { fromToken: "USDC", toToken: "XSGD", rate: 1.2639, liquidity: 180000, minOrder: 100, maxOrder: 40000 },
      { fromToken: "USDT", toToken: "USDC", rate: 0.9999, liquidity: 250000, minOrder: 100, maxOrder: 50000, promotionTier: "boosted" },
      { fromToken: "FDUSD", toToken: "USDT", rate: 1.0002, liquidity: 100000, minOrder: 100, maxOrder: 25000, terms: "FDUSD/USDT pair — fresh stablecoin liquidity." },
    ],
  },
  // ─── Tier 4: New entrant ────────────────────────────────────────────────────
  {
    displayName: "Surabaya Swap",
    telegramHandle: "surabayaswap",
    telegramId: 90000009,
    location: "Surabaya",
    bio: "New shop, opened 2026. East Java focus. Aggressive intro rates while we build reputation.",
    reputationScore: 75,
    avgRating: 4.3,
    totalRatings: 48,
    totalOrdersFilled: 184,
    totalOrders30d: 62,
    completionRate: 95.6,
    completionRate30d: 96.2,
    avgSettlementMinutes: 2.8,
    totalVolumeUsd: 84000,
    ads: [
      { fromToken: "USDT", toToken: "IDRX", rate: 17680, liquidity: 60000, minOrder: 20, maxOrder: 8000, promotionTier: "boosted", terms: "🆕 Intro rates — best IDRX rate in East Java. Trying to build my book." },
      { fromToken: "USDT", toToken: "IDRT", rate: 17672, liquidity: 50000, minOrder: 20, maxOrder: 8000 },
      { fromToken: "USDT", toToken: "XIDR", rate: 17688, liquidity: 40000, minOrder: 20, maxOrder: 6000 },
      { fromToken: "USDC", toToken: "IDRX", rate: 17676, liquidity: 35000, minOrder: 20, maxOrder: 6000 },
    ],
  },
  // ─── Tier 4: Korean corridor ────────────────────────────────────────────────
  {
    displayName: "Seoul Settlement",
    telegramHandle: "seoulsettle",
    telegramId: 90000010,
    location: "Seoul",
    bio: "KRW corridor specialist. Multiple KRW stablecoin pairs (KRW1, KRWIN, KRWO, KRWQ). Best rates outside Korean exchanges.",
    reputationScore: 86,
    avgRating: 4.5,
    totalRatings: 165,
    totalOrdersFilled: 740,
    totalOrders30d: 92,
    completionRate: 97.6,
    completionRate30d: 98.1,
    avgSettlementMinutes: 1.7,
    totalVolumeUsd: 392000,
    ads: [
      { fromToken: "USDT", toToken: "KRW1", rate: 1372, liquidity: 100000, minOrder: 30, maxOrder: 20000, promotionTier: "boosted", terms: "🇰🇷 4 KRW stablecoin variants. Compare and pick the best one." },
      { fromToken: "USDT", toToken: "KRWIN", rate: 1368, liquidity: 80000, minOrder: 30, maxOrder: 18000 },
      { fromToken: "USDT", toToken: "KRWO", rate: 1374, liquidity: 70000, minOrder: 30, maxOrder: 15000 },
      { fromToken: "USDT", toToken: "KRWQ", rate: 1370, liquidity: 60000, minOrder: 30, maxOrder: 12000 },
      { fromToken: "USDC", toToken: "KRW1", rate: 1371, liquidity: 90000, minOrder: 30, maxOrder: 18000 },
    ],
  },
  // ─── Tier 1: Marina Bay Capital — Singapore institutional ─────────────────
  {
    displayName: "Marina Bay Capital",
    telegramHandle: "marinabaycap",
    telegramId: 90000011,
    location: "Singapore",
    bio: "Institutional desk. Min order 1K USDT, max 250K. White-glove for OTC blocks. Family office friendly. We move size.",
    reputationScore: 97,
    avgRating: 4.9,
    totalRatings: 892,
    totalOrdersFilled: 5210,
    totalOrders30d: 412,
    completionRate: 99.5,
    completionRate30d: 99.7,
    avgSettlementMinutes: 0.5,
    totalVolumeUsd: 12400000,
    ads: [
      { fromToken: "USDT", toToken: "XSGD", rate: 1.2649, liquidity: 800000, minOrder: 1000, maxOrder: 250000, promotionTier: "pinned", terms: "💎 OTC block desk. Quote-on-demand for size > 100K. Telegram: @marinabaycap" },
      { fromToken: "USDC", toToken: "USDT", rate: 1.0001, liquidity: 1000000, minOrder: 1000, maxOrder: 250000, promotionTier: "highlighted", terms: "Stablecoin block. Tightest in SEA." },
      { fromToken: "USDT", toToken: "EURT", rate: 0.9264, liquidity: 500000, minOrder: 1000, maxOrder: 150000 },
      { fromToken: "USDT", toToken: "USDC", rate: 0.9999, liquidity: 1000000, minOrder: 1000, maxOrder: 250000, promotionTier: "boosted" },
      { fromToken: "XSGD", toToken: "USDC", rate: 0.7911, liquidity: 400000, minOrder: 1000, maxOrder: 200000 },
    ],
  },
  // ─── Tier 2: Pearl Harbor FX — Hong Kong USD/HKD ──────────────────────────
  {
    displayName: "Pearl Harbor FX",
    telegramHandle: "pearlharborfx",
    telegramId: 90000012,
    location: "Hong Kong",
    bio: "HK-based USD desk. Wholesale rates for crypto-natives. Tightest USDT/USDC spreads in Asia.",
    reputationScore: 94,
    avgRating: 4.7,
    totalRatings: 524,
    totalOrdersFilled: 3120,
    totalOrders30d: 246,
    completionRate: 99.0,
    completionRate30d: 99.3,
    avgSettlementMinutes: 0.8,
    totalVolumeUsd: 2820000,
    ads: [
      { fromToken: "USDT", toToken: "USDC", rate: 1.0000, liquidity: 600000, minOrder: 100, maxOrder: 150000, promotionTier: "highlighted", terms: "🇭🇰 HK-wholesale stablecoin desk. 24/7." },
      { fromToken: "USDC", toToken: "USDT", rate: 1.0000, liquidity: 600000, minOrder: 100, maxOrder: 150000, promotionTier: "highlighted" },
      { fromToken: "FDUSD", toToken: "USDT", rate: 1.0001, liquidity: 300000, minOrder: 100, maxOrder: 80000, terms: "FDUSD ↔ USDT specialty. Built by HK natives." },
      { fromToken: "USDT", toToken: "XSGD", rate: 1.2645, liquidity: 250000, minOrder: 100, maxOrder: 50000 },
    ],
  },
  // ─── Tier 2: Yen Direct — Tokyo JPYC specialist ───────────────────────────
  {
    displayName: "Yen Direct",
    telegramHandle: "yendirect",
    telegramId: 90000013,
    location: "Tokyo",
    bio: "Japan's largest JPYC liquidity. Same-day yen off-ramp. English + 日本語 support. Open since 2023.",
    reputationScore: 93,
    avgRating: 4.7,
    totalRatings: 318,
    totalOrdersFilled: 1820,
    totalOrders30d: 156,
    completionRate: 98.4,
    completionRate30d: 98.9,
    avgSettlementMinutes: 1.1,
    totalVolumeUsd: 1080000,
    ads: [
      { fromToken: "USDT", toToken: "JPYC", rate: 156.42, liquidity: 200000, minOrder: 50, maxOrder: 35000, promotionTier: "pinned", terms: "🇯🇵 Tokyo's #1 JPYC desk. Daily liquidity 9am JST." },
      { fromToken: "JPYC", toToken: "USDT", rate: 0.006393, liquidity: 180000, minOrder: 5000, maxOrder: 5000000 },
      { fromToken: "USDC", toToken: "JPYC", rate: 156.38, liquidity: 150000, minOrder: 50, maxOrder: 30000, promotionTier: "boosted" },
      { fromToken: "EURT", toToken: "JPYC", rate: 168.92, liquidity: 80000, minOrder: 50, maxOrder: 15000, terms: "EUR→JPY one-leg cross. Avoid the USDT round trip." },
      { fromToken: "XSGD", toToken: "JPYC", rate: 123.65, liquidity: 100000, minOrder: 50, maxOrder: 20000, terms: "SGD→JPY for travelers and remitters." },
    ],
  },
  // ─── Tier 2: Down Under Stable — Sydney AUD desk ──────────────────────────
  {
    displayName: "Down Under Stable",
    telegramHandle: "downunderfx",
    telegramId: 90000014,
    location: "Sydney",
    bio: "AUDC liquidity for Australia. Crypto-friendly bank-rails alternative. AUSTRAC-registered (off-platform).",
    reputationScore: 89,
    avgRating: 4.6,
    totalRatings: 247,
    totalOrdersFilled: 1340,
    totalOrders30d: 118,
    completionRate: 97.9,
    completionRate30d: 98.4,
    avgSettlementMinutes: 1.5,
    totalVolumeUsd: 720000,
    ads: [
      { fromToken: "USDT", toToken: "AUDC", rate: 1.5234, liquidity: 180000, minOrder: 50, maxOrder: 30000, promotionTier: "boosted", terms: "🇦🇺 G'day. Australia's smoothest AUDC ramp. Settles within 2 min." },
      { fromToken: "AUDC", toToken: "USDT", rate: 0.6564, liquidity: 150000, minOrder: 100, maxOrder: 25000 },
      { fromToken: "USDC", toToken: "AUDC", rate: 1.5230, liquidity: 120000, minOrder: 50, maxOrder: 25000 },
      { fromToken: "AUDD", toToken: "USDT", rate: 0.6562, liquidity: 80000, minOrder: 100, maxOrder: 18000, terms: "AUDD pair for ANZ Bank users." },
    ],
  },
  // ─── Tier 2: Bharat Bridge — Mumbai INR specialist ────────────────────────
  {
    displayName: "Bharat Bridge",
    telegramHandle: "bharatbridge",
    telegramId: 90000015,
    location: "Mumbai",
    bio: "India's stablecoin-to-INR desk. RBI-aware operator. Hindi/English/Marathi support. UPI off-ramp via partner.",
    reputationScore: 88,
    avgRating: 4.5,
    totalRatings: 312,
    totalOrdersFilled: 1620,
    totalOrders30d: 162,
    completionRate: 97.6,
    completionRate30d: 98.1,
    avgSettlementMinutes: 2.2,
    totalVolumeUsd: 580000,
    ads: [
      { fromToken: "USDT", toToken: "INRC", rate: 83.42, liquidity: 250000, minOrder: 30, maxOrder: 40000, promotionTier: "highlighted", terms: "🇮🇳 India's largest INRC desk. Premium rates, no hidden fees." },
      { fromToken: "INRC", toToken: "USDT", rate: 0.01199, liquidity: 200000, minOrder: 1000, maxOrder: 3000000 },
      { fromToken: "USDC", toToken: "INRC", rate: 83.39, liquidity: 180000, minOrder: 30, maxOrder: 35000 },
      { fromToken: "USDT", toToken: "INRT", rate: 83.38, liquidity: 100000, minOrder: 30, maxOrder: 20000, promotionTier: "boosted" },
      { fromToken: "XSGD", toToken: "INRC", rate: 65.93, liquidity: 80000, minOrder: 30, maxOrder: 15000, terms: "SGD→INR for diaspora remittance." },
    ],
  },
  // ─── Tier 2: Pad Thai FX — Bangkok local THB desk ─────────────────────────
  {
    displayName: "Pad Thai FX",
    telegramHandle: "padthaifx",
    telegramId: 90000016,
    location: "Bangkok",
    bio: "Bangkok-local THB desk. Tourist-friendly rates. ภาษาไทย available. Same-day Bangkok Bank settlement on request.",
    reputationScore: 91,
    avgRating: 4.7,
    totalRatings: 421,
    totalOrdersFilled: 2310,
    totalOrders30d: 198,
    completionRate: 98.6,
    completionRate30d: 99.0,
    avgSettlementMinutes: 1.0,
    totalVolumeUsd: 1340000,
    ads: [
      { fromToken: "USDT", toToken: "THBT", rate: 35.46, liquidity: 280000, minOrder: 50, maxOrder: 50000, promotionTier: "pinned", terms: "🇹🇭 Bangkok's #1 THB desk. Pure stablecoin, no fees < 100 USDT." },
      { fromToken: "THBT", toToken: "USDT", rate: 0.02820, liquidity: 220000, minOrder: 1000, maxOrder: 1500000 },
      { fromToken: "USDC", toToken: "THBT", rate: 35.43, liquidity: 200000, minOrder: 50, maxOrder: 40000 },
      { fromToken: "USDT", toToken: "THBK", rate: 35.43, liquidity: 150000, minOrder: 50, maxOrder: 30000, promotionTier: "boosted" },
      { fromToken: "EURT", toToken: "THBT", rate: 38.28, liquidity: 80000, minOrder: 50, maxOrder: 18000, terms: "EUR→THB cross-leg. Skip USDT entirely." },
    ],
  },
  // ─── Tier 3: Penang Crypto — Malaysia regional ───────────────────────────
  {
    displayName: "Penang Crypto",
    telegramHandle: "penangcrypto",
    telegramId: 90000017,
    location: "Penang",
    bio: "Northern Malaysia regional desk. Smaller orders welcome. Family-run, 3rd generation money changer adapting to crypto.",
    reputationScore: 82,
    avgRating: 4.6,
    totalRatings: 178,
    totalOrdersFilled: 940,
    totalOrders30d: 102,
    completionRate: 97.2,
    completionRate30d: 97.8,
    avgSettlementMinutes: 1.8,
    totalVolumeUsd: 312000,
    ads: [
      { fromToken: "USDT", toToken: "MYRC", rate: 3.9281, liquidity: 100000, minOrder: 20, maxOrder: 18000, promotionTier: "boosted", terms: "🏝️ Penang local. Small orders welcome. 20 USDT min." },
      { fromToken: "MYRC", toToken: "USDT", rate: 0.25462, liquidity: 80000, minOrder: 100, maxOrder: 70000 },
      { fromToken: "USDC", toToken: "MYRC", rate: 3.9278, liquidity: 70000, minOrder: 20, maxOrder: 15000 },
      { fromToken: "USDT", toToken: "STBL", rate: 3.9265, liquidity: 50000, minOrder: 20, maxOrder: 12000 },
    ],
  },
  // ─── Tier 3: Saigon Same-Day — Ho Chi Minh VND niche ─────────────────────
  {
    displayName: "Saigon Same-Day",
    telegramHandle: "saigonsameday",
    telegramId: 90000018,
    location: "Ho Chi Minh City",
    bio: "Vietnam's fastest VND desk. Tested by 200+ travelers. Same-day Vietcombank wire on request.",
    reputationScore: 85,
    avgRating: 4.6,
    totalRatings: 234,
    totalOrdersFilled: 1180,
    totalOrders30d: 142,
    completionRate: 97.8,
    completionRate30d: 98.4,
    avgSettlementMinutes: 1.3,
    totalVolumeUsd: 462000,
    ads: [
      { fromToken: "USDT", toToken: "VNDC", rate: 24818, liquidity: 150000, minOrder: 30, maxOrder: 25000, promotionTier: "highlighted", terms: "🇻🇳 Saigon's fastest. Same-day Vietcombank wire for orders > 1K USDT." },
      { fromToken: "VNDC", toToken: "USDT", rate: 0.0000403, liquidity: 120000, minOrder: 500000, maxOrder: 500000000, promotionTier: "boosted" },
      { fromToken: "USDC", toToken: "VNDC", rate: 24815, liquidity: 100000, minOrder: 30, maxOrder: 20000 },
      { fromToken: "USDT", toToken: "THBT", rate: 35.40, liquidity: 60000, minOrder: 30, maxOrder: 12000, terms: "VN-TH border cross-corridor. Cheap." },
    ],
  },
  // ─── Tier 3: KL Night Market — off-hours MYR ─────────────────────────────
  {
    displayName: "KL Night Market",
    telegramHandle: "klnightfx",
    telegramId: 90000019,
    location: "Kuala Lumpur",
    bio: "Off-hours MYR desk. Open midnight-6am KL time when the big shops sleep. Night-owl friendly.",
    reputationScore: 79,
    avgRating: 4.4,
    totalRatings: 92,
    totalOrdersFilled: 480,
    totalOrders30d: 62,
    completionRate: 96.4,
    completionRate30d: 97.0,
    avgSettlementMinutes: 2.5,
    totalVolumeUsd: 184000,
    ads: [
      { fromToken: "USDT", toToken: "MYRC", rate: 3.9268, liquidity: 80000, minOrder: 20, maxOrder: 12000, promotionTier: "boosted", terms: "🌙 Midnight-6am KL. The night shift desk. Same rates 24/7." },
      { fromToken: "MYRC", toToken: "USDT", rate: 0.25471, liquidity: 60000, minOrder: 100, maxOrder: 40000 },
      { fromToken: "USDC", toToken: "MYRC", rate: 3.9264, liquidity: 50000, minOrder: 20, maxOrder: 10000 },
    ],
  },
  // ─── Tier 3: Bali Boutique — IDR niche luxury ────────────────────────────
  {
    displayName: "Bali Boutique",
    telegramHandle: "baliboutique",
    telegramId: 90000020,
    location: "Denpasar",
    bio: "Bali's high-touch IDR desk for digital nomads + villa rentals. Concierge service for orders > 5K USDT.",
    reputationScore: 81,
    avgRating: 4.7,
    totalRatings: 142,
    totalOrdersFilled: 612,
    totalOrders30d: 78,
    completionRate: 97.8,
    completionRate30d: 98.2,
    avgSettlementMinutes: 2.0,
    totalVolumeUsd: 248000,
    ads: [
      { fromToken: "USDT", toToken: "IDRX", rate: 17668, liquidity: 120000, minOrder: 50, maxOrder: 20000, promotionTier: "boosted", terms: "🌴 Bali concierge. Pay your villa rent in IDR. Same-day BCA wire." },
      { fromToken: "USDC", toToken: "IDRX", rate: 17665, liquidity: 100000, minOrder: 50, maxOrder: 18000 },
      { fromToken: "EURT", toToken: "IDRX", rate: 19082, liquidity: 70000, minOrder: 50, maxOrder: 12000, terms: "EUR→IDR for European nomads. One leg." },
      { fromToken: "USDT", toToken: "XIDR", rate: 17672, liquidity: 60000, minOrder: 50, maxOrder: 10000 },
    ],
  },
  // ─── Tier 4: Cebu Quick — small but blazing fast ─────────────────────────
  {
    displayName: "Cebu Quick",
    telegramHandle: "cebuquick",
    telegramId: 90000021,
    location: "Cebu",
    bio: "Sub-60-second average settlement. Small orders only (max 5K USDT). For the impatient traders.",
    reputationScore: 78,
    avgRating: 4.5,
    totalRatings: 312,
    totalOrdersFilled: 1480,
    totalOrders30d: 218,
    completionRate: 97.0,
    completionRate30d: 97.6,
    avgSettlementMinutes: 0.4,
    totalVolumeUsd: 142000,
    ads: [
      { fromToken: "USDT", toToken: "PHPC", rate: 58.16, liquidity: 50000, minOrder: 5, maxOrder: 5000, promotionTier: "boosted", terms: "⚡ Sub-60-second average. Max 5K USDT. The speed demon." },
      { fromToken: "PHPC", toToken: "USDT", rate: 0.01716, liquidity: 40000, minOrder: 200, maxOrder: 250000 },
      { fromToken: "USDC", toToken: "PHPC", rate: 58.14, liquidity: 35000, minOrder: 5, maxOrder: 5000 },
      { fromToken: "USDT", toToken: "PHPX", rate: 58.12, liquidity: 30000, minOrder: 5, maxOrder: 5000 },
    ],
  },
  // ─── Tier 4: Saigon Solo — boutique single-operator ──────────────────────
  {
    displayName: "Saigon Solo",
    telegramHandle: "saigonsolo",
    telegramId: 90000022,
    location: "Ho Chi Minh City",
    bio: "Solo operator, Vietnam-only. Small ticket sizes. Trying to scale up — your early support helps build my book.",
    reputationScore: 71,
    avgRating: 4.2,
    totalRatings: 38,
    totalOrdersFilled: 142,
    totalOrders30d: 48,
    completionRate: 94.8,
    completionRate30d: 95.4,
    avgSettlementMinutes: 3.2,
    totalVolumeUsd: 52000,
    ads: [
      { fromToken: "USDT", toToken: "VNDC", rate: 24804, liquidity: 40000, minOrder: 10, maxOrder: 5000, promotionTier: "boosted", terms: "🆕 Best VNDC rate while I scale up. 10 USDT min, support a small operator." },
      { fromToken: "USDT", toToken: "THBT", rate: 35.36, liquidity: 25000, minOrder: 10, maxOrder: 4000 },
      { fromToken: "USDC", toToken: "VNDC", rate: 24800, liquidity: 30000, minOrder: 10, maxOrder: 5000 },
    ],
  },
];

export interface SeedResult {
  startedAt: string;
  endedAt: string;
  changersCreated: number;
  adsCreated: number;
  changersDeleted: number;
  adsDeleted: number;
  errors: string[];
}

export async function runSeed(): Promise<SeedResult> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let changersDeleted = 0;
  let adsDeleted = 0;
  let changersCreated = 0;
  let adsCreated = 0;

  const db = await getDb();
  if (!db) {
    return {
      startedAt,
      endedAt: new Date().toISOString(),
      changersCreated: 0,
      adsCreated: 0,
      changersDeleted: 0,
      adsDeleted: 0,
      errors: ["DB not available"],
    };
  }

  try {
    // ─── 1. Idempotent cleanup: find prior seed users, delete their chain ────
    const priorSeedUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          gte(users.telegramId, String(SEED_TG_ID_MIN)),
          lte(users.telegramId, String(SEED_TG_ID_MAX)),
        ),
      );
    const priorUserIds = priorSeedUsers.map((u) => u.id);

    if (priorUserIds.length > 0) {
      const priorChangers = await db
        .select({ id: changerProfiles.id })
        .from(changerProfiles)
        .where(inArray(changerProfiles.userId, priorUserIds));
      const priorChangerIds = priorChangers.map((c) => c.id);

      if (priorChangerIds.length > 0) {
        const delAds = await db
          .delete(p2pAds)
          .where(inArray(p2pAds.posterId, priorUserIds));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adsDeleted = (delAds as any).rowsAffected ?? (delAds as any)[0]?.affectedRows ?? 0;

        await db.delete(changerRates).where(inArray(changerRates.changerId, priorChangerIds));
        await db.delete(changerProfiles).where(inArray(changerProfiles.id, priorChangerIds));
        changersDeleted = priorChangerIds.length;
      }

      await db.delete(walletKeys).where(inArray(walletKeys.userId, priorUserIds));
      await db.delete(users).where(inArray(users.id, priorUserIds));
    }

    // ─── 2. Insert fresh seed data ────────────────────────────────────────────
    for (const changer of SEED_CHANGERS) {
      try {
        // Deterministic wallet at HD index = telegramId - 90000000 (1..22).
        // Same wallet every boot → fundable by scripts/fund-seed-shops.mjs.
        const seedIndex = changer.telegramId - 90000000;
        const wallet = generateDeterministicWallet(seedIndex);

        // Re-derive the signer (with private key) for API-key provisioning.
        // Only possible when SEED_MNEMONIC is set (same source as the wallet).
        const seedPhrase = process.env.SEED_MNEMONIC;
        let dexCreds: { apiKey: string; apiSecret: string } | null = null;
        if (seedPhrase) {
          const signer = HDNodeWallet.fromMnemonic(
            Mnemonic.fromPhrase(seedPhrase),
            `m/44'/60'/0'/0/${seedIndex}`,
          );
          dexCreds = await provisionSeedApiKey(signer);
        }

        const userInsert = await db.insert(users).values({
          openId: `seed_${changer.telegramHandle}`,
          name: changer.displayName,
          email: null,
          loginMethod: "telegram",
          telegramId: String(changer.telegramId),
          telegramUsername: changer.telegramHandle,
          telegramChatId: null,
          walletAddress: wallet.address,
          // Store the provisioned the venue key (encrypted secret) so the maker's
          // managed wallet can sign withdraws via walletSigner. null if the venue
          // was unreachable at seed time — shop is browsable but not tradeable.
          dexApiKey: dexCreds?.apiKey ?? null,
          dexApiSecret: dexCreds ? encryptPrivateKey(dexCreds.apiSecret) : null,
          xp: Math.floor(changer.totalOrdersFilled * 10),
          level: changer.reputationScore >= 95 ? "legend" : changer.reputationScore >= 85 ? "market_maker" : changer.reputationScore >= 75 ? "broker" : "trader",
          points: Math.floor(changer.totalOrdersFilled * 5),
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userId = ((userInsert as any).insertId ?? (userInsert as any)[0]?.insertId) as number;

        await db.insert(walletKeys).values({
          userId,
          address: wallet.address,
          encryptedKey: wallet.encryptedKey,
        });

        // Enable the managed-shop-wallet so executeBurst can sign the maker's
        // release + recycle legs server-side. Generous testnet caps.
        await db.insert(managedWalletCaps).values({
          userId,
          enabled: true,
          perTradeCapUsd: "100000",
          dailyVolumeCapUsd: "1000000",
          tokenAllowlist: SEED_TOKEN_ALLOWLIST,
          killed: false,
          enabledAt: new Date(),
        });

        const profileInsert = await db.insert(changerProfiles).values({
          userId,
          displayName: changer.displayName,
          bio: changer.bio,
          isActive: true,
          reputationScore: changer.reputationScore,
          avgRating: changer.avgRating,
          totalRatings: changer.totalRatings,
          completionRate: changer.completionRate,
          completionRate30d: changer.completionRate30d,
          totalOrdersFilled: changer.totalOrdersFilled,
          totalOrders30d: changer.totalOrders30d,
          avgSettlementMinutes: changer.avgSettlementMinutes,
          totalVolumeUsd: String(changer.totalVolumeUsd),
          telegramHandle: changer.telegramHandle,
          location: changer.location,
          promotionTier: "none",
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const changerId = ((profileInsert as any).insertId ?? (profileInsert as any)[0]?.insertId) as number;
        changersCreated++;

        // Only advertise what the shop can ACTUALLY fill. The maker releases
        // ad.fromToken from its the venue vault during the burst, and shops are funded
        // ~200K of 5 tokens only. So: skip ads whose fromToken isn't vault-funded
        // (they'd hit a "can't fill" wall), and cap advertised liquidity/maxOrder
        // to the real backing — no cosmetic 500K against a ~200K vault.
        const VAULT_FUNDED: Record<string, number> = { USDT: 150000, USDC: 150000, XSGD: 150000, JPYC: 150000, EURT: 150000 };
        for (const ad of changer.ads) {
          const backed = VAULT_FUNDED[ad.fromToken];
          if (!backed) continue; // shop holds no vault inventory of this sell token → don't list it
          const liq = Math.min(ad.liquidity, backed);
          const maxO = Math.min(ad.maxOrder, liq);
          const minO = Math.min(ad.minOrder, maxO);
          await db.insert(p2pAds).values({
            posterId: userId,
            changerId,
            adType: "swap",
            fromToken: ad.fromToken,
            toToken: ad.toToken,
            rate: String(ad.rate),
            liquidity: String(liq),
            liquidityRemaining: String(liq),
            minOrder: String(minO),
            maxOrder: String(maxO),
            terms: ad.terms ?? null,
            status: "active",
            promotionTier: ad.promotionTier ?? "none",
          });
          adsCreated++;
        }
      } catch (err) {
        errors.push(`${changer.displayName}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`top-level: ${(err as Error).message}`);
  }

  return {
    startedAt,
    endedAt: new Date().toISOString(),
    changersCreated,
    adsCreated,
    changersDeleted,
    adsDeleted,
    errors,
  };
}
