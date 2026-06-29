/**
 * ─── the venue market analysis ────────────────────────────────────────────────────
 *
 * The shared "edge" math used by the Assistant grounding, the opportunity radar,
 * and the trade-on-behalf agent. For each direction it compares the venue's live
 * EXECUTABLE rate (a throwaway /swap/quote — what you'd actually get) against the
 * real-world FX oracle mid (/fx/rate), and reports the edge in bps.
 *
 *   - cross-fiat (e.g. USDT→XSGD): edge = (settlementRate − oracleMid) / oracleMid.
 *     positive = the venue gives MORE than the market mid = a good deal for the taker.
 *   - same-fiat (e.g. USDT→USDC): mid is the 1.0 peg; edge = how far the venue is off
 *     the peg = a depeg signal.
 *
 * All read-only: throwaway burn wallet, no gas, no trade.
 */
import { getDexClient } from "./client";

const THROW = "0x000000000000000000000000000000000000dEaD";

export interface DirectionAnalysis {
  from: string;
  to: string;
  settlementRate: number | null;   // executable: output per input
  oracleMid: number | null;  // FX oracle mid (or 1.0 peg for same-fiat)
  edgeBps: number | null;    // (venue rate − mid)/mid × 10000
  change24hPct: number | null;
  sameFiat: boolean;
  depeg: boolean;            // same-fiat & |edge| over threshold
  note: string;
}

export interface Tok { address: string; decimals: number; currency: string; minTrade: number }

export async function tokenMap(): Promise<Record<string, Tok>> {
  const tk = await getDexClient().getTokens();
  const list = (tk.tokens ?? []) as Array<{ symbol: string; address: string; decimals: number; currency: string; min_trade_amount?: number | string }>;
  const m: Record<string, Tok> = {};
  for (const t of list) m[t.symbol] = { address: t.address, decimals: t.decimals, currency: t.currency, minTrade: Number(t.min_trade_amount ?? 0) || 0 };
  return m;
}

/** Raw quote: output human units for `amountH` of `from`, or null on no_liquidity/error. */
async function quoteOut(from: Tok, to: Tok, amountH: number, expiration: number): Promise<number | null> {
  const client = getDexClient();
  const amountRaw = BigInt(Math.round(amountH * 10 ** from.decimals)).toString();
  try {
    const res = await fetch(`${client.base}/swap/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "dex-app-analysis/1" },
      body: JSON.stringify({
        from_token: from.address, to_token: to.address, from_amount: amountRaw,
        owner_address: THROW, recipient: THROW, expiration, gas_mode: "receive_less",
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { route_params?: { minOutputAmount?: string } };
    const out = j.route_params?.minOutputAmount;
    return out != null ? Number(out) / 10 ** to.decimals : null;
  } catch {
    return null;
  }
}

/**
 * The TRUE executable rate = the MARGINAL slope of the quote curve, NOT the
 * single-probe average. the venue applies a large fixed per-trade fee on testnet
 * (~32 output units), so `out/in` at one small size is heavily distorted
 * (a 100-unit USDT→XSGD probe reads ~0.94 when the real rate is 1.263). We probe
 * a ladder and take the slope between the two largest fills — which cancels the
 * fixed fee — and also return the reachable depth. null = nothing fills.
 */
export async function marginalRate(
  from: Tok, to: Tok, expiration: number,
): Promise<{ rate: number; maxFill: number } | null> {
  const base = Math.max(from.minTrade * 2, from.minTrade + 1, 1);
  const sizes = [base, base * 5, base * 25];
  const fills: Array<{ sz: number; out: number }> = [];
  for (const sz of sizes) {
    const out = await quoteOut(from, to, sz, expiration);
    if (out != null && out > 0) fills.push({ sz, out });
  }
  if (fills.length === 0) return null;
  if (fills.length === 1) return { rate: fills[0].out / fills[0].sz, maxFill: fills[0].sz };
  const a = fills[fills.length - 2], b = fills[fills.length - 1];
  const slope = (b.out - a.out) / (b.sz - a.sz);
  return { rate: slope > 0 ? slope : b.out / b.sz, maxFill: b.sz };
}

async function venueExecRate(from: Tok, to: Tok, expiration: number): Promise<number | null> {
  const r = await marginalRate(from, to, expiration);
  return r ? r.rate : null;
}

const DEPEG_BPS = 50; // same-fiat deviation that counts as a depeg signal

/** Analyze a set of [from,to] symbol pairs. Best-effort; entries that fail come back with nulls. */
export async function analyzeDirections(pairs: Array<[string, string]>): Promise<DirectionAnalysis[]> {
  const client = getDexClient();
  let tokens: Record<string, Tok> = {};
  let expiration = 0;
  try {
    tokens = await tokenMap();
    expiration = (await client.getServerTime()) + 600;
  } catch {
    return [];
  }

  return Promise.all(
    pairs.map(async ([from, to]): Promise<DirectionAnalysis> => {
      const f = tokens[from], t = tokens[to];
      const base: DirectionAnalysis = {
        from, to, settlementRate: null, oracleMid: null, edgeBps: null,
        change24hPct: null, sameFiat: false, depeg: false, note: "",
      };
      if (!f || !t) return { ...base, note: "unknown token" };

      const settlementRate = await venueExecRate(f, t, expiration);
      base.settlementRate = settlementRate;
      base.sameFiat = f.currency === t.currency;

      if (base.sameFiat) {
        // Stablecoins of the same fiat should trade ~1:1. Deviation = depeg.
        base.oracleMid = 1;
        if (settlementRate != null) {
          base.edgeBps = (settlementRate - 1) * 10000;
          base.depeg = Math.abs(base.edgeBps) >= DEPEG_BPS;
          base.note = base.depeg
            ? `${from} is ${base.edgeBps < 0 ? "cheap" : "rich"} vs ${to} by ${Math.abs(base.edgeBps).toFixed(0)} bps`
            : "near peg";
        }
      } else {
        try {
          const fx = await client.getFxRate(f.currency, t.currency);
          if (fx) {
            base.oracleMid = Number(fx.rate);
            base.change24hPct = fx.change_pct != null ? Number(fx.change_pct) : null;
            if (settlementRate != null && base.oracleMid > 0) {
              base.edgeBps = (settlementRate - base.oracleMid) / base.oracleMid * 10000;
              base.note = base.edgeBps >= 0
                ? `${base.edgeBps.toFixed(0)} bps better than market mid`
                : `${Math.abs(base.edgeBps).toFixed(0)} bps under market mid`;
            }
          }
        } catch { /* fx unavailable */ }
      }
      return base;
    }),
  );
}

/** Convenience: the SEA-corridor directions the app cares about. */
export const SEA_DIRECTIONS: Array<[string, string]> = [
  ["USDT", "XSGD"], ["XSGD", "USDT"], ["USDT", "JPYC"], ["JPYC", "USDT"],
  ["USDT", "USDC"], ["USDC", "USDT"], ["EURT", "USDT"], ["USDC", "XSGD"], ["XSGD", "JPYC"],
];
