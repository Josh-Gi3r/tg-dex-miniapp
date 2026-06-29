/**
 * ─── Live Book Scanner ───────────────────────────────────────────────────────
 *
 * Reconstructs the venue's closed CLOB from outside, to the decimal, for $0:
 *   1. Vault balanceOf → the only tokens that can be an OUTPUT (every resting
 *      order locks its payout, so its payout token is vault-funded).
 *   2. /markets → candidate directions whose OUTPUT is funded.
 *   3. Per direction, fine-walk /swap/quote (throwaway wallet, no gas, no auth):
 *      the steady marginal rate = an order's exact price; where the marginal
 *      STEPS = a new order/level; the cliff = total depth.
 *
 * Verified on a live order 2026-05-29: an off-market 0.6942 order surfaced as a
 * flat marginal 1.44051 (≠ oracle 1.49034) with the cliff at its size — proving
 * this reads REAL orders, not the FX reference.
 *
 * NEVER run on the request path — it's hundreds of sequential quotes. Run via
 * the /internal/book-scan cron; tRPC serves the last cached snapshot instantly.
 */
import { JsonRpcProvider, Interface } from "ethers";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDexClient } from "./client";
import { getActiveRpcUrl } from "./txVerifier";
import { getDb } from "../../db";
import { p2pAds } from "../../../drizzle/schema";

const THROW = "0x000000000000000000000000000000000000dEaD";
const FETCH_TIMEOUT_MS = 6000;
const GAP_MS = 120;              // between quotes — stay under the rate limit
const MAX_DIRECTIONS = 24;       // hard cap so a full scan finishes in <60s
const CALL_TIMEOUT_MS = 5000;    // per on-chain balanceOf
const MARGINAL_TOL = 0.004;      // 0.4% — group walk points into one price level
const erc20 = new Interface(["function balanceOf(address) view returns (uint256)"]);

export interface BookLevel { rate: number; depthOutFrom: number; depthOutTo: number }
export interface BookDirection {
  from: string; to: string;
  rate: number | null;        // best (top-of-book) executable rate
  totalDepthOut: number;      // total fillable output (token `to`)
  maxFillIn: number;          // largest fillable input (token `from`)
  levels: BookLevel[];        // distinct price levels (≈ individual orders)
}
export interface BookSnapshot {
  scannedAt: number;
  network: string;
  fundedTokens: Array<{ symbol: string; balance: number }>;
  directions: BookDirection[];
  candidates: number;
}

let CACHE: BookSnapshot | null = null;
let SCANNING = false;
export function getCachedBook(): BookSnapshot | null { return CACHE; }
export function isScanning(): boolean { return SCANNING; }

async function fetchJSON(url: string, init?: RequestInit): Promise<any | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) return { __status: r.status };
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One quote: input (human) → output (human), or null. */
async function quote(base: string, from: { a: string; d: number }, to: { a: string; d: number }, amtHuman: number, exp: number): Promise<number | null> {
  const body = JSON.stringify({
    from_token: from.a, to_token: to.a,
    from_amount: BigInt(Math.round(amtHuman * 10 ** from.d)).toString(),
    owner_address: THROW, recipient: THROW, expiration: exp, gas_mode: "receive_less",
  });
  const j = await fetchJSON(`${base}/swap/quote`, {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "dex-app-book/1" }, body,
  });
  const out = j?.route_params?.minOutputAmount;
  return out ? Number(out) / 10 ** to.d : null;
}

/** Fine-walk a direction: bracket the cliff, then read the marginal curve into levels. */
async function walkDirection(base: string, from: { a: string; d: number }, to: { a: string; d: number }, minIn: number, exp: number): Promise<BookDirection | null> {
  // existence: the venue rejects sizes below the order min (AMOUNT_BELOW_MIN) AND
  // charges a large fixed fee, so the smallest probe often returns no fill even
  // when an order exists. Ladder UP from the min until something fills.
  const floor = Math.max(minIn * 2, minIn + 1, 1);
  let start = 0;
  let first: number | null = null;
  for (const mult of [1, 5, 25, 125, 625]) {
    const s = floor * mult;
    const o = await quote(base, from, to, s, exp); await sleep(GAP_MS);
    if (o != null) { start = s; first = o; break; }
  }
  if (first == null || start === 0) return null;

  // bracket the cliff: grow ×2.5 until no_liquidity (bounded — keep the scan fast)
  const pts: Array<{ inAmt: number; out: number }> = [{ inAmt: start, out: first }];
  let probe = start, hi = 0;
  for (let i = 0; i < 6; i++) {
    probe *= 2.5;
    const o = await quote(base, from, to, probe, exp); await sleep(GAP_MS);
    if (o == null) { hi = probe; break; }
    pts.push({ inAmt: probe, out: o });
  }
  // quick bisect (≤2 steps) to tighten the cliff
  if (hi > 0) {
    let lo = pts[pts.length - 1].inAmt;
    for (let i = 0; i < 2 && (hi - lo) / hi > 0.05; i++) {
      const mid = (lo + hi) / 2;
      const o = await quote(base, from, to, mid, exp); await sleep(GAP_MS);
      if (o == null) hi = mid; else { lo = mid; pts.push({ inAmt: mid, out: o }); }
    }
  }
  pts.sort((a, b) => a.inAmt - b.inAmt);

  // segment the marginal curve into price levels (skip the fee-dominated first point)
  const levels: BookLevel[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dIn = pts[i].inAmt - pts[i - 1].inAmt;
    if (dIn <= 0) continue;
    const marg = (pts[i].out - pts[i - 1].out) / dIn; // output per input over this slice
    const last = levels[levels.length - 1];
    if (last && Math.abs(marg - last.rate) / last.rate <= MARGINAL_TOL) {
      last.depthOutTo = pts[i].out;
    } else {
      levels.push({ rate: marg, depthOutFrom: pts[i - 1].out, depthOutTo: pts[i].out });
    }
  }
  const top = pts.length > 1 ? pts[pts.length - 1] : pts[0];
  return {
    from: "", to: "", // filled by caller
    rate: levels.length ? levels[0].rate : (first / start),
    totalDepthOut: top.out,
    maxFillIn: top.inAmt,
    levels,
  };
}

/** Full scan: vault read → funded-output directions → fine-walk each. */
export async function scanLiveBook(): Promise<BookSnapshot | null> {
  if (SCANNING) return CACHE;
  SCANNING = true;
  try {
    const client = getDexClient();
    const cfg = await client.getConfig();
    const vault = cfg.vault_address;
    const tokensRes = await client.getTokens();
    const tokens = (tokensRes.tokens ?? []) as Array<{ symbol: string; address: string; decimals: number; min_trade_amount?: string }>;
    const exp = (await client.getServerTime()) + 600;

    // 1. vault balances (the only possible output tokens) — parallel batches with
    // a per-call timeout so a slow/unresponsive RPC can never hang the whole scan.
    const provider = new JsonRpcProvider(getActiveRpcUrl());
    const funded: Record<string, number> = {};
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    const BATCH = 20;
    for (let i = 0; i < tokens.length; i += BATCH) {
      await Promise.all(tokens.slice(i, i + BATCH).map(async (t) => {
        try {
          const res = await withTimeout(provider.call({ to: t.address, data: erc20.encodeFunctionData("balanceOf", [vault]) }), CALL_TIMEOUT_MS);
          if (res == null) return;
          const bal = Number(BigInt(res)) / 10 ** t.decimals;
          if (bal > 0.0001) funded[t.symbol] = bal;
        } catch { /* skip */ }
      }));
    }
    const fundedSet = new Set(Object.keys(funded));

    // 2. candidate directions whose OUTPUT is funded
    const marketsRes = await client.getMarkets();
    const markets = (marketsRes.markets ?? []) as Array<{ base_symbol: string; quote_symbol: string }>;
    const bySym: Record<string, { a: string; d: number; min: number }> = {};
    for (const t of tokens) bySym[t.symbol] = { a: t.address, d: t.decimals, min: Number(t.min_trade_amount ?? 0.1) };
    const seen = new Set<string>();
    const dirs: Array<[string, string]> = [];
    const pushDir = (from: string, to: string) => {
      const k = `${from}>${to}`;
      if (!seen.has(k)) { seen.add(k); dirs.push([from, to]); }
    };
    for (const m of markets) {
      if (fundedSet.has(m.quote_symbol)) pushDir(m.base_symbol, m.quote_symbol);
      if (fundedSet.has(m.base_symbol)) pushDir(m.quote_symbol, m.base_symbol);
    }
    // Prioritize directions REAL orders exist in: the live shop ads (and their
    // reverses) + the CORE SEA pairs. On testnet ~33 tokens hold faucet dust with
    // ENORMOUS balances, so sorting by balance buries the real pairs past the
    // scan cap. Scan the known-live set first, then the rest by balance.
    const CORE: Array<[string, string]> = [
      ["USDT", "XSGD"], ["XSGD", "USDT"], ["USDC", "USDT"], ["USDT", "USDC"],
      ["EURT", "USDT"], ["USDC", "XSGD"], ["XSGD", "USDC"], ["USDT", "JPYC"], ["JPYC", "USDT"],
    ];
    const pri = new Set<string>();
    const priority: Array<[string, string]> = [];
    const addPri = (f: string, t: string) => {
      const k = `${f}>${t}`;
      if (!pri.has(k) && fundedSet.has(t) && bySym[f] && bySym[t]) { pri.add(k); priority.push([f, t]); }
    };
    try {
      const db = await getDb();
      if (db) {
        const onBook = await db
          .selectDistinct({ from: p2pAds.fromToken, to: p2pAds.toToken })
          .from(p2pAds)
          .where(and(eq(p2pAds.status, "active"), isNotNull(p2pAds.settlementOrderId)));
        for (const r of onBook) { addPri(r.from, r.to); addPri(r.to, r.from); }
      }
    } catch { /* fall back to CORE + dust */ }
    for (const [f, t] of CORE) addPri(f, t);
    const rest = dirs
      .filter(([f, t]) => !pri.has(`${f}>${t}`))
      .sort((a, b) => (funded[b[1]] ?? 0) - (funded[a[1]] ?? 0));
    const ordered = [...priority, ...rest];
    const candidates = ordered.length;

    // 3. fine-walk each (bounded)
    const directions: BookDirection[] = [];
    for (const [from, to] of ordered.slice(0, MAX_DIRECTIONS)) {
      const f = bySym[from], t = bySym[to];
      if (!f || !t) continue;
      const d = await walkDirection(client.base, f, t, f.min, exp);
      if (d && d.totalDepthOut > 0) { d.from = from; d.to = to; directions.push(d); }
    }
    directions.sort((a, b) => b.totalDepthOut - a.totalDepthOut);

    CACHE = {
      scannedAt: Math.floor(Date.now() / 1000),
      network: cfg.chain_id === 1 ? "mainnet" : `chain-${cfg.chain_id}`,
      fundedTokens: Object.entries(funded).map(([symbol, balance]) => ({ symbol, balance })),
      directions,
      candidates,
    };
    return CACHE;
  } catch (err) {
    console.error("[book-scan] failed:", err instanceof Error ? err.message : err);
    return CACHE;
  } finally {
    SCANNING = false;
  }
}
