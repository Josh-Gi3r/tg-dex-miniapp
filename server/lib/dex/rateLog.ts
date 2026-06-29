/**
 * Rate logger — snapshots the venue's executable rate + the FX oracle mid per SEA
 * direction into `rate_history`, so the app can answer "the rate at that hour"
 * (the live API has no historical endpoint). Run by the background scheduler
 * and the /internal/rate-log/run manual trigger.
 */
import { analyzeDirections, SEA_DIRECTIONS } from "./analysis";
import { getDb } from "../../db";
import { rateHistory } from "../../../drizzle/schema";

export async function runRateLogCycle(): Promise<{ logged: number }> {
  const rows = (await analyzeDirections(SEA_DIRECTIONS)).filter((d) => d.settlementRate != null);
  const db = await getDb();
  if (db && rows.length) {
    await db.insert(rateHistory).values(
      rows.map((d) => ({
        fromToken: d.from,
        toToken: d.to,
        settlementRate: d.settlementRate != null ? String(d.settlementRate) : null,
        oracleMid: d.oracleMid != null ? String(d.oracleMid) : null,
        edgeBps: d.edgeBps != null ? Math.round(d.edgeBps) : null,
      })),
    );
  }
  return { logged: rows.length };
}
