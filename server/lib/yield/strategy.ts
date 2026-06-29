/**
 * ─── Yield Bot — Market-Making Strategy ──────────────────────────────────────
 *
 * Trivial v1 strategy: for each whitelisted FX pair, post a paired
 * limit-order around the the venue oracle midpoint. Spread is configurable
 * via YIELD_BOT_SPREAD_BPS (default 30bps). Order size is a fraction of
 * the available pool capital (default 1/10 per pair, capped at the
 * per-pair max).
 *
 * The output is a list of OrderIntents; the worker translates them into
 * the venue POST /orders calls. Strategy is deliberately stateless so it's
 * trivial to backtest and to swap out for smarter ones later.
 */

import type { VenueClient } from "../dex/client";

export interface StrategyConfig {
  pairs: Array<{ base: string; quote: string }>;
  spreadBps: number;
  maxOrderSizeUsdc: number;
  poolFraction: number;
}

export interface OrderIntent {
  pair: string;
  side: "buy" | "sell";
  rate: number;
  amountBase: number;
  amountQuote: number;
}

export function getStrategyConfig(): StrategyConfig {
  const raw = process.env.YIELD_BOT_PAIRS ?? "USDT/XSGD,USDT/MYRC,USDT/IDRX";
  const pairs = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [base, quote] = p.split("/");
      return { base, quote };
    })
    .filter((p) => p.base && p.quote);

  const num = (v: string | undefined, def: number) => {
    if (!v) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    pairs,
    spreadBps: num(process.env.YIELD_BOT_SPREAD_BPS, 30),
    maxOrderSizeUsdc: num(process.env.YIELD_BOT_MAX_ORDER_USDC, 500),
    poolFraction: num(process.env.YIELD_BOT_POOL_FRACTION, 0.1),
  };
}

/**
 * Plan one cycle of orders. Pure function — takes oracle rates + free
 * capital and returns intents. The worker decides what to do with them.
 */
export async function planOrders(
  client: VenueClient,
  freeCapitalUsdc: number,
  cfg: StrategyConfig = getStrategyConfig(),
): Promise<OrderIntent[]> {
  if (freeCapitalUsdc <= 0 || cfg.pairs.length === 0) return [];

  const perPair = Math.min(
    cfg.maxOrderSizeUsdc,
    (freeCapitalUsdc * cfg.poolFraction) / cfg.pairs.length,
  );
  if (perPair <= 0) return [];

  const intents: OrderIntent[] = [];
  for (const { base, quote } of cfg.pairs) {
    const rate = await client.getFxRate(base, quote).catch(() => null);
    const mid = rate ? Number(rate.rate) : NaN;
    if (!Number.isFinite(mid) || mid <= 0) continue;

    const halfSpread = (cfg.spreadBps / 10_000) / 2;
    const buyRate = mid * (1 - halfSpread);
    const sellRate = mid * (1 + halfSpread);

    intents.push({
      pair: `${base}/${quote}`,
      side: "buy",
      rate: buyRate,
      amountBase: perPair,
      amountQuote: perPair * buyRate,
    });
    intents.push({
      pair: `${base}/${quote}`,
      side: "sell",
      rate: sellRate,
      amountBase: perPair,
      amountQuote: perPair * sellRate,
    });
  }
  return intents;
}
