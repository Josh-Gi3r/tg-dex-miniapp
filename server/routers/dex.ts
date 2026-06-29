/**
 * ─── the venue DEX Router ─────────────────────────────────────────────────────────────
 *
 * Server-side glue for settlement venue API flows that the client orchestrates:
 *   - bootstrap: returns the cached /config (chain ID, contracts, EIP-712
 *     domain) so the client can build typed-data signatures
 *   - apiKey.prepare: returns the unsigned ManageApiKey typed data for Phase 3
 *   - apiKey.complete: server posts both signatures to /api-keys, encrypts
 *     and stores the returned secret
 *   - balances: returns the user's wallet + vault balances from /balances
 *
 * The actual signing happens client-side via Privy. The server never sees
 * a private key.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDexClient, DexApiError } from "../lib/dex/client";
import { getDecryptedDexCreds, hasDexCreds, storeDexCreds, withDexReauth } from "../lib/dex/apiKey";
import { signAndBroadcastTransfer, signAndBroadcastWithdraw } from "../lib/dex/walletSigner";
import { assertRateLimit } from "../lib/production";
import { signAndBroadcastSwap } from "../lib/dex/swapSigner";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users, p2pAds } from "../../drizzle/schema";
import { and as dand, eq as deq, isNotNull, gte as dgte, desc as ddesc } from "drizzle-orm";
import { rateHistory } from "../../drizzle/schema";
import { ENV } from "../_core/env";

export const dexRouter = router({
  /**
   * Returns the live server timestamp from GET /system/time. Use this
   * to derive `expiration` and `deadline` fields on signed payloads —
   * Telegram WebView devices have skewed clocks and the spec validates
   * deadlines against server time, not the local clock.
   */
  serverTime: publicProcedure.query(async () => {
    return { timestamp: await getDexClient().getServerTime() };
  }),

  /**
   * Returns the list of trading markets registered with the venue. Each market
   * specifies the canonical base/quote ordering plus tick/quantity
   * precision — needed by the order-placement flow to compute the
   * `side`, `amount`, and `price` fields the API expects.
   */
  markets: publicProcedure.query(async () => {
    const client = getDexClient();
    try {
      const r = await client.getMarkets();
      return { markets: r.markets, source: "live" as const };
    } catch (err) {
      return {
        markets: [],
        source: "fallback" as const,
        error: String(err),
      };
    }
  }),

  /**
   * Returns the list of tokens registered with the venue (symbol, address,
   * decimals, currency). Public — caller doesn't need API credentials.
   * Used by the client to resolve UI symbols → contract addresses.
   */
  tokens: publicProcedure.query(async () => {
    const client = getDexClient();
    try {
      const r = await client.getTokens();
      return { tokens: r.tokens, source: "live" as const };
    } catch (err) {
      // 403 (host allowlist) or transport error — fall back to local list
      const fallback = (await import("@shared/venue-config")).SUPPORTED_TOKENS;
      return {
        tokens: Object.values(fallback).map((t) => ({
          currency: t.currency,
          symbol: t.symbol,
          address: t.address,
          decimals: t.decimals,
          min_trade_amount_raw: "1",
          min_trade_amount: "0.000001",
        })),
        source: "fallback" as const,
        error: String(err),
      };
    }
  }),

  /**
   * Returns the on-chain config (chain id, contract addresses, EIP-712
   * domain) the client needs to build signed typed data. Public endpoint —
   * cached process-wide so this is essentially free.
   */
  bootstrap: publicProcedure.query(async () => {
    const client = getDexClient();
    try {
      const { health, config } = await client.bootstrap();
      return {
        ok: true as const,
        chainId: config.chain_id,
        venueAddress: config.venue_address,
        vaultAddress: config.vault_address,
        sorAddress: config.sor_address,
        domain: config.eip712_domain,
        executorId: health.executor_id,
        signatureReady: health.signature_ready,
        treasuryWallet: ENV.appTreasuryWallet || null,
      };
    } catch (err) {
      // Demo / dev-mode fallback: when the venue isn't reachable (e.g. running
      // locally without internet, or behind a sandbox egress filter),
      // surface a graceful sentinel instead of 500-ing every consumer.
      // Live-mode orchestrators check `ok` and refuse to proceed; demo
      // flows ignore the bootstrap entirely.
      console.warn("[dex.bootstrap] unreachable, falling back:", err);
      return {
        ok: false as const,
        chainId: 11155111,
        venueAddress: "0x0000000000000000000000000000000000000000",
        vaultAddress: "0x0000000000000000000000000000000000000000",
        sorAddress: "0x0000000000000000000000000000000000000000",
        domain: {
          name: "DEX App",
          version: "1",
          chainId: 11155111,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        executorId: 0,
        signatureReady: false,
        treasuryWallet: ENV.appTreasuryWallet || null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }),

  /**
   * Step 1 of the api-key dance: returns the EIP-712 typed-data payload the
   * client signs via Privy. Per the venue spec, the signed message is
   *   ManageApiKey { owner: address, action: string, timestamp: uint256 }
   * and `action` must be `"create"` — list/revoke are separate procedures.
   *
   * The signed timestamp must be within 5 minutes of server time, so we
   * derive it from GET /system/time rather than the local clock.
   */
  apiKeyPrepare: protectedProcedure
    .input(z.object({ action: z.literal("create") }))
    .mutation(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      if (!wallet) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Wallet not yet linked to user",
        });
      }
      const config = await getDexClient().getConfig();
      const timestamp = await getDexClient().getServerTime();
      return {
        domain: config.eip712_domain,
        message: {
          owner: wallet,
          action: input.action,
          timestamp: String(timestamp),
        },
      };
    }),

  /**
   * Step 2 of the api-key dance: takes the user signature, calls the venue's
   * POST /api-keys, encrypts and persists the returned secret.
   *
   * Per the venue spec, the request body is:
   *   { owner_address, action, timestamp, signature, label? }
   * The signed timestamp must be within 5 minutes of server time, and a
   * wallet may hold up to 10 active API keys. api_secret is returned only
   * once — we encrypt + store it immediately.
   */
  apiKeyComplete: protectedProcedure
    .input(
      z.object({
        action: z.literal("create"),
        timestamp: z.string(),
        signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
        label: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      if (!wallet) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Wallet not linked",
        });
      }
      const client = getDexClient();
      try {
        const res = await fetch(`${client.base}/api-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_address: wallet,
            action: input.action,
            timestamp: input.timestamp,
            signature: input.signature,
            label: input.label ?? "DEX Mini App",
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `venue /api-keys ${res.status}: ${text}`,
          });
        }
        const body = (await res.json()) as { api_key: string; api_secret: string };
        await storeDexCreds({
          userId: ctx.user.id,
          apiKey: body.api_key,
          apiSecret: body.api_secret,
        });
        return { success: true, apiKey: body.api_key };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to provision Venue API key: ${err}`,
        });
      }
    }),

  /**
   * Self-revoke the user's currently stored API key. Uses the
   * POST /api-keys/self-revoke endpoint which authenticates with the
   * bearer credentials being revoked — no wallet signature needed.
   */
  apiKeyRevoke: protectedProcedure.mutation(async ({ ctx }) => {
    const creds = await getDecryptedDexCreds(ctx.user.id);
    if (!creds) return { success: true, alreadyRevoked: true };
    const client = getDexClient();
    const res = await fetch(`${client.base}/api-keys/self-revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
      },
      body: JSON.stringify({ api_key: creds.apiKey }),
    });
    if (!res.ok && res.status !== 401) {
      // 401 means the key was already revoked — treat as success
      const text = await res.text();
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `venue /api-keys/self-revoke ${res.status}: ${text}`,
      });
    }
    const drizzle = await getDb();
    if (drizzle) {
      await drizzle
        .update(users)
        .set({ dexApiKey: null, dexApiSecret: null })
        .where(eq(users.id, ctx.user.id));
    }
    return { success: true, alreadyRevoked: false };
  }),

  /** Returns whether the user has venue credentials provisioned. */
  hasApiKey: protectedProcedure.query(async ({ ctx }) => {
    return hasDexCreds(ctx.user.id);
  }),

  /**
   * Step 1 of Take-an-Offer: get a swap quote from the venue.
   * Returns the quote payload plus the EIP-712 Intent (and Permit metadata
   * if applicable) that the client must sign before /swap.execute.
   */
  swapQuote: protectedProcedure
    .input(
      z
        .object({
          fromToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          toToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          fromAmount: z.string(), // raw uint256 as decimal
          recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
          gasMode: z.enum(["receive_less", "pay_more"]).default("receive_less"),
        })
        // Spec: from_token and to_token must differ.
        .refine(
          (v) => v.fromToken.toLowerCase() !== v.toToken.toLowerCase(),
          { message: "from_token and to_token must differ" },
        ),
    )
    .mutation(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      if (!wallet) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Wallet not linked",
        });
      }
      // /swap/quote is documented as Authentication: None. We deliberately
      // do NOT attach a bearer here — if the user's stored API key was
      // revoked out-of-band on the venue's dashboard, sending a stale bearer
      // could cause the venue to 401 a request that should have succeeded.
      const client = getDexClient();
      const config = await client.getConfig();
      const serverTime = await client.getServerTime();
      const expiration = serverTime + 600;
      const recipient = input.recipient ?? wallet;

      const res = await fetch(`${client.base}/swap/quote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from_token: input.fromToken,
          to_token: input.toToken,
          from_amount: input.fromAmount,
          owner_address: wallet,
          recipient,
          expiration,
          gas_mode: input.gasMode,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /swap/quote ${res.status}: ${text}`,
        });
      }
      // Spec response shape — see the Swap Endpoints docs for the full schema.
      // The `permit` block is non-null on every wallet-deposit swap; only
      // equity-only swaps (initialDepositAmount = 0) leave it null.
      const quote = (await res.json()) as {
        uuid: string; // Quote ID — pass back to /swap as `uuid`
        route_params: {
          taker: string;
          inputToken: string;
          outputToken: string;
          maxInputAmount: string;
          minOutputAmount: string;
          recipient: string;
          initialDepositAmount: string;
          uuid: string; // Composite uuid_int for the signed Intent
          deadline: number;
        };
        fee_breakdown?: { gas_cost_usd: string; gas_cost_from_token: string };
        expires_at: number;
        permit: {
          permit_supported: boolean;
          permit_required: boolean;
          token: string;
          spender: string;
          owner: string;
          value_raw: string;
          current_allowance_raw: string;
          nonce: number;
          suggested_deadline: number;
          domain: { name: string; version: string; chainId: number; verifyingContract: string };
          eip712: {
            domain: { name: string; version: string; chainId: number; verifyingContract: string };
            primaryType: "Permit";
            types: Record<string, Array<{ name: string; type: string }>>;
            message: Record<string, unknown>;
          };
        } | null;
      };
      return {
        quoteUuid: quote.uuid,
        routeParams: quote.route_params,
        feeBreakdown: quote.fee_breakdown ?? null,
        expiresAt: quote.expires_at,
        // Pass the permit block through verbatim — when non-null the
        // `eip712` field is shaped exactly as signTypedData expects.
        permit: quote.permit,
        domain: config.eip712_domain,
      };
    }),

  /**
   * Step 2 of Take-an-Offer: submit the signed Intent (+ Permit) to /swap.
   * Returns the the venue trade_id and tx_hash (when available immediately).
   *
   * Documented error codes (spec error_code allowlist) get user-friendly
   * remappings; status 410 (Quote expired) and 503 (Retry-After) are
   * special-cased before the envelope parse.
   */
  swapExecute: protectedProcedure
    .input(
      z.object({
        // The QUOTE id (top-level `uuid` in the /swap/quote response — NOT
        // the composite `route_params.uuid`). the venue looks up the stored
        // quote by this ID and matches against the signed Intent.
        quoteUuid: z.string().uuid(),
        signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
        // Required when the quote's `permit` block was non-null.
        permitSignature: z.string().regex(/^0x[a-fA-F0-9]+$/).optional(),
        permitDeadline: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Spec: /swap auth is EIP-712 only. Bearer not required and not
      // forwarded — stale credentials must never block a swap submission.
      void ctx;
      const client = getDexClient();
      const res = await fetch(`${client.base}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uuid: input.quoteUuid,
          signature: input.signature,
          permit_signature: input.permitSignature,
          permit_deadline: input.permitDeadline,
        }),
      });
      if (!res.ok) {
        // Special-case status codes the spec calls out explicitly.
        if (res.status === 410) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Quote expired or already consumed — please retry",
          });
        }
        if (res.status === 503) {
          const retryAfter = res.headers.get("retry-after") ?? "30";
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Venue is busy — try again in ${retryAfter}s`,
          });
        }
        const text = await res.text();
        let detail = text;
        let errorCode: string | undefined;
        try {
          const parsed = JSON.parse(text) as { detail?: { detail?: string; error_code?: string } | string };
          if (typeof parsed.detail === "object" && parsed.detail) {
            detail = parsed.detail.detail ?? text;
            errorCode = parsed.detail.error_code;
          } else if (typeof parsed.detail === "string") {
            detail = parsed.detail;
          }
        } catch {
          // not JSON
        }
        // Spec error_code allowlist (Swap Endpoints → "Error Envelope" table)
        const friendly: Record<string, string> = {
          ALLOWANCE_INSUFFICIENT: "Approve / re-permit the input token, then retry",
          INTENT_DEADLINE_EXPIRED: "Your signed deadline expired — request a fresh quote",
          SLIPPAGE_EXCEEDED: "No crossing liquidity at the signed price — widen slippage and retry",
          NO_LIQUIDITY: "No executable depth on this route — reduce size or try another pair",
          QUOTE_STALE: "Quote went stale — please retry",
          AMOUNT_BELOW_MIN: "Amount below the pair's configured minimum",
          STP_BLOCKED: "Can't trade with yourself — cancel the resting order or revise the side",
          TRANSIENT_SETTLEMENT_FAILURE: "Settlement is retrying — give it a moment",
        };
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: friendly[errorCode ?? ""] ?? detail,
        });
      }
      // Spec: { success, trade_id, status, fee_breakdown? }. tx_hash is
      // NOT returned inline — the swap settles asynchronously and the hash
      // surfaces via GET /orders/{trade_id}.settlement_summary.latest_tx_hash.
      const body = (await res.json()) as {
        success: boolean;
        trade_id: string;
        status: string;
        fee_breakdown?: { gas_cost_usd: string; gas_cost_from_token: string };
      };
      return {
        tradeId: body.trade_id,
        status: body.status,
        feeBreakdown: body.fee_breakdown ?? null,
      };
    }),

  /**
   * Polls the order status — used after /swap to track settle/fail and
   * surface the eventual tx hash. The full /orders/{id} response is rich;
   * we expose the fields the UI actually consumes.
   */
  orderStatus: protectedProcedure
    .input(z.object({ tradeId: z.string() }))
    .query(async ({ ctx, input }) => {
      const creds = await getDecryptedDexCreds(ctx.user.id);
      if (!creds) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Venue API key not provisioned",
        });
      }
      const client = getDexClient();
      const res = await fetch(
        `${client.base}/orders/${encodeURIComponent(input.tradeId)}`,
        {
          headers: {
            Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
            Accept: "application/json",
          },
        },
      );
      if (!res.ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `venue /orders/${input.tradeId} ${res.status}`,
        });
      }
      // The full GET /orders/{id} response is large — we surface the fields
      // the TG UI consumes. settlement_summary.latest_tx_hash is the
      // canonical hash for "view on Etherscan" links.
      const body = (await res.json()) as {
        trade_id: string;
        owner_address: string;
        status: "pending" | "matched" | "settled" | "failed" | "cancelled";
        order_type: "limit" | "swap";
        symbol?: string;
        side?: "bid" | "ask";
        amount: string;
        remaining_amount?: string;
        filled_base_amount?: string;
        filled_quote_amount?: string;
        from_amount: string;
        to_amount: string;
        from_token: string;
        to_token: string;
        error?: string | null;
        error_code?: string | null;
        uuid_int?: string;
        settlement_summary?: {
          status: string;
          latest_tx_hash: string | null;
        };
      };
      return {
        tradeId: body.trade_id,
        status: body.status,
        side: body.side,
        amount: body.amount,
        remainingAmount: body.remaining_amount ?? null,
        filledBaseAmount: body.filled_base_amount ?? null,
        fromAmount: body.from_amount,
        toAmount: body.to_amount,
        errorCode: body.error_code ?? null,
        error: body.error ?? null,
        txHash: body.settlement_summary?.latest_tx_hash ?? null,
        settlementStatus: body.settlement_summary?.status ?? null,
      };
    }),

  /**
   * Returns the permit metadata for a token (used during deposit and swap
   * flows to know whether to sign a Permit or run a separate approve tx).
   */
  permitMetadata: protectedProcedure
    .input(
      z.object({
        token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        // Spender defaults to the live vault_address from /config (the
        // typical target for deposits). Pass sor_address explicitly when
        // pre-signing for a swap path.
        spender: z.enum(["vault", "sor"]).default("vault"),
        // Optional raw amount to compare against the current allowance
        // (populates the `required` boolean in the response).
        amount: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      const creds = await getDecryptedDexCreds(ctx.user.id);
      if (!wallet || !creds) return { permitSupported: false } as const;
      const client = getDexClient();
      const config = await client.getConfig();
      const spenderAddress =
        input.spender === "vault" ? config.vault_address : config.sor_address;
      const params = new URLSearchParams({
        token: input.token,
        owner: wallet,
        spender: spenderAddress,
      });
      if (input.amount) params.set("amount", input.amount);
      const res = await fetch(
        `${client.base}/permit/metadata?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
            Accept: "application/json",
          },
        },
      );
      if (!res.ok) return { permitSupported: false } as const;
      // Spec response shape (supported tokens only carry domain/nonce).
      const body = (await res.json()) as {
        token: string;
        owner: string;
        spender: string;
        current_allowance_raw: string;
        required?: boolean;
        permit_supported: boolean;
        nonce?: number;
        domain?: {
          name: string;
          version: string;
          chainId: number;
          verifyingContract: string;
        };
      };
      return {
        permitSupported: body.permit_supported,
        required: body.required ?? null,
        currentAllowanceRaw: body.current_allowance_raw,
        nonce: body.nonce !== undefined ? String(body.nonce) : null,
        domain: body.domain ?? null,
        spender: body.spender,
      };
    }),

  /**
   * Phase 5 — deposit liquidity into the the venue Vault.
   * Returns an unsigned tx for /deposit/build that the client signs and
   * broadcasts via /tx/send.
   */
  depositBuild: protectedProcedure
    .input(
      z.object({
        token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        amount: z.string(),
        // Spec: when permit fields are present the builder targets
        // depositFundWithPermit; otherwise depositFund.
        permitSignature: z.string().regex(/^0x[a-fA-F0-9]+$/).optional(),
        permitDeadline: z.number().int().optional(),
        permitAmount: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      const creds = await getDecryptedDexCreds(ctx.user.id);
      if (!wallet || !creds) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Auth incomplete" });
      }
      const client = getDexClient();
      const res = await fetch(`${client.base}/deposit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
        },
        body: JSON.stringify({
          token: input.token,
          owner: wallet,
          amount: input.amount,
          permit_signature: input.permitSignature,
          permit_deadline: input.permitDeadline,
          permit_amount: input.permitAmount,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /deposit ${res.status}: ${text}`,
        });
      }
      return (await res.json()) as { tx: unknown };
    }),

  /**
   * Phase 5 — build an ERC-20 approve() tx for tokens that don't support
   * EIP-2612 permit. Spender must be the live Vault or SOR address from
   * /config; the spec rejects any other target.
   */
  approveBuild: protectedProcedure
    .input(
      z.object({
        token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        amount: z.string(),
        // 'vault' for deposit prep, 'sor' for swap prep on permit-unsupported
        // tokens. Resolved server-side from /config.
        spender: z.enum(["vault", "sor"]).default("vault"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      const creds = await getDecryptedDexCreds(ctx.user.id);
      if (!wallet || !creds) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Auth incomplete" });
      }
      const client = getDexClient();
      const config = await client.getConfig();
      const spenderAddress =
        input.spender === "vault" ? config.vault_address : config.sor_address;
      const res = await fetch(`${client.base}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
        },
        body: JSON.stringify({
          token: input.token,
          owner: wallet,
          spender: spenderAddress,
          amount: input.amount,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /approve ${res.status}: ${text}`,
        });
      }
      return (await res.json()) as { tx: unknown };
    }),

  /**
   * Broadcasts a signed approve / deposit / transfer tx via /tx/send.
   * Per the spec, /tx/send only accepts signed approve/deposit calls
   * matching an allowed selector→target pairing — withdraw broadcasts
   * use the dedicated /withdraw/send endpoint.
   */
  txSend: protectedProcedure
    .input(
      z.object({
        rawTx: z.string().regex(/^0x[a-fA-F0-9]+$/),
        kind: z.enum(["tx", "transfer", "withdraw"]).default("tx"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Per the spec:
      //   /tx/send       → API Key required (approve/deposit broadcasts)
      //   /transfer/send → API Key required
      //   /withdraw/send → Optional API Key
      const creds = await getDecryptedDexCreds(ctx.user.id);
      if (!creds && input.kind !== "withdraw") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "API key required to broadcast — provision via dex.apiKeyComplete first",
        });
      }
      const client = getDexClient();
      const path =
        input.kind === "withdraw"
          ? "/withdraw/send"
          : input.kind === "transfer"
            ? "/transfer/send"
            : "/tx/send";
      const res = await fetch(`${client.base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(creds ? { Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}` } : {}),
        },
        body: JSON.stringify({ raw_tx: input.rawTx }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `the venue ${path} ${res.status}: ${text}`,
        });
      }
      return (await res.json()) as { tx_hash: string };
    }),

  /**
   * Phase 5 — submit a signed limit order to the the venue book.
   * Returns the order_id and packed uuid_int so callers can later cancel.
   */
  ordersSubmit: protectedProcedure
    .input(
      z.object({
        orderId: z.string().uuid(),
        uuidInt: z.string(),
        fromAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        side: z.enum(["bid", "ask"]),
        amount: z.string(),
        price: z.string(),
        owner: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        expiration: z.number().int(),
        signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Per the API Overview: POST /orders is "EIP-712" auth — the API
      // key is OPTIONAL (used only for per-wallet rate-limit attribution).
      // We attach it when present so the user gets their own bucket;
      // without it the request still succeeds, falling back to edge
      // IP-based throttling.
      // Spec: /orders auth is EIP-712 only. Bearer not forwarded — stale
      // credentials must never block an order submission.
      void ctx;
      const client = getDexClient();
      // Per the spec: client_id and fee_bps are NOT accepted by the live
      // public API. order_type is required and must be "limit".
      const res = await fetch(`${client.base}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_address: input.owner,
          side: input.side,
          amount: input.amount,
          price: input.price,
          order_type: "limit",
          from_address: input.fromAddress,
          to_address: input.toAddress,
          order_id: input.orderId,
          uuid_int: input.uuidInt,
          signature: input.signature,
          expiration: input.expiration,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /orders ${res.status}: ${text}`,
        });
      }
      // Spec: response is just `{ order_id }`. The orchestrator already
      // knows the uuid_int it sent, and the initial status is "pending"
      // until the matching engine acts.
      const body = (await res.json()) as { order_id: string };
      return {
        orderId: body.order_id,
        uuidInt: input.uuidInt,
        status: "pending",
      };
    }),

  /**
   * Phase 5 — cancel a previously placed limit order. Client signs the
   * CancelOrder typed data; server posts to /orders/cancel.
   *
   * the venue enforces a 5-minute minimum lifetime; callers should surface
   * "Order placed less than 5 minutes ago — try again shortly" on 429.
   */
  ordersCancel: protectedProcedure
    .input(
      z.object({
        owner: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        // The human-readable UUID4 — required even though the signed
        // CancelOrder.orderId is the composite uuid_int.
        orderId: z.string().uuid(),
        uuidInt: z.string(),
        signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Spec: /orders/cancel auth is EIP-712 CancelOrder signature.
      // Bearer not forwarded — stale credentials must never block a cancel.
      void ctx;
      const client = getDexClient();
      const res = await fetch(`${client.base}/orders/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_address: input.owner,
          order_id: input.orderId,
          uuid_int: input.uuidInt,
          signature: input.signature,
        }),
      });
      if (res.status === 429) {
        // the venue includes Retry-After when known; use it for an actionable
        // countdown in the UI. Fall back to 300s (the documented 5-min
        // cooldown) when the header is absent.
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfterSec = (() => {
          if (!retryAfterRaw) return 300;
          const n = Number(retryAfterRaw);
          if (Number.isFinite(n) && n > 0) return Math.min(n, 600);
          // Could be an HTTP-date — parse and diff to now
          const date = Date.parse(retryAfterRaw);
          if (Number.isFinite(date)) {
            return Math.max(1, Math.ceil((date - Date.now()) / 1000));
          }
          return 300;
        })();
        const mins = Math.ceil(retryAfterSec / 60);
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Order is in its 5-minute cancel cooldown — try again in ~${mins} min`,
          // tRPC's `cause` field carries through to the client error;
          // UI can read it for a precise countdown.
          cause: { retryAfterSec },
        });
      }
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /orders/cancel ${res.status}: ${text}`,
        });
      }
      // Spec: response is `{ status: "ok" }`.
      return (await res.json()) as { status: string };
    }),

  /**
   * Phase 8 — withdraw step 1: client signs WithdrawIntent → server submits
   * to /withdraw which co-signs with the executor key and returns a build
   * receipt. Server returns the executor signature + uuid so the client can
   * proceed to /withdraw/build.
   */
  withdrawIntent: protectedProcedure
    .input(
      z.object({
        tokens: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).min(1),
        amounts: z.array(z.string()).min(1),
        recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        deadline: z.string(),
        uuid: z.string(),
        userSignature: z.string().regex(/^0x[a-fA-F0-9]+$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.tokens.length !== input.amounts.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "tokens[] and amounts[] must be equal-length",
        });
      }
      const wallet = ctx.user.walletAddress;
      if (!wallet) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Wallet not linked" });
      }
      // Spec: /withdraw is EIP-712 + Optional API Key. Bearer not forwarded
      // so stale credentials can't 401 a withdraw the user actually wants
      // to make. The user_signature alone authorizes.
      const client = getDexClient();
      const res = await fetch(`${client.base}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: {
            user: wallet,
            tokens: input.tokens,
            amounts: input.amounts,
            recipient: input.recipient,
            deadline: input.deadline,
            uuid: input.uuid,
          },
          user_signature: input.userSignature,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /withdraw ${res.status}: ${text}`,
        });
      }
      // Spec: { success, executor_address, executor_signature, error }
      const body = (await res.json()) as {
        success: boolean;
        executor_address: string;
        executor_signature: string;
        error: string | null;
      };
      return {
        executor: body.executor_address,
        executorSignature: body.executor_signature,
      };
    }),

  /**
   * Phase 8 — withdraw step 2: build the unsigned withdraw tx with both
   * signatures attached. Client then signs and broadcasts via /tx/send.
   */
  withdrawBuild: protectedProcedure
    .input(
      z.object({
        tokens: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).min(1),
        amounts: z.array(z.string()).min(1),
        recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        deadline: z.string(),
        uuid: z.string(),
        userSignature: z.string().regex(/^0x[a-fA-F0-9]+$/),
        executor: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        executorSignature: z.string().regex(/^0x[a-fA-F0-9]+$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      if (!wallet) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Wallet not linked" });
      }
      // Spec: /withdraw/build is Optional API Key. Bearer not forwarded —
      // stale credentials can't break the build step. Both signatures in
      // the body are what authorize this call.
      const client = getDexClient();
      const res = await fetch(`${client.base}/withdraw/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: {
            user: wallet,
            tokens: input.tokens,
            amounts: input.amounts,
            recipient: input.recipient,
            deadline: input.deadline,
            uuid: input.uuid,
          },
          user_signature: input.userSignature,
          executor: input.executor,
          executor_signature: input.executorSignature,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /withdraw/build ${res.status}: ${text}`,
        });
      }
      return (await res.json()) as { tx: unknown };
    }),

  /**
   * Phase 6 — build an unsigned transfer tx for same-token sends. Caller
   * (Send tab orchestrator, or fiat-leg confirmReceived flow) signs and
   * broadcasts via /dex/txSend.
   */
  /**
   * Phase 6 — build an ERC-20 transfer tx (wallet → recipient). The spec
   * supports wallet-source transfers only via this endpoint; vault
   * movements go through the dual-sig /withdraw flow instead.
   */
  transferBuild: protectedProcedure
    .input(
      z.object({
        token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        amount: z.string(),
        to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const wallet = ctx.user.walletAddress;
      const creds = await getDecryptedDexCreds(ctx.user.id);
      if (!wallet || !creds) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Auth incomplete" });
      }
      const client = getDexClient();
      const res = await fetch(`${client.base}/transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
        },
        body: JSON.stringify({
          token: input.token,
          to: input.to,
          amount: input.amount,
          from_address: wallet,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `venue /transfer ${res.status}: ${text}`,
        });
      }
      return (await res.json()) as { tx: unknown };
    }),

  /**
   * Returns wallet + vault balances from /balances. Requires provisioned
   * API credentials. Returns {balances: []} when the user hasn't linked
   * the venue yet, so the UI can render an empty state instead of an error.
   */
  balances: protectedProcedure.query(async ({ ctx }) => {
    const wallet = ctx.user.walletAddress;
    if (!wallet) return { balances: [], linked: false };

    const client = getDexClient();
    try {
      // withDexReauth self-heals a rotated/wiped testnet key: a 401 here triggers
      // a one-time re-provision with the stored wallet + retry, so balances don't
      // silently vanish when the venue resets keys (otherwise looks like "app broke").
      const data = await withDexReauth(ctx.user.id, async (creds) => {
        // Spec: GET /balances?owner_address=0x...
        const res = await fetch(
          `${client.base}/balances?owner_address=${encodeURIComponent(wallet)}`,
          {
            headers: {
              Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}`,
              Accept: "application/json",
            },
          },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new DexApiError(res.status, text);
        }
        return (await res.json()) as {
          owner_address: string;
          balances: unknown[];
          updated_at?: string;
          wallet_balance_available?: boolean;
        };
      });
      return {
        balances: data.balances ?? [],
        linked: true,
        updatedAt: data.updated_at,
        walletBalanceAvailable: data.wallet_balance_available ?? true,
      };
    } catch (err) {
      // No creds AND no provisionable wallet → genuinely unlinked.
      if (err instanceof Error && err.message.includes("not provisioned")) {
        return { balances: [], linked: false };
      }
      console.warn(`[dex.balances] user ${ctx.user.id}:`, err);
      return { balances: [], linked: true, error: String(err) };
    }
  }),

  /**
   * liveBoard — the money-changer rates board: reads the live the venue CLOB for
   * the SEA-corridor directions and returns the current rate + reachable size
   * per direction (anonymous best-price book, NOT P2P shop listings). Public,
   * read-only (throwaway owner), no gas. Client caches via staleTime.
   */
  liveBoard: publicProcedure.query(async () => {
    // Core SEA reference pairs always shown.
    const CORE: Array<[string, string]> = [
      ["USDT", "XSGD"], ["XSGD", "USDT"], ["USDT", "JPYC"], ["JPYC", "USDT"],
      ["USDT", "USDC"], ["USDC", "USDT"], ["EURT", "USDT"],
    ];
    // Plus the directions that actually have a real order on the book (ads
    // linked to a the venue order). So the board reflects live liquidity, not a
    // hardcoded list.
    const seen = new Set(CORE.map(([f, t]) => `${f}>${t}`));
    const PAIRS: Array<[string, string]> = [...CORE];
    try {
      const db = await getDb();
      if (db) {
        const onBook = await db
          .selectDistinct({ from: p2pAds.fromToken, to: p2pAds.toToken })
          .from(p2pAds)
          .where(dand(deq(p2pAds.status, "active"), isNotNull(p2pAds.settlementOrderId)));
        for (const r of onBook) {
          const k = `${r.from}>${r.to}`;
          if (!seen.has(k) && PAIRS.length < 24) { seen.add(k); PAIRS.push([r.from, r.to]); }
        }
      }
    } catch { /* fall back to CORE only */ }
    // Use the shared MARGINAL-rate helper — a single small probe is distorted by
    // the venue's large fixed per-trade fee (reads ~0.94 when the true rate is 1.26);
    // marginalRate ladders two sizes and takes the slope, which cancels the fee.
    const { tokenMap, marginalRate } = await import("../lib/dex/analysis");
    let tokens: Awaited<ReturnType<typeof tokenMap>> = {};
    let expiration = 0;
    try {
      tokens = await tokenMap();
      expiration = (await getDexClient().getServerTime()) + 600;
    } catch {
      return { directions: [], asOf: 0 };
    }
    const directions = await Promise.all(
      PAIRS.map(async ([from, to]) => {
        const f = tokens[from], t = tokens[to];
        if (!f || !t) return null;
        const mr = await marginalRate(f, t, expiration);
        if (!mr) return { from, to, live: false as const };
        return { from, to, live: true as const, rate: mr.rate, maxFill: mr.maxFill };
      }),
    );
    return { directions: directions.filter(Boolean), asOf: expiration - 600 };
  }),

  /**
   * opportunities — the edge radar + trade suggestions. Compares the venue's live
   * executable rate to the FX oracle mid per SEA direction and surfaces:
   *   - deals: the venue beats the market mid (edgeBps > 0)
   *   - depegs: same-fiat pair off the 1.0 peg
   * Public, read-only. Powers the opportunity radar + "suggested trades".
   */
  opportunities: publicProcedure.query(async () => {
    const { analyzeDirections, SEA_DIRECTIONS } = await import("../lib/dex/analysis");
    const all = await analyzeDirections(SEA_DIRECTIONS);
    const ranked = all
      .filter((d) => d.settlementRate != null && d.edgeBps != null)
      .sort((a, b) => Math.abs(b.edgeBps ?? 0) - Math.abs(a.edgeBps ?? 0))
      .map((d) => ({
        from: d.from, to: d.to,
        settlementRate: d.settlementRate, oracleMid: d.oracleMid,
        edgeBps: d.edgeBps != null ? Math.round(d.edgeBps) : null,
        change24hPct: d.change24hPct, sameFiat: d.sameFiat, depeg: d.depeg,
        // "deal" = you get meaningfully more than the market mid right now.
        deal: !d.sameFiat && (d.edgeBps ?? 0) >= 10,
        note: d.note,
      }));
    return { opportunities: ranked, asOf: Math.floor(Date.now() / 1000) };
  }),

  /**
   * bestRoute — cheapest way to convert `from`→`to` for `amount`: compares the
   * direct swap against routing through an anchor (USDC/USDT) and returns the
   * route with the highest output + savings vs direct. Read-only (throwaway).
   */
  bestRoute: publicProcedure
    .input(z.object({
      from: z.string().min(1).max(16),
      to: z.string().min(1).max(16),
      amount: z.number().positive(),
    }))
    .query(async ({ input }) => {
      const THROW = "0x000000000000000000000000000000000000dEaD";
      const client = getDexClient();
      const tk = await client.getTokens();
      const bySym: Record<string, { address: string; decimals: number }> = {};
      for (const t of (tk.tokens ?? []) as Array<{ symbol: string; address: string; decimals: number }>) {
        bySym[t.symbol] = { address: t.address, decimals: t.decimals };
      }
      const f = bySym[input.from], t = bySym[input.to];
      if (!f || !t) return { routes: [], best: null, savingsBps: 0 };
      const exp = (await client.getServerTime()) + 600;
      const quote = async (a: { address: string; decimals: number }, b: { address: string; decimals: number }, amt: number): Promise<number | null> => {
        try {
          const res = await fetch(`${client.base}/swap/quote`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "dex-app-route/1" },
            body: JSON.stringify({
              from_token: a.address, to_token: b.address,
              from_amount: BigInt(Math.round(amt * 10 ** a.decimals)).toString(),
              owner_address: THROW, recipient: THROW, expiration: exp, gas_mode: "receive_less",
            }),
          });
          if (!res.ok) return null;
          const j = (await res.json()) as { route_params?: { minOutputAmount?: string } };
          const out = j.route_params?.minOutputAmount;
          return out ? Number(out) / 10 ** b.decimals : null;
        } catch { return null; }
      };

      const direct = await quote(f, t, input.amount);
      const routes: Array<{ path: string; out: number }> = [];
      if (direct != null) routes.push({ path: `${input.from} → ${input.to}`, out: direct });
      for (const anc of ["USDC", "USDT"]) {
        if (anc === input.from || anc === input.to || !bySym[anc]) continue;
        const leg1 = await quote(f, bySym[anc], input.amount);
        if (leg1 == null) continue;
        const leg2 = await quote(bySym[anc], t, leg1);
        if (leg2 == null) continue;
        routes.push({ path: `${input.from} → ${anc} → ${input.to}`, out: leg2 });
      }
      routes.sort((a, b) => b.out - a.out);
      const best = routes[0] ?? null;
      const savingsBps = best && direct && direct > 0 && best.out > direct
        ? Math.round((best.out - direct) / direct * 10000) : 0;
      return { routes, best, savingsBps };
    }),

  /**
   * liveBook — the reconstructed CLOB (individual orders: rate + size per
   * direction), served from the last cached book-scan. Public, read-only.
   */
  liveBook: publicProcedure.query(async () => {
    const { getCachedBook, isScanning } = await import("../lib/dex/bookScanner");
    return { book: getCachedBook(), scanning: isScanning() };
  }),

  /**
   * liveOrders — the REAL resting order book (per-owner `/orders` enumeration
   * over the maker shops), so the Swap can offer every funded order, not a
   * hardcoded token list. Quote-probing misses resting orders; this doesn't.
   * Returns the derived taker routes (from→to, rate, depth) + the tradeable
   * token set. Served from cache; refreshed lazily + on the scheduler.
   */
  liveOrders: publicProcedure.query(async () => {
    const { getCachedLiveOrders, scanLiveOrders, isScanningOrders } = await import("../lib/dex/liveOrders");
    let snap = getCachedLiveOrders();
    if (!snap) {
      // First call: warm it (subsequent calls hit cache).
      snap = await scanLiveOrders();
    } else if (Date.now() - snap.asOf > 90_000 && !isScanningOrders()) {
      // Stale: refresh in the background, return what we have now.
      void scanLiveOrders();
    }
    return { snapshot: snap, scanning: isScanningOrders() };
  }),

  /**
   * rateHistory — the time-series the rate-log cron records, so the UI can show
   * "the rate at that hour" + a price chart. The live API can't answer this;
   * this reads our own snapshots.
   */
  rateHistory: publicProcedure
    .input(z.object({ from: z.string(), to: z.string(), hours: z.number().int().min(1).max(720).default(24) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { points: [] };
      const since = new Date(Date.now() - input.hours * 60 * 60 * 1000);
      const rows = await db
        .select({ settlementRate: rateHistory.settlementRate, oracleMid: rateHistory.oracleMid, edgeBps: rateHistory.edgeBps, recordedAt: rateHistory.recordedAt })
        .from(rateHistory)
        .where(dand(deq(rateHistory.fromToken, input.from), deq(rateHistory.toToken, input.to), dgte(rateHistory.recordedAt, since)))
        .orderBy(ddesc(rateHistory.recordedAt))
        .limit(500);
      return {
        points: rows.map((r) => ({
          settlementRate: r.settlementRate != null ? Number(r.settlementRate) : null,
          oracleMid: r.oracleMid != null ? Number(r.oracleMid) : null,
          edgeBps: r.edgeBps,
          at: r.recordedAt,
        })),
      };
    }),

  /**
   * myFills — the caller's settled trades from the venue (`/fills`, authed with their
   * stored creds). Powers the track record / proof-of-trades view (M5). Returns
   * an empty list (never throws) when no wallet/creds or the venue is unreachable.
   */
  myFills: protectedProcedure.query(async ({ ctx }) => {
    const addr = ctx.user.walletAddress;
    if (!addr) return { fills: [] };
    const creds = await getDecryptedDexCreds(ctx.user.id);
    if (!creds) return { fills: [] };
    try {
      const res = await getDexClient().getFills(addr.toLowerCase(), creds, 50);
      return { fills: res.fills ?? [] };
    } catch {
      return { fills: [] };
    }
  }),

  /**
   * sendToken — REAL wallet-to-wallet send, SERVER-SIGNED with the user's
   * imported managed wallet (Privy is disabled, so the old client-signed path
   * couldn't execute). Same proven primitive as the P2P burst payment leg.
   */
  sendToken: protectedProcedure
    .input(z.object({
      token: z.string().min(1).max(16),
      to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      amount: z.number().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const owner = ctx.user.walletAddress;
      if (!owner) throw new TRPCError({ code: "BAD_REQUEST", message: "Import your wallet first (Me → Import your wallet)." });
      const tk = await getDexClient().getTokens();
      const tok = (tk.tokens ?? []).find((t) => t.symbol === input.token || t.address.toLowerCase() === input.token.toLowerCase());
      if (!tok) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown token ${input.token}` });
      const amountRaw = BigInt(Math.round(input.amount * 10 ** tok.decimals)).toString();
      assertRateLimit(ctx.user.id, "send", 5);
      const res = await signAndBroadcastTransfer({
        userId: ctx.user.id, fromAddress: owner, tokenAddress: tok.address, toAddress: input.to, amountRaw,
      });
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Send failed (${res.code}): ${res.detail}` });
      return { txHash: res.txHash };
    }),

  /**
   * withdraw — REAL vault → wallet withdraw, SERVER-SIGNED with the user's
   * imported managed wallet via the proven 3-step dual-sig /withdraw flow
   * (sign WithdrawIntent → /withdraw → /withdraw/build → sign → /withdraw/send).
   * Recipient defaults to the user's own wallet; pass `to` to send elsewhere.
   * Replaces the dead Privy `runWithdraw` path. Verified on-chain (tx 0x857b5626).
   */
  withdraw: protectedProcedure
    .input(z.object({
      token: z.string().min(1).max(16),
      amount: z.number().positive(),
      to: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const owner = ctx.user.walletAddress;
      if (!owner) throw new TRPCError({ code: "BAD_REQUEST", message: "Import your wallet first (Me → Import your wallet)." });
      const tk = await getDexClient().getTokens();
      const tok = (tk.tokens ?? []).find((t) => t.symbol === input.token || t.address.toLowerCase() === input.token.toLowerCase());
      if (!tok) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown token ${input.token}` });
      const amountRaw = BigInt(Math.round(input.amount * 10 ** tok.decimals)).toString();
      assertRateLimit(ctx.user.id, "withdraw", 5);
      const res = await signAndBroadcastWithdraw({
        userId: ctx.user.id, ownerAddress: owner, tokenAddress: tok.address, amountRaw, recipient: input.to ?? owner,
      });
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Withdraw failed (${res.code}): ${res.detail}` });
      return { txHash: res.txHash };
    }),

  /**
   * swapManaged — REAL swap, SERVER-SIGNED with the user's imported managed
   * wallet. Powers the Swap tab (recipient = self) AND cross-token Send
   * (recipient = the destination address). Replaces the disabled Privy path.
   */
  swapManaged: protectedProcedure
    .input(z.object({
      fromToken: z.string().min(1).max(16),
      toToken: z.string().min(1).max(16),
      amount: z.number().positive(),
      recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const owner = ctx.user.walletAddress;
      if (!owner) throw new TRPCError({ code: "BAD_REQUEST", message: "Import your wallet first (Me → Import your wallet)." });
      if (input.fromToken === input.toToken) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick two different tokens." });
      const tk = await getDexClient().getTokens();
      const list = tk.tokens ?? [];
      const f = list.find((t) => t.symbol === input.fromToken);
      const t = list.find((t) => t.symbol === input.toToken);
      if (!f || !t) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown token" });
      const fromAmountRaw = BigInt(Math.round(input.amount * 10 ** f.decimals)).toString();
      assertRateLimit(ctx.user.id, "swap", 5);
      const res = await signAndBroadcastSwap({
        userId: ctx.user.id, ownerAddress: owner, fromToken: f.address, toToken: t.address,
        fromAmountRaw, recipient: input.recipient,
      });
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Swap failed (${res.code}): ${res.detail}` });
      return { tradeId: res.tradeId, status: res.status, minOut: res.minOut };
    }),
});
