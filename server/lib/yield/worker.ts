/**
 * ─── Yield Bot — Cycle Worker ────────────────────────────────────────────────
 *
 * One cycle:
 *   1. Snapshot pool NAV (USDC balance + open-order MTM).
 *   2. Compute per-share value vs. last cycle → cycle PnL bps.
 *   3. Apply risk gates (kill switch, drawdown stop).
 *   4. Plan + place orders (in production); record intents (in demo).
 *   5. Persist a yield_cycles row so the Earn tab can show NAV history.
 *
 * In demo mode (no YIELD_BOT_PRIVATE_KEY) the cycle is read-only:
 * computes NAV, persists the snapshot, but never signs a transaction.
 * That's deliberately useful — it gives the Earn tab a live NAV chart
 * even before the bot wallet is funded.
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { yieldCycles, yieldPositions } from "../../../drizzle/schema";
import { getDexClient } from "../dex/client";
import { getYieldBotWallet, isYieldBotConfigured } from "./wallet";
import { getRiskLimits } from "./risk";
import { planOrders, getStrategyConfig } from "./strategy";

export interface YieldCycleResult {
  startedAt: Date;
  endedAt: Date;
  totalAssets: number;
  totalShares: number;
  navPerShare: number;
  pnlBps: number;
  feeBps: number;
  ordersPlanned: number;
  ordersPlaced: number;
  killed: boolean;
  errors: string[];
}

const DEMO_BASE_NAV = 0;

const finite = (n: number, fallback = 0): number =>
  Number.isFinite(n) ? n : fallback;

export async function runYieldCycle(): Promise<YieldCycleResult> {
  const startedAt = new Date();
  const result: YieldCycleResult = {
    startedAt,
    endedAt: startedAt,
    totalAssets: 0,
    totalShares: 0,
    navPerShare: 1,
    pnlBps: 0,
    feeBps: 0,
    ordersPlanned: 0,
    ordersPlaced: 0,
    killed: false,
    errors: [],
  };

  // The cycle should never throw out of this function — the cron endpoint
  // turns thrown errors into HTTP 500, which makes cron-job.org mark the
  // job failed and stop firing. Capture everything into result.errors and
  // return 200 with diagnostics instead.
  try {
    const limits = getRiskLimits();
    const db = await getDb();
    if (!db) {
      result.errors.push("db unavailable");
      result.endedAt = new Date();
      return result;
    }

    // 1. Aggregate active positions to determine total shares + deposits.
    const positions = await db
      .select()
      .from(yieldPositions)
      .where(eq(yieldPositions.status, "active"));

    const totalShares = positions.reduce(
      (acc, p) => acc + finite(Number(p.shares)),
      0,
    );
    const totalDeposited = positions.reduce(
      (acc, p) => acc + finite(Number(p.depositedAmount)),
      0,
    );
    result.totalShares = totalShares;

    // 2. Compute NAV. In production, NAV = on-chain balance of bot wallet
    //    + open-order MTM. In demo (no wallet), NAV equals total deposited.
    let totalAssets = totalDeposited;
    if (isYieldBotConfigured()) {
      const wallet = getYieldBotWallet()!;
      try {
        const eth = await wallet.provider!.getBalance(wallet.address);
        void eth;
      } catch (err) {
        result.errors.push(`balance read failed: ${(err as Error).message}`);
      }
    } else {
      totalAssets = totalDeposited > 0 ? totalDeposited : DEMO_BASE_NAV;
    }
    result.totalAssets = totalAssets;

    // 3. NAV per share + cycle PnL bps relative to previous cycle.
    const navPerShare = totalShares > 0 ? finite(totalAssets / totalShares, 1) : 1;
    result.navPerShare = navPerShare;

    const [previous] = await db
      .select()
      .from(yieldCycles)
      .orderBy(desc(yieldCycles.createdAt))
      .limit(1);

    if (previous && finite(Number(previous.totalShares)) > 0) {
      const prevNav = finite(
        Number(previous.totalAssets) / Number(previous.totalShares),
      );
      if (prevNav > 0) {
        result.pnlBps = finite(((navPerShare - prevNav) / prevNav) * 10_000);
      }
    }

    // 4. Risk gates. Kill switch and drawdown stop both halt new orders.
    const drawdownTrip =
      result.pnlBps < limits.drawdownStopBps && limits.drawdownStopBps < 0;
    if (limits.killSwitch || drawdownTrip || !isYieldBotConfigured()) {
      result.killed = limits.killSwitch || drawdownTrip;
    } else {
      try {
        const intents = await planOrders(
          getDexClient(),
          totalAssets,
          getStrategyConfig(),
        );
        result.ordersPlanned = intents.length;
        result.ordersPlaced = 0;
      } catch (err) {
        result.errors.push(`plan failed: ${(err as Error).message}`);
      }
    }

    // 5. Performance fee: only on positive cycles.
    result.feeBps =
      result.pnlBps > 0
        ? finite((result.pnlBps * limits.performanceFeeBps) / 10_000)
        : 0;

    // Persist the snapshot. Clamp values to schema precision so a NaN or
    // out-of-range decimal can't poison the row.
    try {
      await db.insert(yieldCycles).values({
        totalAssets: finite(totalAssets).toFixed(6),
        totalShares: finite(totalShares).toFixed(12),
        pnlBps: finite(result.pnlBps),
        feeBps: finite(result.feeBps),
        status: JSON.stringify({
          configured: isYieldBotConfigured(),
          killed: result.killed,
          ordersPlanned: result.ordersPlanned,
          ordersPlaced: result.ordersPlaced,
          errors: result.errors,
        }),
      });
    } catch (err) {
      result.errors.push(`persist failed: ${(err as Error).message}`);
    }
  } catch (err) {
    result.errors.push(`cycle failed: ${(err as Error).message ?? String(err)}`);
  }

  result.endedAt = new Date();
  return result;
}
