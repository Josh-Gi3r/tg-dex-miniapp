/**
 * ─── Yield Bot — Risk Controls ──────────────────────────────────────────────
 *
 * Read-only helpers that gate worker behavior. The kill switch is the
 * loudest control: setting YIELD_BOT_KILL=true at boot (or via a
 * Railway redeploy) immediately halts all new orders. Existing positions
 * are unaffected — users withdraw on demand.
 *
 * Drawdown stop is implemented in the worker; this file just exposes the
 * threshold so the strategy and the cycle loop agree on it.
 */

export interface RiskLimits {
  /** Hard cap on total USDC the pool will accept (across all users). */
  maxPoolSizeUsdc: number;
  /** Per-user cap on deposits. */
  maxPerUserUsdc: number;
  /** If a single cycle realizes worse than this PnL bps, pause new orders. */
  drawdownStopBps: number;
  /** Performance fee charged on positive cycles only. */
  performanceFeeBps: number;
  /** Hard kill — stops all order placement. */
  killSwitch: boolean;
}

function num(envVal: string | undefined, fallback: number): number {
  if (!envVal) return fallback;
  const n = Number(envVal);
  return Number.isFinite(n) ? n : fallback;
}

export function getRiskLimits(): RiskLimits {
  return {
    maxPoolSizeUsdc: num(process.env.YIELD_BOT_MAX_POOL_USDC, 50_000),
    maxPerUserUsdc: num(process.env.YIELD_BOT_MAX_USER_USDC, 5_000),
    drawdownStopBps: num(process.env.YIELD_BOT_DRAWDOWN_STOP_BPS, -50),
    performanceFeeBps: num(process.env.YIELD_BOT_FEE_BPS, 1000),
    killSwitch: process.env.YIELD_BOT_KILL === "true",
  };
}
