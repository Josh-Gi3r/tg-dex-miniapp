/**
 * Live ORDER-book reader — the real resting book, not a quote-probe.
 *
 * the venue has no global "all orders" endpoint, but `GET /orders?owner_address=X`
 * (authed) returns every resting order a maker has, including off-market ones a
 * `/swap/quote` can't see ("no_liquidity" from a quote means no takeable fill
 * RIGHT NOW, NOT no orders). On testnet the makers ARE our seed shops (we hold
 * their keys), so enumerating them = the whole book.
 *
 * Why this matters: an order that EXISTS is funded on the maker's side (the venue
 * locks the backing — it shows as vault_frozen), so it's a real fillable offer
 * regardless of aggregate liquidity in the *other* token. The swap should offer
 * every funded order, not a hardcoded token list. Each resting order yields a
 * taker route:
 *   bid  BASE/QUOTE  → taker sells BASE for QUOTE  (route BASE→QUOTE)
 *   ask  BASE/QUOTE  → taker buys  BASE with QUOTE (route QUOTE→BASE)
 */
import { and, gte, lte } from "drizzle-orm";
import { getDb } from "../../db";
import { users } from "../../../drizzle/schema";
import { getDexClient } from "./client";
import { getDecryptedDexCreds } from "./apiKey";

const SEED_TG_MIN = 90000001;
const SEED_TG_MAX = 90000022;
const CACHE_TTL_MS = 90_000;

export interface LiveRoute {
  from: string; // input token symbol
  to: string; // output token symbol
  rate: number; // output per input (to per from)
  depthFrom: number; // max input fillable (sum of resting depth, human units)
  depthTo: number; // resulting output at that depth
  orders: number; // how many resting orders back this route
}
export interface LiveOrdersSnapshot {
  routes: LiveRoute[];
  /** Every token that appears in at least one funded route (tradeable). */
  tokens: string[];
  /** Tokens you can swap FROM (have a route as input). */
  fromTokens: string[];
  totalOrders: number;
  asOf: number;
}

let CACHE: LiveOrdersSnapshot | null = null;
let SCANNING = false;

export function getCachedLiveOrders(): LiveOrdersSnapshot | null {
  if (CACHE && Date.now() - CACHE.asOf < CACHE_TTL_MS) return CACHE;
  return CACHE; // stale is still returned; caller may trigger a refresh
}
export function isScanningOrders(): boolean {
  return SCANNING;
}

export async function scanLiveOrders(): Promise<LiveOrdersSnapshot | null> {
  if (SCANNING) return CACHE;
  SCANNING = true;
  try {
    const db = await getDb();
    if (!db) return CACHE;
    const shops = await db
      .select({ id: users.id, addr: users.walletAddress })
      .from(users)
      .where(and(gte(users.telegramId, String(SEED_TG_MIN)), lte(users.telegramId, String(SEED_TG_MAX))));

    const client = getDexClient();
    // route key → accumulator
    const acc = new Map<string, { from: string; to: string; rateSum: number; n: number; bestRate: number; depthFrom: number; depthTo: number; orders: number }>();
    let totalOrders = 0;

    for (const shop of shops) {
      if (!shop.addr) continue;
      const creds = await getDecryptedDexCreds(shop.id);
      if (!creds) continue;
      let trades: NonNullable<Awaited<ReturnType<typeof client.getOrders>>["trades"]> = [];
      try {
        trades = (await client.getOrders(shop.addr, creds)).trades ?? [];
      } catch {
        continue; // one shop failing shouldn't drop the whole scan
      }
      for (const o of trades) {
        if ((o.status ?? "").toLowerCase() !== "pending") continue;
        const base = o.base_symbol;
        const quote = o.quote_symbol;
        const price = Number(o.price); // quote per base
        const remBase = Number(o.remaining_amount ?? o.amount); // base units remaining
        if (!base || !quote || !(price > 0) || !(remBase > 0)) continue;
        totalOrders++;

        // Derive the taker route this order enables.
        let from: string, to: string, rate: number, depthFrom: number, depthTo: number;
        if ((o.side ?? "").toLowerCase() === "bid") {
          // maker buys base paying quote → taker sells base→quote
          from = base; to = quote; rate = price;
          depthFrom = remBase; depthTo = remBase * price;
        } else {
          // ask: maker sells base for quote → taker buys base with quote (quote→base)
          from = quote; to = base; rate = price > 0 ? 1 / price : 0;
          depthTo = remBase; depthFrom = remBase * price;
        }
        const key = `${from}->${to}`;
        const a = acc.get(key) ?? { from, to, rateSum: 0, n: 0, bestRate: 0, depthFrom: 0, depthTo: 0, orders: 0 };
        a.rateSum += rate; a.n += 1; a.bestRate = Math.max(a.bestRate, rate);
        a.depthFrom += depthFrom; a.depthTo += depthTo; a.orders += 1;
        acc.set(key, a);
      }
    }

    const routes: LiveRoute[] = [...acc.values()]
      .map((a) => ({ from: a.from, to: a.to, rate: a.bestRate, depthFrom: a.depthFrom, depthTo: a.depthTo, orders: a.orders }))
      .sort((x, y) => y.depthTo - x.depthTo);
    const tokens = [...new Set(routes.flatMap((r) => [r.from, r.to]))].sort();
    const fromTokens = [...new Set(routes.map((r) => r.from))].sort();
    CACHE = { routes, tokens, fromTokens, totalOrders, asOf: Date.now() };
    return CACHE;
  } finally {
    SCANNING = false;
  }
}
