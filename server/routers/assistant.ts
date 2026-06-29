/**
 * ─── Assistant DEX Router ────────────────────────────────────────────────────────
 *
 * In-app AI assistant. tRPC procedures:
 *
 *   assistant.providerStatus  — which LLM is configured + reachable
 *   assistant.chat            — single-turn chat (messages[] + ctx → reply)
 *
 * No API keys in the browser. Server-side relay holds keys. Context is
 * built server-side from live the venue + DB state so prompts are grounded.
 *
 * Per the locked architecture: this is education + state grounding, NOT
 * a trading signal or "buy now" recommender.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedProcedure, router } from "../_core/trpc";
import { callLlm, type ChatMessage } from "../lib/assistant/relay";
import {
  buildSystemPrompt,
  pickProvider,
  type AssistantContext,
} from "../lib/assistant/pure";
import { getDexClient } from "../lib/dex/client";
import { getDecryptedDexCreds } from "../lib/dex/apiKey";
import { analyzeDirections, SEA_DIRECTIONS } from "../lib/dex/analysis";
import { getDb } from "../db";
import { users, changerProfiles, p2pAds, agentTrades } from "../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";

export const assistantRouter = router({
  /**
   * Which LLM provider is configured + reachable. Used by the UI to
   * surface a status badge and skip-chat affordance.
   */
  providerStatus: protectedProcedure.query(() => {
    const provider = pickProvider({
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    });
    return {
      provider,
      ready: provider !== null,
      // Avoid leaking which providers are configured beyond the selected one
    };
  }),

  /**
   * Single-turn chat. Client supplies the message history. Server adds
   * the the venue FX system prompt + live context block (vault state, market
   * data, optional shop context) and dispatches to the configured LLM.
   */
  chat: protectedProcedure
    .input(
      z.object({
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().min(1).max(8000),
            }),
          )
          .min(1)
          .max(40),
        // Optional shop context (when the user is chatting from inside a shop)
        shopChangerId: z.number().int().positive().optional(),
        // Optional knob — caller can override default token budget
        maxTokens: z.number().int().min(50).max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const provider = pickProvider({
        LLM_PROVIDER: process.env.LLM_PROVIDER,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      });
      if (!provider) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "No LLM API key configured (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)",
        });
      }

      // Build context grounded in live the venue + user state
      const assistantCtx = await buildAssistantContext(ctx.user.id, input.shopChangerId);

      const systemPrompt = buildSystemPrompt(assistantCtx);
      const messages: ChatMessage[] = input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      try {
        const reply = await callLlm({
          provider,
          messages,
          system: systemPrompt,
          maxTokens: input.maxTokens,
        });
        return { reply, provider };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `LLM call failed: ${msg}`,
        });
      }
    }),

  /**
   * runTrade — the trade-on-behalf agent (Douglas's ask). Scans the SEA edges,
   * and if the user holds the input token for a profitable one, takes it with
   * their own managed wallet and records it. On-demand only (no auto-loop).
   */
  runTrade: protectedProcedure
    .input(
      z
        .object({
          minEdgeBps: z.number().int().min(0).max(2000).optional(),
          maxSize: z.number().positive().max(5000).optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const { runAgentForUser } = await import("../lib/dex/tradeAgent");
      return runAgentForUser(ctx.user.id, { minEdgeBps: input?.minEdgeBps, maxSize: input?.maxSize });
    }),

  /** tradeHistory — the agent's trades for this user (P&L / track record). */
  tradeHistory: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { trades: [] };
    const rows = await db
      .select()
      .from(agentTrades)
      .where(eq(agentTrades.userId, ctx.user.id))
      .orderBy(desc(agentTrades.createdAt))
      .limit(50);
    return { trades: rows };
  }),
});

// ─── Context builder ────────────────────────────────────────────────────────

async function buildAssistantContext(
  userId: number,
  shopChangerId?: number,
): Promise<AssistantContext | null> {
  const client = getDexClient();
  const ctx: AssistantContext = {};

  // Supported tokens (always available, no auth).
  try {
    const tokensRes = await client.getTokens();
    ctx.supportedTokens = (tokensRes.tokens ?? []).slice(0, 30).map((t) => ({
      symbol: t.symbol,
      currency: t.currency,
    }));
  } catch { /* the venue unreachable — skip */ }

  // Computed edge per direction (the venue executable rate vs FX oracle mid) — lets
  // the assistant answer "best rate / good time / is this a deal" with real numbers.
  try {
    const edges = await analyzeDirections(SEA_DIRECTIONS);
    ctx.marketEdges = edges
      .filter((e) => e.settlementRate != null)
      .map((e) => ({
        from: e.from, to: e.to, settlementRate: e.settlementRate, oracleMid: e.oracleMid,
        edgeBps: e.edgeBps != null ? Math.round(e.edgeBps) : null,
        change24hPct: e.change24hPct, depeg: e.depeg, note: e.note,
      }));
  } catch { /* skip */ }

  // Live mid for the SEA corridors the app focuses on.
  try {
    const pairs: Array<[string, string]> = [["USD", "SGD"], ["USD", "MYR"], ["SGD", "MYR"], ["USD", "IDR"]];
    const rates = await Promise.all(
      pairs.map(async ([b, q]) => {
        const r = await client.getFxRate(b, q);
        return r ? { base: b, quote: q, rate: Number(r.rate), as_of: r.as_of } : null;
      }),
    );
    ctx.liveMid = rates.filter(Boolean) as NonNullable<AssistantContext["liveMid"]>;
  } catch { /* skip */ }

  // The user's own vault + wallet balances (grounds "how is my position").
  try {
    const db = await getDb();
    if (db) {
      const u = (await db.select({ addr: users.walletAddress }).from(users).where(eq(users.id, userId)).limit(1))[0];
      if (u?.addr) {
        ctx.userAddress = u.addr;
        const creds = await getDecryptedDexCreds(userId);
        if (creds) {
          const bal = await client.getBalances(u.addr.toLowerCase(), creds);
          const nonZero = bal.balances.filter(
            (b) => b.vault_available !== "0" || b.vault_frozen !== "0" || b.wallet_balance !== "0",
          );
          ctx.vaultBalances = nonZero.map((b) => ({
            symbol: b.symbol,
            vault_available: b.vault_available,
            vault_frozen: b.vault_frozen,
            wallet: b.wallet_balance,
          }));
        }
      }
    }
  } catch { /* skip */ }

  // Shop context when chatting from inside a specific shop.
  if (shopChangerId) {
    try {
      const db = await getDb();
      if (db) {
        const c = (await db.select().from(changerProfiles).where(eq(changerProfiles.id, shopChangerId)).limit(1))[0];
        if (c) {
          const offers = await db
            .select({ fromToken: p2pAds.fromToken, toToken: p2pAds.toToken, rate: p2pAds.rate, liquidityRemaining: p2pAds.liquidityRemaining })
            .from(p2pAds)
            .where(and(eq(p2pAds.changerId, shopChangerId), eq(p2pAds.status, "active")));
          ctx.shopChanger = {
            displayName: c.displayName,
            bio: c.bio ?? undefined,
            activeOffers: offers.map((o) => ({
              fromToken: o.fromToken,
              toToken: o.toToken,
              rate: Number(o.rate),
              liquidityRemaining: o.liquidityRemaining,
            })),
          };
        }
      }
    } catch { /* skip */ }
  }

  return Object.keys(ctx).length > 0 ? ctx : null;
}
