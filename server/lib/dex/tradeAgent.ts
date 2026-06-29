/**
 * ─── Trade-on-behalf Agent ────────────────────────────────────────────────────
 *
 * Douglas's actual ask: an AI that finds the edge and TRADES for the user — not
 * just explains. One run:
 *   1. read the user's wallet/vault balances (what they can spend),
 *   2. scan the SEA directions for the best executable edge vs the FX oracle mid
 *      (analysis.ts) where the user HOLDS the input token,
 *   3. execute one bounded take via signAndBroadcastSwap (the user's own managed
 *      wallet — testers aren't seed-shop makers, so STP is safe),
 *   4. record it in agent_trades for the P&L / track record.
 *
 * On-DEMAND (called from a proc), NOT an unattended scheduled loop — we never
 * churn funds without someone asking. Testnet demonstration of a real mechanism:
 * "edge vs oracle" is not realized profit on a static testnet book, so the run
 * result is honestly labeled.
 */
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { users, agentTrades } from "../../../drizzle/schema";
import { getDecryptedDexCreds } from "./apiKey";
import { getDexClient } from "./client";
import { analyzeDirections, tokenMap, SEA_DIRECTIONS } from "./analysis";
import { signAndBroadcastSwap } from "./swapSigner";

export interface AgentCandidate { from: string; to: string; edgeBps: number; holds: number }
export interface AgentRunResult {
  executed: boolean;
  reason?: string;
  trade?: { from: string; to: string; amountIn: number; minOut: string; edgeBps: number; settlementTradeId: string; status: string };
  candidates: AgentCandidate[];
}

export async function runAgentForUser(
  userId: number,
  opts?: { minEdgeBps?: number; maxSize?: number },
): Promise<AgentRunResult> {
  const minEdge = opts?.minEdgeBps ?? 10;     // only take a meaningful edge
  const maxSize = opts?.maxSize ?? 200;        // bounded demo size (input units, stable ≈ USD)
  const db = await getDb();
  if (!db) return { executed: false, reason: "Service unavailable", candidates: [] };

  const u = (await db.select({ addr: users.walletAddress }).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u?.addr) return { executed: false, reason: "Import a wallet first (Me → Wallet) so I can trade for you.", candidates: [] };
  const creds = await getDecryptedDexCreds(userId);
  if (!creds) return { executed: false, reason: "Your the venue key isn't set up — re-import your wallet.", candidates: [] };

  const client = getDexClient();
  let holds: Record<string, number> = {};
  try {
    const bal = await client.getBalances(u.addr.toLowerCase(), creds);
    for (const b of bal.balances) {
      const dec = b.decimals ?? 6;
      holds[b.symbol] = (Number(b.wallet_balance) + Number(b.vault_available)) / 10 ** dec;
    }
  } catch { /* treat as no balances */ }

  const [tokens, edges] = await Promise.all([tokenMap(), analyzeDirections(SEA_DIRECTIONS)]);
  // Deals: cross-fiat, the venue gives MORE than the oracle mid by >= minEdge, and the
  // user actually holds the input token to spend.
  const deals = edges
    .filter((e) => !e.sameFiat && e.edgeBps != null && e.edgeBps >= minEdge && e.settlementRate != null && tokens[e.from] && tokens[e.to])
    .map((e) => ({ e, holdsIn: holds[e.from] ?? 0 }))
    .filter((d) => d.holdsIn > 0)
    .sort((a, b) => (b.e.edgeBps ?? 0) - (a.e.edgeBps ?? 0));

  const candidates: AgentCandidate[] = deals.map((d) => ({ from: d.e.from, to: d.e.to, edgeBps: Math.round(d.e.edgeBps ?? 0), holds: d.holdsIn }));

  if (deals.length === 0) {
    return {
      executed: false,
      reason: `No edge I can take for you right now — I need a >${minEdge} bps edge in a pair where you hold the input token.`,
      candidates,
    };
  }

  const best = deals[0];
  const f = tokens[best.e.from];
  const t = tokens[best.e.to];
  const sizeHuman = Math.min(maxSize, best.holdsIn * 0.5); // never spend more than half the holding
  if (sizeHuman <= 0) return { executed: false, reason: "Not enough balance to trade.", candidates };
  const sizeRaw = BigInt(Math.floor(sizeHuman * 10 ** f.decimals)).toString();

  const res = await signAndBroadcastSwap({
    userId, ownerAddress: u.addr, fromToken: f.address, toToken: t.address, fromAmountRaw: sizeRaw,
  });

  await db.insert(agentTrades).values({
    userId,
    fromToken: best.e.from,
    toToken: best.e.to,
    amountIn: String(sizeHuman),
    minOut: res.ok ? res.minOut : null,
    edgeBps: Math.round(best.e.edgeBps ?? 0),
    settlementTradeId: res.ok ? res.tradeId : null,
    status: res.ok ? res.status : `failed:${res.code}`,
  });

  if (!res.ok) return { executed: false, reason: `Trade didn't go through (${res.code}): ${res.detail}`, candidates };
  return {
    executed: true,
    trade: { from: best.e.from, to: best.e.to, amountIn: sizeHuman, minOut: res.minOut, edgeBps: Math.round(best.e.edgeBps ?? 0), settlementTradeId: res.tradeId, status: res.status },
    candidates,
  };
}
