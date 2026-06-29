/**
 * ─── Signal Engine — v1 Strategies ───────────────────────────────────────────
 *
 * Three pure functions, each watching one signal type. Defaults match the
 * thresholds you approved:
 *   best_rate    → ad beats oracle by ≥ 5 bps
 *   stale_offer  → ad drifted ≥ 10 bps off-market (poster gets warned)
 *   wide_spread  → mid-quoted spread between best bid + best ask ≥ 15 bps
 *
 * Score units are always basis points (bps). 1 bps = 0.01% = 0.0001.
 */

import { SUPPORTED_TOKENS, type TokenSymbol } from "@shared/venue-config";
import type {
  CandidateSignal,
  StrategyContext,
  StrategyFn,
  ActiveAdSnapshot,
  OracleRates,
} from "./types";

// Tunable thresholds. Stay in sync with the asks-doc UX defaults.
const BEST_RATE_MIN_BPS = 5;
const STALE_OFFER_MIN_BPS = 10;
const WIDE_SPREAD_MIN_BPS = 15;

// Default TTLs (seconds). Best-rate signals go stale fast; stale-offer
// warnings persist longer because the maker may be away from the app.
const TTL_BEST_RATE = 180;     // 3 min
const TTL_STALE_OFFER = 600;   // 10 min
const TTL_WIDE_SPREAD = 300;   // 5 min

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Looks up the ISO fiat code for a stablecoin symbol, e.g. "USDT" → "USD". */
function symbolToCurrency(symbol: string): string | null {
  const tok = SUPPORTED_TOKENS[symbol as TokenSymbol];
  return tok?.currency ?? null;
}

/**
 * Returns the oracle rate for a fromCurrency→toCurrency conversion, looking
 * up either direction and inverting if needed. Returns null when neither
 * direction has an oracle entry.
 */
function oracleRateFor(
  fromCcy: string,
  toCcy: string,
  oracle: OracleRates,
): number | null {
  if (fromCcy.toUpperCase() === toCcy.toUpperCase()) return 1;
  const direct = oracle[`${fromCcy}/${toCcy}`];
  if (direct && direct > 0) return direct;
  const inverse = oracle[`${toCcy}/${fromCcy}`];
  if (inverse && inverse > 0) return 1 / inverse;
  return null;
}

/** Computes the bps difference of `actual` vs `reference`. Positive = better
 *  for someone receiving `toToken` (i.e. more output per input). */
function diffBps(actual: number, reference: number): number {
  if (!reference || reference <= 0) return 0;
  return ((actual - reference) / reference) * 10_000;
}

// ─── Strategy 1: best_rate ───────────────────────────────────────────────────
//
// For each active ad, compare its posted rate to the oracle. If the ad gives
// the taker MORE output than the oracle (positive diffBps), that's a deal.

export const bestRateStrategy: StrategyFn = (ctx: StrategyContext) => {
  const out: CandidateSignal[] = [];
  for (const ad of ctx.activeAds) {
    if (!ad.settlementOrderId) continue;
    const fromCcy = symbolToCurrency(ad.fromToken);
    const toCcy = symbolToCurrency(ad.toToken);
    if (!fromCcy || !toCcy) continue;
    const oracle = oracleRateFor(fromCcy, toCcy, ctx.oracleRates);
    if (oracle === null) continue;
    const beatsBy = diffBps(ad.rate, oracle);
    if (beatsBy < BEST_RATE_MIN_BPS) continue;
    out.push({
      type: "best_rate",
      marketSymbol: ad.marketSymbol,
      relatedAdId: ad.id,
      opportunityScore: beatsBy,
      payload: {
        adId: ad.id,
        fromToken: ad.fromToken,
        toToken: ad.toToken,
        rate: ad.rate,
        oracleRate: oracle,
        beatsMarketBps: Math.round(beatsBy * 10) / 10,
        liquidityRemaining: ad.liquidityRemaining,
      },
      ttlSeconds: TTL_BEST_RATE,
    });
  }
  return out;
};

// ─── Strategy 2: stale_offer ─────────────────────────────────────────────────
//
// For each active ad whose posted rate has drifted off-market enough that
// it's exposed to being picked off, alert the POSTER. Note this signal is
// targeted at the maker, not all subscribers — the worker will route it
// to ad.posterId only.

export const staleOfferStrategy: StrategyFn = (ctx: StrategyContext) => {
  const out: CandidateSignal[] = [];
  for (const ad of ctx.activeAds) {
    if (!ad.settlementOrderId) continue;
    const fromCcy = symbolToCurrency(ad.fromToken);
    const toCcy = symbolToCurrency(ad.toToken);
    if (!fromCcy || !toCcy) continue;
    const oracle = oracleRateFor(fromCcy, toCcy, ctx.oracleRates);
    if (oracle === null) continue;
    // Negative = ad gives takers LESS than market (good for maker).
    // Positive = ad gives takers MORE than market (maker exposed).
    const driftBps = diffBps(ad.rate, oracle);
    const absDrift = Math.abs(driftBps);
    if (absDrift < STALE_OFFER_MIN_BPS) continue;
    const direction = driftBps > 0 ? "exposed" : "off_market";
    out.push({
      type: "stale_offer",
      marketSymbol: ad.marketSymbol,
      relatedAdId: ad.id,
      opportunityScore: absDrift,
      payload: {
        adId: ad.id,
        fromToken: ad.fromToken,
        toToken: ad.toToken,
        rate: ad.rate,
        oracleRate: oracle,
        driftBps: Math.round(driftBps * 10) / 10,
        direction, // "exposed" = giving takers too much, "off_market" = uncompetitive
      },
      ttlSeconds: TTL_STALE_OFFER,
    });
  }
  return out;
};

// ─── Strategy 3: wide_spread ─────────────────────────────────────────────────
//
// For each market, compute the bid-ask spread implied by the active ads on
// each side. If the spread is wide, posting a maker offer in the middle is
// likely profitable. Surfaces the OPPORTUNITY to the user, not specific ads.
//
// "Bid side" = ads where someone is buying USDT/etc.; "ask side" = selling.
// In our schema, an ad is `from_token → to_token` from the maker's
// perspective. We treat pairs as one canonical direction (alphabetical) so
// we can compare across both directions of the same market.

interface MarketBook {
  bestBid: number | null; // best price someone is willing to pay (high = good for seller)
  bestAsk: number | null; // best price someone is willing to receive (low = good for buyer)
  bidAdId: number | null;
  askAdId: number | null;
}

export const wideSpreadStrategy: StrategyFn = (ctx: StrategyContext) => {
  const books = new Map<string, MarketBook>();

  for (const ad of ctx.activeAds) {
    if (!ad.settlementOrderId) continue;
    const a = ad.fromToken;
    const b = ad.toToken;
    if (a === b) continue;
    // Canonicalize: market key is alphabetical "USDT/XSGD" regardless of
    // which way the ad goes.
    const [base, quote] = a < b ? [a, b] : [b, a];
    const canonical = `${base}/${quote}`;
    // Compute the implied "price in quote per base" from this ad.
    // If ad is base → quote: maker sells base for quote at rate = quote per base. That's an ASK.
    // If ad is quote → base: maker sells quote for base at rate = base per quote. Convert to quote/base = 1/rate. That's a BID.
    const isAsk = ad.fromToken === base;
    const pricePerBase = isAsk ? ad.rate : 1 / ad.rate;
    const book = books.get(canonical) ?? {
      bestBid: null, bestAsk: null, bidAdId: null, askAdId: null,
    };
    if (isAsk) {
      // Lower ask is better for the book (cheaper to buy base)
      if (book.bestAsk === null || pricePerBase < book.bestAsk) {
        book.bestAsk = pricePerBase;
        book.askAdId = ad.id;
      }
    } else {
      // Higher bid is better for the book (more quote per base offered)
      if (book.bestBid === null || pricePerBase > book.bestBid) {
        book.bestBid = pricePerBase;
        book.bidAdId = ad.id;
      }
    }
    books.set(canonical, book);
  }

  const out: CandidateSignal[] = [];
  for (const [marketSymbol, book] of books) {
    if (book.bestBid === null || book.bestAsk === null) continue;
    if (book.bestAsk <= book.bestBid) continue; // crossed book = no spread
    const mid = (book.bestBid + book.bestAsk) / 2;
    const spreadBps = ((book.bestAsk - book.bestBid) / mid) * 10_000;
    if (spreadBps < WIDE_SPREAD_MIN_BPS) continue;
    out.push({
      type: "wide_spread",
      marketSymbol,
      relatedAdId: null,
      opportunityScore: spreadBps,
      payload: {
        marketSymbol,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        midPrice: mid,
        spreadBps: Math.round(spreadBps * 10) / 10,
      },
      ttlSeconds: TTL_WIDE_SPREAD,
    });
  }
  return out;
};

// ─── Strategy registry ───────────────────────────────────────────────────────

export const STRATEGIES = {
  best_rate: bestRateStrategy,
  stale_offer: staleOfferStrategy,
  wide_spread: wideSpreadStrategy,
} as const;

export const STRATEGY_TYPES = Object.keys(STRATEGIES) as Array<keyof typeof STRATEGIES>;
