/**
 * ─── Signal Engine — Worker ──────────────────────────────────────────────────
 *
 * Runs ONE cycle: snapshot the venue + our DB, run all strategies, dedupe against
 * the live recommendation feed, persist new candidates, and trigger Telegram
 * deliveries to subscribed users.
 *
 * Designed as a single async function that's safe to call from any
 * scheduler — embed it in setInterval, run as a serverless cron, hit it
 * from a tRPC admin proc — they all converge on the same idempotent
 * behavior. Multiple concurrent calls are not great (no internal lock)
 * but the dedupe step prevents duplicate signals if they happen.
 */

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  botRecommendations,
  p2pAds,
  recommendationOutcomes,
  recommendationSubscriptions,
  users,
} from "../../../drizzle/schema";
import { getDexClient } from "../dex/client";
import { SUPPORTED_TOKENS, type TokenSymbol } from "@shared/venue-config";
import { sendMessage } from "../telegram";
import { STRATEGIES, STRATEGY_TYPES } from "./strategies";
import type {
  ActiveAdSnapshot,
  CandidateSignal,
  OracleRates,
  StrategyContext,
} from "./types";

export interface CycleResult {
  startedAt: Date;
  endedAt: Date;
  activeAds: number;
  oraclePairs: number;
  candidatesEmitted: number;
  candidatesPersisted: number;
  notificationsSent: number;
  errors: string[];
}

export const SIGNAL_CYCLE_INTERVAL_MS = 60_000;

let lastCycleResult: CycleResult | null = null;

export function getLastSignalCycle(): CycleResult | null {
  return lastCycleResult;
}

/**
 * Runs one full cycle. Safe to call repeatedly; idempotent within an
 * active recommendation's TTL window.
 */
export async function runSignalCycle(): Promise<CycleResult> {
  const startedAt = new Date();
  const result: CycleResult = {
    startedAt,
    endedAt: startedAt,
    activeAds: 0,
    oraclePairs: 0,
    candidatesEmitted: 0,
    candidatesPersisted: 0,
    notificationsSent: 0,
    errors: [],
  };

  try {
    // 1. Build the strategy context from a fresh snapshot
    const ctx = await snapshotContext(result);
    if (ctx.activeAds.length === 0) {
      result.endedAt = new Date();
      lastCycleResult = result;
      return result;
    }

    // 2. Run every registered strategy
    const allCandidates: CandidateSignal[] = [];
    for (const type of STRATEGY_TYPES) {
      try {
        const fn = STRATEGIES[type];
        const sigs = fn(ctx);
        allCandidates.push(...sigs);
      } catch (err) {
        result.errors.push(`strategy:${type} ${(err as Error).message}`);
      }
    }
    result.candidatesEmitted = allCandidates.length;

    // 3. Dedupe + persist
    const persisted = await persistCandidates(allCandidates);
    result.candidatesPersisted = persisted.length;

    // 4. Deliver to subscribers
    if (persisted.length > 0) {
      const sent = await deliverToSubscribers(persisted);
      result.notificationsSent = sent;
    }
  } catch (err) {
    result.errors.push(`cycle ${(err as Error).message}`);
  }

  result.endedAt = new Date();
  lastCycleResult = result;
  return result;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

async function snapshotContext(out: CycleResult): Promise<StrategyContext> {
  const db = await getDb();
  const client = getDexClient();
  const serverTimestampSec = await client.getServerTime().catch(() =>
    Math.floor(Date.now() / 1000),
  );

  // Active ads — only ones that are live on the venue
  const activeAds: ActiveAdSnapshot[] = [];
  if (db) {
    const rows = await db
      .select({
        id: p2pAds.id,
        posterId: p2pAds.posterId,
        fromToken: p2pAds.fromToken,
        toToken: p2pAds.toToken,
        rate: p2pAds.rate,
        liquidity: p2pAds.liquidity,
        liquidityRemaining: p2pAds.liquidityRemaining,
        settlementOrderId: p2pAds.settlementOrderId,
      })
      .from(p2pAds)
      .where(eq(p2pAds.status, "active"))
      .limit(500);
    for (const r of rows) {
      const a = r.fromToken;
      const b = r.toToken;
      const [base, quote] = a < b ? [a, b] : [b, a];
      activeAds.push({
        id: r.id,
        posterId: r.posterId,
        fromToken: r.fromToken,
        toToken: r.toToken,
        rate: parseFloat(r.rate),
        liquidity: parseFloat(r.liquidity),
        liquidityRemaining: parseFloat(r.liquidityRemaining),
        settlementOrderId: r.settlementOrderId,
        marketSymbol: `${base}/${quote}`,
      });
    }
  }
  out.activeAds = activeAds.length;

  // Oracle rates — fetch every distinct fiat pair we need based on active ads
  const oracleRates: OracleRates = {};
  const pairs = new Set<string>();
  for (const ad of activeAds) {
    const f = SUPPORTED_TOKENS[ad.fromToken as TokenSymbol]?.currency;
    const t = SUPPORTED_TOKENS[ad.toToken as TokenSymbol]?.currency;
    if (!f || !t) continue;
    if (f.toUpperCase() === t.toUpperCase()) continue;
    pairs.add(`${f}/${t}`);
  }
  await Promise.all(
    Array.from(pairs).map(async (pair) => {
      const [base, quote] = pair.split("/");
      try {
        const fx = await client.getFxRate(base!, quote!);
        if (fx?.rate) oracleRates[pair] = parseFloat(fx.rate);
      } catch (err) {
        out.errors.push(`fx:${pair} ${(err as Error).message}`);
      }
    }),
  );
  out.oraclePairs = Object.keys(oracleRates).length;

  return { activeAds, oracleRates, serverTimestampSec };
}

// ─── Persist (with dedupe) ──────────────────────────────────────────────────

async function persistCandidates(
  candidates: CandidateSignal[],
): Promise<Array<typeof botRecommendations.$inferSelect>> {
  const db = await getDb();
  if (!db || candidates.length === 0) return [];

  // Pull live recommendations (not yet expired) so we can dedupe against
  // them. Keyed on (type, marketSymbol, relatedAdId).
  const now = new Date();
  const live = await db
    .select()
    .from(botRecommendations)
    .where(
      and(
        gt(botRecommendations.expiresAt, now),
        inArray(botRecommendations.type, [...STRATEGY_TYPES]),
      ),
    );
  const liveKeys = new Set(
    live.map(
      (r) => `${r.type}|${r.marketSymbol ?? ""}|${r.relatedAdId ?? ""}`,
    ),
  );

  const persisted: Array<typeof botRecommendations.$inferSelect> = [];
  for (const c of candidates) {
    const key = `${c.type}|${c.marketSymbol ?? ""}|${c.relatedAdId ?? ""}`;
    if (liveKeys.has(key)) continue; // already showing
    const expiresAt = new Date(now.getTime() + c.ttlSeconds * 1000);
    const [inserted] = await db.insert(botRecommendations).values({
      type: c.type,
      marketSymbol: c.marketSymbol,
      relatedAdId: c.relatedAdId,
      opportunityScore: c.opportunityScore,
      payload: JSON.stringify(c.payload),
      expiresAt,
    });
    const id = Number(inserted.insertId);
    const row = await db
      .select()
      .from(botRecommendations)
      .where(eq(botRecommendations.id, id))
      .limit(1);
    if (row[0]) persisted.push(row[0]);
    liveKeys.add(key);
  }
  return persisted;
}

// ─── Deliver ────────────────────────────────────────────────────────────────
//
// For each new recommendation, look up subscribers whose preferences match,
// respect the per-hour rate cap, push a Telegram message + record a
// delivered-outcome row.

async function deliverToSubscribers(
  recs: Array<typeof botRecommendations.$inferSelect>,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  let sent = 0;

  // Pull all active subscriptions in one go
  const subs = await db
    .select({
      sub: recommendationSubscriptions,
      tgChatId: users.telegramChatId,
    })
    .from(recommendationSubscriptions)
    .innerJoin(users, eq(users.id, recommendationSubscriptions.userId))
    .where(eq(recommendationSubscriptions.isPaused, false));

  for (const rec of recs) {
    for (const { sub, tgChatId } of subs) {
      // Type filter
      const enabled = sub.enabledTypes.split(",").map((s) => s.trim());
      if (!enabled.includes(rec.type)) continue;
      // Score filter
      if (rec.opportunityScore < sub.minScore) continue;
      // For stale_offer signals: only the poster gets warned. Other users
      // shouldn't be told "Bob's offer is stale" — that's noise.
      if (rec.type === "stale_offer") {
        const adRows = await db
          .select({ posterId: p2pAds.posterId })
          .from(p2pAds)
          .where(eq(p2pAds.id, rec.relatedAdId ?? -1))
          .limit(1);
        if (adRows[0]?.posterId !== sub.userId) continue;
      }
      // Per-hour rate cap
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentCount = await db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(recommendationOutcomes)
        .where(
          and(
            eq(recommendationOutcomes.userId, sub.userId),
            eq(recommendationOutcomes.action, "delivered"),
            gt(recommendationOutcomes.createdAt, hourAgo),
          ),
        );
      if ((recentCount[0]?.count ?? 0) >= sub.maxPerHour) continue;

      // Compose + send the Telegram message (when subscribed to that channel)
      if (sub.deliveryMethod !== "in_app" && tgChatId) {
        try {
          await sendMessage(tgChatId, formatTelegramMessage(rec));
          sent++;
        } catch (err) {
          // Swallow — Telegram failures shouldn't block signal flow
        }
      }

      // Record the delivered outcome (used for rate cap + analytics)
      await db.insert(recommendationOutcomes).values({
        recommendationId: rec.id,
        userId: sub.userId,
        action: "delivered",
      });
    }
  }
  return sent;
}

function formatTelegramMessage(rec: typeof botRecommendations.$inferSelect): string {
  const payload = JSON.parse(rec.payload) as Record<string, unknown>;
  switch (rec.type) {
    case "best_rate":
      return (
        `📊 <b>Better-than-market rate</b>\n` +
        `${payload.fromToken} → ${payload.toToken}: <b>${payload.rate}</b>\n` +
        `Beats market by <b>+${payload.beatsMarketBps} bps</b> ` +
        `(oracle ${payload.oracleRate}). ${payload.liquidityRemaining} ${payload.fromToken} available.\n\n` +
        `Open the app → P2P → Browse to take it.`
      );
    case "stale_offer":
      return payload.direction === "exposed"
        ? `⚠️ <b>Your offer is exposed</b>\n` +
          `${payload.fromToken} → ${payload.toToken} at ${payload.rate} is now ` +
          `<b>+${payload.driftBps} bps</b> above market — it'll get picked off. ` +
          `Open the app → My Positions to update or cancel.`
        : `📉 <b>Your offer is uncompetitive</b>\n` +
          `${payload.fromToken} → ${payload.toToken} at ${payload.rate} is now ` +
          `<b>${payload.driftBps} bps</b> off-market. Update or cancel via My Positions.`;
    case "wide_spread":
      return (
        `💼 <b>Wide spread on ${payload.marketSymbol}</b>\n` +
        `Bid ${payload.bestBid}, ask ${payload.bestAsk} — <b>${payload.spreadBps} bps</b> spread. ` +
        `Good market for posting liquidity. Open the app → Become a Market Maker.`
      );
    default:
      return "New trading signal — open the app to view";
  }
}
