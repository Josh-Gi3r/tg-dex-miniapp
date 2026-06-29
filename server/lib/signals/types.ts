/**
 * ─── Signal Engine Types ─────────────────────────────────────────────────────
 *
 * The recommendation bot is a server-side worker that watches the venue + our DB
 * every ~60s and emits actionable signals. Strategies are pluggable functions
 * that take a snapshot of market state and return zero-or-more candidate
 * signals; the worker dedupes, persists, and delivers them.
 *
 * Each strategy is independent and pure — given the same input snapshot it
 * produces the same output. This makes them easy to backtest later.
 */

export type SignalType = "best_rate" | "stale_offer" | "wide_spread";

/** A live ad pulled from our DB, joined to its current the venue order state. */
export interface ActiveAdSnapshot {
  id: number;
  posterId: number;
  fromToken: string;
  toToken: string;
  /** Rate the maker posted: how many `toToken` per 1 `fromToken`. */
  rate: number;
  liquidity: number;
  liquidityRemaining: number;
  settlementOrderId: string | null;
  /** "USDT/XSGD" — derived from fromToken/toToken for grouping. */
  marketSymbol: string;
}

/** Oracle FX rate keyed by ISO currency pair, e.g. "USD/SGD" → 1.36. */
export type OracleRates = Record<string, number>;

/** Input passed to every strategy on each worker cycle. */
export interface StrategyContext {
  /** All currently-active ads with live the venue orders. */
  activeAds: ActiveAdSnapshot[];
  /** Latest oracle FX rates (fiat-keyed). */
  oracleRates: OracleRates;
  /** Server timestamp in unix seconds — use this not Date.now(). */
  serverTimestampSec: number;
}

/** Candidate signal emitted by a strategy. The worker assigns id/createdAt. */
export interface CandidateSignal {
  type: SignalType;
  marketSymbol: string;
  relatedAdId: number | null;
  /** Higher = more attractive. Strategy-specific units, all in bps. */
  opportunityScore: number;
  /** Rendering payload — JSON-stringified into bot_recommendations.payload. */
  payload: Record<string, unknown>;
  /** Suggested expiry — worker may clamp to a max. */
  ttlSeconds: number;
}

/**
 * A strategy is a pure function from `StrategyContext` to a list of
 * candidate signals. Strategies may emit duplicates; the worker dedupes
 * by (type, marketSymbol, relatedAdId) within the active expiration window.
 */
export type StrategyFn = (ctx: StrategyContext) => CandidateSignal[];
