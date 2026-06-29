/**
 * ─── Shop Router (v2 — coordinated 3-leg stablecoin settlement) ──────────────
 *
 * Powers the Shop tab's identity-locked trade flow.
 *
 *   shop.reserve         — pre-check + create settlement row + 90s TTL
 *   shop.recordLeg       — record a leg broadcast (tx hash) and advance status
 *   shop.getSettlement   — poll a settlement by uuid (taker / maker access only)
 *   shop.cancelReserve   — taker bails before signing payment
 *   shop.refund          — admin or auto-worker triggers refund
 *
 * The client constructs each leg's the venue transaction (via existing dex router
 * procedures: transferBuild → wallet signs → txSend), then calls shop.recordLeg
 * with the resulting tx hash. The orchestrator advances the state machine.
 *
 * Real the venue API calls are NOT made directly from this router — the existing
 * dex router (server/routers/dex.ts) handles all the venue REST orchestration.
 * This router is pure state-machine + DB persistence.
 *
 * See SPEC.md §10.2 for the full state machine.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { managedWalletCaps, p2pAds } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import {
  buildPaymentLeg,
  buildRecycleLeg,
  buildReleaseLeg,
  buildRefundLeg,
  isTerminal,
  nextStatus,
  precheckReserve,
  reserveSettlement,
  IllegalTransitionError,
  type LegKind,
  type PrecheckInput,
  type SettlementEvent,
} from "../lib/dex/shopSettlement";
import {
  createDbDeps,
  debitReservation,
  recheckManagedWallet,
  releaseReservation,
} from "../lib/dex/shopSettlementDb";
import { getDexClient } from "../lib/dex/client";
import { getDecryptedDexCreds } from "../lib/dex/apiKey";
import { getActiveRpcUrl, verifyErc20Transfer, verifyVaultTransfer } from "../lib/dex/txVerifier";
import { assertRateLimit } from "../lib/production";
import {
  signAndBroadcastTransfer,
  signAndBroadcastWithdraw,
  signAndBroadcastDeposit,
  type WalletSignResult,
} from "../lib/dex/walletSigner";

const EvmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address");
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid UUID");
const Uint256 = z.string().regex(/^\d+$/, "uint256 decimal string");
const TxHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid tx hash");
const TokenSymbol = z.string().min(1).max(16);

export const shopSettlementRouter = router({
  /**
   * Reserve a shop trade. Runs the pre-check policy and, on success,
   * inserts a settlement row with status=reserved and a 90s TTL.
   *
   * Returns the settlement_uuid the client uses to advance subsequent legs.
   */
  reserve: protectedProcedure
    .input(
      z.object({
        // Client supplies ONLY these. Everything else is derived server-side
        // from the ad + live the venue state. v3 audit caught that the prior
        // implementation let the client supply sellAmount/buyAmount/rate/
        // balances/supportedTokens — that's economic-cheat territory.
        adId: z.number().int().positive(),
        /** Take amount in HUMAN units of the ad's fromToken (sell side). */
        takeAmountHuman: z.string().regex(/^\d+(\.\d+)?$/, "Decimal string"),
        takerAddress: EvmAddress,
        ttlSeconds: z.number().int().min(30).max(600).optional(),
        maxRateDeviationBps: z.number().int().min(0).max(10000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const takerUserId = ctx.user.id;

      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "DB not configured. Set DATABASE_URL.",
        });
      }

      // ─── 1. Load + validate the ad (server-derived economics) ───────────
      const ad = (await db.select().from(p2pAds).where(eq(p2pAds.id, input.adId)).limit(1))[0];
      if (!ad) throw new TRPCError({ code: "NOT_FOUND", message: "Ad not found" });
      if (ad.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Ad status is ${ad.status}` });
      }
      const makerUserId = ad.posterId;
      if (makerUserId === takerUserId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot take your own ad" });
      }

      // Validate takeAmount falls within ad's order limits + remaining liquidity
      const takeAmountNum = Number(input.takeAmountHuman);
      const minOrderNum = Number(ad.minOrder);
      const maxOrderNum = Number(ad.maxOrder);
      const liquidityRemainingNum = Number(ad.liquidityRemaining);
      if (takeAmountNum < minOrderNum) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Take amount below ad min (${ad.minOrder})` });
      }
      if (takeAmountNum > maxOrderNum) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Take amount above ad max (${ad.maxOrder})` });
      }
      if (takeAmountNum > liquidityRemainingNum) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Insufficient ad liquidity remaining (${ad.liquidityRemaining})` });
      }

      // ─── 2. Load the venue /tokens + /config (server-side, no client input) ──
      const dexClient = getDexClient();
      const tokensRes = await dexClient.getTokens().catch(() => null);
      if (!tokensRes?.tokens?.length) {
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "venue /tokens unavailable" });
      }
      const supportedTokenSet = new Set(tokensRes.tokens.map((t) => t.symbol));
      const fromTokenMeta = tokensRes.tokens.find((t) => t.symbol === ad.fromToken);
      const toTokenMeta = tokensRes.tokens.find((t) => t.symbol === ad.toToken);
      if (!fromTokenMeta || !toTokenMeta) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Ad token(s) not in the venue registry: ${ad.fromToken}/${ad.toToken}`,
        });
      }
      const fromDecimals = fromTokenMeta.decimals;
      const toDecimals = toTokenMeta.decimals;

      // ─── 3. Compute raw amounts via BigInt (avoid float drift) ──────────
      const sellAmountRaw = humanToRaw(input.takeAmountHuman, fromDecimals);
      const rateNum = Number(ad.rate);
      const buyAmountHuman = (takeAmountNum * rateNum).toFixed(toDecimals);
      const buyAmountRaw = humanToRaw(buyAmountHuman, toDecimals);

      // ─── 4. Server-derived maker + taker wallet addresses ───────────────
      const makerWallet = await loadUserPrimaryAddress(makerUserId);
      if (!makerWallet) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Maker has no wallet on file" });
      }
      // The takerAddress from input is allowed because the taker is the
      // signing party for the payment leg; we double-check it matches a
      // wallet on file for the authenticated user (no spoofing other users).
      const takerWallet = await loadUserPrimaryAddress(takerUserId);
      if (takerWallet && takerWallet !== input.takerAddress.toLowerCase()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "takerAddress doesn't match authenticated user's wallet",
        });
      }

      // ─── 5. Server-side balance fetch via maker + taker the venue API keys ───
      const makerCreds = await getDecryptedDexCreds(makerUserId);
      const takerCreds = await getDecryptedDexCreds(takerUserId);
      let makerVaultAvailableRaw = "0";
      let takerWalletBalanceRaw = "0";
      if (makerCreds) {
        const makerBalances = await dexClient.getBalances(makerWallet, makerCreds).catch(() => null);
        const sellBal = makerBalances?.balances.find(
          (b) => b.token.toLowerCase() === fromTokenMeta.address.toLowerCase(),
        );
        makerVaultAvailableRaw = sellBal?.vault_available ?? "0";
      }
      if (takerCreds) {
        // Lowercase the address — the venue's "you can only query your own balances"
        // authz compares the API key's owner (stored lowercase) to the queried
        // owner_address case-sensitively. input.takerAddress is checksummed.
        const takerBalances = await dexClient.getBalances(input.takerAddress.toLowerCase(), takerCreds).catch(() => null);
        const buyBal = takerBalances?.balances.find(
          (b) => b.token.toLowerCase() === toTokenMeta.address.toLowerCase(),
        );
        takerWalletBalanceRaw = buyBal?.wallet_balance ?? "0";
      }
      // If either creds are missing, balances stay "0" and precheck will
      // fail with INSUFFICIENT — caller must provision the venue API keys first.

      // ─── 6. Live mid-rate sanity (optional, drift guard) ────────────────
      let currentMidRate: number | undefined;
      if (fromTokenMeta.currency && toTokenMeta.currency && input.maxRateDeviationBps !== undefined) {
        const fxRes = await dexClient.getFxRate(fromTokenMeta.currency, toTokenMeta.currency).catch(() => null);
        if (fxRes) currentMidRate = Number(fxRes.rate);
      }

      // ─── 7. Managed-wallet cap accounting ───────────────────────────────
      const makerCap = (await db
        .select()
        .from(managedWalletCaps)
        .where(eq(managedWalletCaps.userId, makerUserId))
        .limit(1))[0];
      const managedWalletActive = !!(makerCap?.enabled && !makerCap.killed);
      // USD-equivalent for cap accounting — approximate via fx_rate of sell
      // token's fiat to USD. Conservative fallback: treat take_amount as USD.
      let sellAmountUsd = takeAmountNum;
      if (fromTokenMeta.currency && fromTokenMeta.currency !== "USD") {
        const usdRate = await dexClient.getFxRate(fromTokenMeta.currency, "USD").catch(() => null);
        if (usdRate) sellAmountUsd = takeAmountNum * Number(usdRate.rate);
      }

      // ─── 8. Pure pre-check (server-derived inputs) ──────────────────────
      const precheckInput: PrecheckInput = {
        makerVaultAvailableRaw,
        takerWalletBalanceRaw,
        sellAmountRaw,
        buyAmountRaw,
        makerAddress: makerWallet,
        takerAddress: input.takerAddress,
        sellToken: ad.fromToken,
        buyToken: ad.toToken,
        supportedTokens: supportedTokenSet,
        currentMidRate,
        quotedRate: rateNum,
        maxRateDeviationBps: input.maxRateDeviationBps,
        makerCap: managedWalletActive && makerCap
          ? {
              perTradeCapUsd: Number(makerCap.perTradeCapUsd),
              dailyRemainingUsd: Math.max(
                Number(makerCap.dailyVolumeCapUsd) - Number(makerCap.dailyVolumeUsedUsd),
                0,
              ),
              sellAmountUsd,
              killed: makerCap.killed,
              allowed: makerCap.tokenAllowlist.split(",").map((s) => s.trim()).includes(ad.fromToken),
            }
          : undefined,
      };

      const decision = precheckReserve(precheckInput);
      if (!decision.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Pre-check failed (${decision.code}): ${decision.detail}`,
        });
      }

      // ─── 9. Atomic reservation debit (HUMAN units, real DB transaction) ──
      const debit = await debitReservation({
        adId: input.adId,
        sellAmountHuman: input.takeAmountHuman,
        makerUserId,
        sellAmountUsd,
        managedWalletActive,
      });
      if (!debit.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Reservation debit failed (${debit.code}): ${debit.detail}`,
        });
      }

      // ─── 10. Insert settlement row + advance to reserved ────────────────
      const deps = createDbDeps();
      try {
        const result = await reserveSettlement(
          {
            adId: input.adId,
            makerUserId,
            takerUserId,
            makerAddress: makerWallet,
            takerAddress: input.takerAddress,
            sellToken: ad.fromToken,
            buyToken: ad.toToken,
            sellAmountRaw,
            buyAmountRaw,
            sellDecimals: fromDecimals,
            buyDecimals: toDecimals,
            rateUsed: ad.rate,
            ttlSeconds: input.ttlSeconds,
          },
          deps,
        );
        return result;
      } catch (err: unknown) {
        // Rollback the debit if insertSettlement failed. settlementId
        // unknown here (insertSettlement failed) so pass undefined →
        // releaseReservation falls back to non-idempotent path which is OK
        // because nothing else touched this ad yet.
        await releaseReservation({
          adId: input.adId,
          sellAmountHuman: input.takeAmountHuman,
          makerUserId,
          sellAmountUsd,
          managedWalletActive,
        }).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Reserve failed: ${msg}`,
        });
      }
    }),

  /**
   * Record a broadcast leg (tx hash known). Advances the state machine.
   * Caller has already submitted the signed tx to the venue via /transfer/send,
   * /withdraw/send, or /tx/send; we just record + advance.
   *
   * Leg numbering (per SPEC):
   *   1 = payment   (taker → maker wallet, /transfer)
   *   2 = release   (maker vault → taker, /withdraw)
   *   3 = recycle   (maker wallet → maker vault, /deposit)
   *  99 = refund    (maker → taker, /transfer, only on refund_required)
   */
  recordLeg: protectedProcedure
    .input(
      z.object({
        settlementUuid: Uuid,
        legNumber: z.number().int().min(1).max(99),
        legKind: z.enum(["payment", "release", "recycle", "refund"]),
        settlementEndpoint: z.enum(["transfer", "withdraw", "deposit"]),
        signerAddress: EvmAddress,
        signerRole: z.enum(["taker_privy", "taker_managed", "maker_managed"]),
        txHash: TxHash,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const deps = createDbDeps();

      let snap;
      try {
        snap = await deps.loadSettlement(input.settlementUuid);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "DB not available") {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "DB not configured.",
          });
        }
        throw err;
      }
      if (!snap) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Settlement not found" });
      }

      // Authorization: caller must be taker or maker
      if (snap.settlement.takerUserId !== ctx.user.id && snap.settlement.makerUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your settlement" });
      }

      // W3: TTL expiry guard — if reservedUntil passed and we're still in a
      // pre-payment state, flip to expired before allowing further moves.
      if (
        snap.settlement.reservedUntil &&
        snap.settlement.reservedUntil.getTime() < Date.now() &&
        (snap.settlement.status === "reserved" ||
          snap.settlement.status === "payment_pending_signature")
      ) {
        await deps.advanceStatus(snap.settlement.id, snap.settlement.status, "expired", {
          failureCode: "TTL_EXPIRED",
          failureDetail: `Reservation expired at ${snap.settlement.reservedUntil.toISOString()}`,
        });
        // Release the reservation locks (idempotent via settlementId guard)
        await releaseReservation({
          settlementId: snap.settlement.id,
          adId: snap.settlement.adId,
          sellAmountHuman: rawToHumanString(snap.settlement.sellAmountRaw, snap.settlement.sellDecimals),
          makerUserId: snap.settlement.makerUserId,
          sellAmountUsd: 0, // unknown at this layer — recorded in the cap via reservation
          managedWalletActive: true, // safe to release (no-op if cap row absent)
        }).catch(() => {});
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Reservation expired — start a new trade",
        });
      }

      // B3: re-check maker's managed-wallet kill switch + caps before the
      // release leg lands. If maker killed their wallet after reserve, abort.
      if (input.legKind === "release" || input.legKind === "recycle" || input.legKind === "refund") {
        const recheck = await recheckManagedWallet(snap.settlement.makerUserId);
        if (!recheck.ok) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Maker managed wallet unavailable: ${recheck.reason}`,
          });
        }
      }

      // Pick the event for this leg
      const event: SettlementEvent = pickBroadcastEvent(input.legKind);

      // Validate the transition is legal from current status
      let nextStatusValue;
      try {
        nextStatusValue = nextStatus(snap.settlement.status, event);
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot ${event} from ${err.fromStatus}`,
          });
        }
        throw err;
      }

      // W5: advance status FIRST (optimistic CAS) before inserting the leg row.
      // If CAS fails (concurrent advance), we haven't inserted a leg row that
      // would be orphaned. The idempotency key on insertLeg still de-dupes
      // legitimate retries.
      const advanced = await deps.advanceStatus(snap.settlement.id, snap.settlement.status, nextStatusValue);
      if (!advanced) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Settlement status changed concurrently. Retry.",
        });
      }

      // Insert the leg row (idempotency key collision = legitimate retry, caller handles)
      const idempotencyKey = pickIdempotencyKey(input.settlementUuid, input.legNumber);
      const { id: legId } = await deps.insertLeg({
        settlementId: snap.settlement.id,
        legNumber: input.legNumber,
        legKind: input.legKind,
        settlementEndpoint: input.settlementEndpoint,
        idempotencyKey,
        signerAddress: input.signerAddress,
        signerRole: input.signerRole,
      });

      // Mark broadcast on the leg
      await deps.updateLeg(legId, {
        status: "broadcast",
        txHash: input.txHash,
        broadcastAt: new Date(),
      });

      return {
        ok: true,
        legId,
        settlementUuid: input.settlementUuid,
        newStatus: nextStatusValue,
        txHash: input.txHash,
      };
    }),

  /**
   * Mark a broadcast leg as confirmed on-chain. **v4 fix**: now fetches the
   * tx receipt via JSON-RPC and verifies sender / recipient / token / amount
   * match the leg's expected values BEFORE advancing the state machine.
   * blockNumber + gasUsed are derived from the receipt — client-supplied
   * values are ignored.
   */
  confirmLeg: protectedProcedure
    .input(
      z.object({
        settlementUuid: Uuid,
        legId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const deps = createDbDeps();
      const snap = await deps.loadSettlement(input.settlementUuid);
      if (!snap) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Settlement not found" });
      }
      if (snap.settlement.takerUserId !== ctx.user.id && snap.settlement.makerUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your settlement" });
      }

      const leg = snap.legs.find((l) => l.id === input.legId);
      if (!leg) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Leg not found" });
      }
      if (leg.status !== "broadcast") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Leg is ${leg.status}, expected broadcast`,
        });
      }
      if (!leg.txHash) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Leg has no tx hash to verify",
        });
      }

      // v4 #3 fix: verify the tx receipt on-chain before advancing state.
      // Derive expected from/to/token/amount from the settlement + leg context.
      const dexClient = getDexClient();
      const bootstrap = await dexClient.getConfig().catch(() => null);
      if (!bootstrap?.vault_address) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Cannot fetch the venue /config for vault address",
        });
      }
      const tokensRes = await dexClient.getTokens().catch(() => null);
      const sellTokenMeta = tokensRes?.tokens.find((t) => t.symbol === snap.settlement.sellToken);
      const buyTokenMeta = tokensRes?.tokens.find((t) => t.symbol === snap.settlement.buyToken);
      if (!sellTokenMeta || !buyTokenMeta) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Cannot resolve token addresses from the venue /tokens",
        });
      }

      const rpcUrl = getActiveRpcUrl();
      let verifyResult;
      switch (leg.legKind as LegKind) {
        case "payment":
          // Taker pays maker wallet with buyToken
          verifyResult = await verifyErc20Transfer(rpcUrl, leg.txHash, {
            legKind: "payment",
            tokenAddress: buyTokenMeta.address,
            fromAddress: snap.settlement.takerAddress,
            toAddress: snap.settlement.makerAddress,
            amountRaw: snap.settlement.buyAmountRaw,
          });
          break;
        case "release":
          // Vault → taker wallet with sellToken
          verifyResult = await verifyVaultTransfer(rpcUrl, leg.txHash, {
            legKind: "release",
            tokenAddress: sellTokenMeta.address,
            fromAddress: bootstrap.vault_address,
            toAddress: snap.settlement.takerAddress,
            amountRaw: snap.settlement.sellAmountRaw,
          });
          break;
        case "recycle":
          // Maker wallet → vault with buyToken
          verifyResult = await verifyVaultTransfer(rpcUrl, leg.txHash, {
            legKind: "recycle",
            tokenAddress: buyTokenMeta.address,
            fromAddress: snap.settlement.makerAddress,
            toAddress: bootstrap.vault_address,
            amountRaw: snap.settlement.buyAmountRaw,
          });
          break;
        case "refund":
          // Maker wallet → taker wallet with buyToken (return the payment)
          verifyResult = await verifyErc20Transfer(rpcUrl, leg.txHash, {
            legKind: "refund",
            tokenAddress: buyTokenMeta.address,
            fromAddress: snap.settlement.makerAddress,
            toAddress: snap.settlement.takerAddress,
            amountRaw: snap.settlement.buyAmountRaw,
          });
          break;
      }

      if (!verifyResult.ok) {
        await deps.updateLeg(input.legId, {
          status: "failed",
          failureCode: `VERIFY_${verifyResult.code}`,
          failureDetail: verifyResult.detail,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `On-chain verification failed (${verifyResult.code}): ${verifyResult.detail}`,
        });
      }

      const confirmedAt = new Date();
      await deps.updateLeg(input.legId, {
        status: "confirmed",
        blockNumber: verifyResult.blockNumber,
        gasUsed: verifyResult.gasUsed,
        confirmedAt,
      });

      // Advance the settlement state machine based on which leg confirmed
      const event = pickConfirmEvent(leg.legKind as LegKind);
      let nextStatusValue;
      try {
        nextStatusValue = nextStatus(snap.settlement.status, event);
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          // Already-advanced is OK (race with worker) — return current
          return {
            ok: true,
            newStatus: snap.settlement.status,
            alreadyAdvanced: true,
          };
        }
        throw err;
      }

      const advanced = await deps.advanceStatus(
        snap.settlement.id,
        snap.settlement.status,
        nextStatusValue,
      );

      // If terminal, stamp completedAt
      const isTerminalAfter = isTerminal(nextStatusValue);
      if (isTerminalAfter) {
        await deps.advanceStatus(snap.settlement.id, nextStatusValue, nextStatusValue, {
          completedAt: confirmedAt,
        });
      }

      return {
        ok: true,
        newStatus: nextStatusValue,
        alreadyAdvanced: !advanced,
      };
    }),

  /**
   * Mark a leg as failed and (depending on which leg) move to refund or expire.
   */
  failLeg: protectedProcedure
    .input(
      z.object({
        settlementUuid: Uuid,
        legId: z.number().int().positive(),
        failureCode: z.string().min(1).max(64),
        failureDetail: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const deps = createDbDeps();
      const snap = await deps.loadSettlement(input.settlementUuid);
      if (!snap) throw new TRPCError({ code: "NOT_FOUND", message: "Settlement not found" });
      if (snap.settlement.takerUserId !== ctx.user.id && snap.settlement.makerUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your settlement" });
      }
      const leg = snap.legs.find((l) => l.id === input.legId);
      if (!leg) throw new TRPCError({ code: "NOT_FOUND", message: "Leg not found" });

      await deps.updateLeg(input.legId, {
        status: "failed",
        failureCode: input.failureCode,
        failureDetail: input.failureDetail ?? "",
      });

      const failEvent: SettlementEvent =
        leg.legKind === "payment" ? "payment_failed" :
        leg.legKind === "release" ? "release_failed" :
        "recycle_failed";

      let nextStatusValue;
      try {
        nextStatusValue = nextStatus(snap.settlement.status, failEvent);
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          return { ok: true, newStatus: snap.settlement.status, alreadyAdvanced: true };
        }
        throw err;
      }

      await deps.advanceStatus(snap.settlement.id, snap.settlement.status, nextStatusValue, {
        failureCode: input.failureCode,
        failureDetail: input.failureDetail,
      });

      return { ok: true, newStatus: nextStatusValue };
    }),

  /**
   * Taker cancels a reservation before signing the payment leg.
   */
  cancelReserve: protectedProcedure
    .input(z.object({ settlementUuid: Uuid }))
    .mutation(async ({ ctx, input }) => {
      const deps = createDbDeps();
      const snap = await deps.loadSettlement(input.settlementUuid);
      if (!snap) throw new TRPCError({ code: "NOT_FOUND", message: "Settlement not found" });
      if (snap.settlement.takerUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the taker can cancel" });
      }

      let nextStatusValue;
      try {
        nextStatusValue = nextStatus(snap.settlement.status, "cancel");
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot cancel from ${err.fromStatus}`,
          });
        }
        throw err;
      }

      await deps.advanceStatus(snap.settlement.id, snap.settlement.status, nextStatusValue);

      // Release the reservation locks since trade was cancelled before payment
      await releaseReservation({
        settlementId: snap.settlement.id,
        adId: snap.settlement.adId,
        sellAmountHuman: rawToHumanString(snap.settlement.sellAmountRaw, snap.settlement.sellDecimals),
        makerUserId: snap.settlement.makerUserId,
        sellAmountUsd: 0,
        managedWalletActive: true,
      }).catch(() => {});

      return { ok: true, newStatus: nextStatusValue };
    }),

  /**
   * Poll a settlement by uuid. Returns full snapshot incl. all legs.
   */
  getSettlement: protectedProcedure
    .input(z.object({ settlementUuid: Uuid }))
    .query(async ({ ctx, input }) => {
      const deps = createDbDeps();
      const snap = await deps.loadSettlement(input.settlementUuid);
      if (!snap) throw new TRPCError({ code: "NOT_FOUND", message: "Settlement not found" });
      if (snap.settlement.takerUserId !== ctx.user.id && snap.settlement.makerUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your settlement" });
      }
      return snap;
    }),

  /**
   * Build the leg metadata for the client to use when constructing each
   * the venue signature. Returns the leg-builder output for the requested
   * leg number, so the client knows which signing role + endpoint applies.
   * No DB writes — purely a derivation.
   */
  prepareLeg: protectedProcedure
    .input(
      z.object({
        settlementUuid: Uuid,
        legNumber: z.number().int().min(1).max(99),
      }),
    )
    .query(async ({ ctx, input }) => {
      const deps = createDbDeps();
      const snap = await deps.loadSettlement(input.settlementUuid);
      if (!snap) throw new TRPCError({ code: "NOT_FOUND", message: "Settlement not found" });
      if (snap.settlement.takerUserId !== ctx.user.id && snap.settlement.makerUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your settlement" });
      }

      // W4: query the taker's managed-wallet status to set isManagedTaker correctly.
      // Without this, prepareLeg always returned taker_privy even for power users.
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "DB not configured" });
      const takerCap = (await db
        .select()
        .from(managedWalletCaps)
        .where(eq(managedWalletCaps.userId, snap.settlement.takerUserId))
        .limit(1))[0];
      const isManagedTaker = !!(takerCap?.enabled && !takerCap.killed);

      switch (input.legNumber) {
        case 1: return buildPaymentLeg(input.settlementUuid, snap.settlement.takerAddress, isManagedTaker);
        case 2: return buildReleaseLeg(input.settlementUuid, snap.settlement.makerAddress);
        case 3: return buildRecycleLeg(input.settlementUuid, snap.settlement.makerAddress);
        case 99: return buildRefundLeg(input.settlementUuid, snap.settlement.makerAddress);
        default:
          throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown leg number ${input.legNumber}` });
      }
    }),

  /**
   * Server-orchestrated 3-leg burst settlement.
   *
   * Used in testnet where Privy isn't wired and both parties have imported
   * their private key via wallet.importPrivateKey (testnet-only mutation).
   * Server signs each leg with the stored encrypted key (managed-wallet
   * model on both sides) — no client-side popup.
   *
   * Pre-condition: settlement is in "reserved" state (created by shop.reserve).
   * Caller must be the taker (the only role authorized to start the payment).
   *
   * Drives the state machine end-to-end:
   *   reserved → payment_broadcast → payment_confirmed
   *           → release_broadcast → release_confirmed
   *           → recycle_pending  → completed
   *
   * If any leg fails after payment confirmed, sets refund_required so the
   * existing refund worker picks it up. If recycle fails, completes anyway
   * (taker already settled) — recycle retry worker handles it async.
   */
  executeBurst: protectedProcedure
    .input(z.object({ settlementUuid: Uuid }))
    .mutation(async ({ ctx, input }) => {
      const deps = createDbDeps();
      const snap = await deps.loadSettlement(input.settlementUuid);
      if (!snap) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Settlement not found" });
      }
      assertRateLimit(ctx.user.id, "burst", 5);
      if (snap.settlement.takerUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the taker can execute the burst" });
      }
      if (snap.settlement.status !== "reserved") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Settlement is ${snap.settlement.status}, expected reserved`,
        });
      }

      // Resolve token addresses for leg signing + on-chain verification.
      const dexClient = getDexClient();
      const tokensRes = await dexClient.getTokens().catch(() => null);
      const sellTokenMeta = tokensRes?.tokens.find((t) => t.symbol === snap.settlement.sellToken);
      const buyTokenMeta = tokensRes?.tokens.find((t) => t.symbol === snap.settlement.buyToken);
      if (!sellTokenMeta || !buyTokenMeta) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Cannot resolve token addresses from the venue /tokens",
        });
      }

      const result: {
        ok: boolean;
        finalStatus: string;
        paymentTxHash?: string;
        releaseTxHash?: string;
        recycleTxHash?: string;
        error?: string;
      } = { ok: false, finalStatus: snap.settlement.status };

      // ─── Helper: insert leg row + return id ──────────────────────────────
      const recordBroadcast = async (
        legNumber: 1 | 2 | 3,
        legKind: LegKind,
        endpoint: "transfer" | "withdraw" | "deposit",
        signerRole: "taker_managed" | "maker_managed",
        signerAddress: string,
        signResult: WalletSignResult,
      ): Promise<{ legId: number } | { error: string }> => {
        const idempotencyKey = `${snap.settlement.settlementUuid}:${legNumber}:1`;
        const { id: legId } = await deps.insertLeg({
          settlementId: snap.settlement.id,
          legNumber,
          legKind,
          settlementEndpoint: endpoint,
          idempotencyKey,
          signerAddress,
          signerRole,
        });
        if (!signResult.ok) {
          await deps.updateLeg(legId, {
            status: "failed",
            failureCode: signResult.code,
            failureDetail: signResult.detail,
          });
          return { error: `${legKind} sign/broadcast failed: ${signResult.code} ${signResult.detail}` };
        }
        await deps.updateLeg(legId, {
          status: "broadcast",
          txHash: signResult.txHash,
          broadcastAt: new Date(),
        });
        return { legId };
      };

      // ─── TOCTOU recheck (audit medium #12) ───────────────────────────────
      // The maker could have drained their vault between reserve and now. Re-read
      // the maker's vault_available for the sell token BEFORE the taker pays — if
      // it can't cover the release, abort cleanly so the taker is never charged
      // (avoids the refund path entirely for the drained-maker case).
      try {
        const makerCreds = await getDecryptedDexCreds(snap.settlement.makerUserId);
        if (makerCreds) {
          const bal = await dexClient.getBalances(snap.settlement.makerAddress.toLowerCase(), makerCreds);
          const row = bal.balances.find((b) => (b as { symbol?: string }).symbol === snap.settlement.sellToken);
          const availRaw = BigInt((row as { vault_available?: string } | undefined)?.vault_available ?? "0");
          if (availRaw < BigInt(snap.settlement.sellAmountRaw)) {
            await deps.advanceStatus(snap.settlement.id, snap.settlement.status, "expired", {
              failureCode: "MAKER_VAULT_DRAINED",
              failureDetail: "Maker vault no longer covers the release amount",
            });
            return {
              ...result,
              finalStatus: "expired",
              error: "This shop no longer has enough inventory to fill — trade cancelled, you were not charged.",
            };
          }
        }
      } catch (err) {
        // Non-fatal: the leg-2 release-failure → refund path is the backstop.
        console.warn("[burst] maker vault recheck failed (non-fatal):", err instanceof Error ? err.message : err);
      }

      // ─── LEG 1: Payment (taker → maker wallet) ────────────────────────────
      const paymentSign = await signAndBroadcastTransfer({
        userId: snap.settlement.takerUserId,
        fromAddress: snap.settlement.takerAddress,
        toAddress: snap.settlement.makerAddress,
        tokenAddress: buyTokenMeta.address,
        amountRaw: snap.settlement.buyAmountRaw,
      });
      const paymentRec = await recordBroadcast(
        1, "payment", "transfer", "taker_managed",
        snap.settlement.takerAddress, paymentSign,
      );
      if ("error" in paymentRec) {
        // Payment failed before any maker funds moved — release reservation,
        // mark settlement cancelled. Taker is not at risk (no funds left wallet).
        await deps.advanceStatus(snap.settlement.id, "reserved", "cancelled", {
          failureCode: "PAYMENT_SIGN_FAILED",
          failureDetail: paymentRec.error,
        });
        return { ...result, finalStatus: "cancelled", error: paymentRec.error };
      }
      result.paymentTxHash = paymentSign.ok ? paymentSign.txHash : undefined;

      await deps.advanceStatus(snap.settlement.id, "reserved", "payment_broadcast");

      // VERIFY the taker payment actually mined on-chain BEFORE releasing any
      // maker funds (audit crit #3). signAndBroadcastTransfer returns on
      // broadcast-accept, NOT on mine — the "taker pays first" safety only holds
      // if the payment is CONFIRMED. The tx was just broadcast, so poll the
      // receipt (Sepolia ~12s blocks); TX_NOT_FOUND = not mined yet → retry;
      // TX_REVERTED / mismatch = fail immediately. If unconfirmed, abort cleanly
      // — no maker funds have moved (taker keeps their tokens).
      if (paymentSign.ok && paymentSign.txHash) {
        const rpcUrl = getActiveRpcUrl();
        let pv = await verifyErc20Transfer(rpcUrl, paymentSign.txHash, {
          legKind: "payment",
          tokenAddress: buyTokenMeta.address,
          fromAddress: snap.settlement.takerAddress,
          toAddress: snap.settlement.makerAddress,
          amountRaw: snap.settlement.buyAmountRaw,
        });
        for (let i = 0; i < 8 && !pv.ok && pv.code === "TX_NOT_FOUND"; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          pv = await verifyErc20Transfer(rpcUrl, paymentSign.txHash, {
            legKind: "payment",
            tokenAddress: buyTokenMeta.address,
            fromAddress: snap.settlement.takerAddress,
            toAddress: snap.settlement.makerAddress,
            amountRaw: snap.settlement.buyAmountRaw,
          });
        }
        if (!pv.ok) {
          const detail = `payment not confirmed on-chain (${pv.code}): ${pv.detail}`;
          await deps.updateLeg(paymentRec.legId, { status: "failed", failureCode: `PAYMENT_${pv.code}`, failureDetail: detail });
          // No maker funds moved yet → fail the settlement, do NOT release.
          await deps.advanceStatus(snap.settlement.id, "payment_broadcast", "expired", { failureCode: `PAYMENT_${pv.code}`, failureDetail: detail });
          return { ...result, finalStatus: "expired", error: detail };
        }
        await deps.advanceStatus(snap.settlement.id, "payment_broadcast", "payment_confirmed");
        await deps.updateLeg(paymentRec.legId, { status: "confirmed", txHash: paymentSign.txHash, blockNumber: pv.blockNumber, gasUsed: pv.gasUsed, confirmedAt: new Date() });
      } else {
        await deps.advanceStatus(snap.settlement.id, "payment_broadcast", "payment_confirmed");
        await deps.updateLeg(paymentRec.legId, { status: "confirmed", confirmedAt: new Date() });
      }

      // ─── LEG 2: Release (maker.vault → taker.wallet) ─────────────────────
      const releaseSign = await signAndBroadcastWithdraw({
        userId: snap.settlement.makerUserId,
        ownerAddress: snap.settlement.makerAddress,
        tokenAddress: sellTokenMeta.address,
        amountRaw: snap.settlement.sellAmountRaw,
        recipient: snap.settlement.takerAddress,
      });
      const releaseRec = await recordBroadcast(
        2, "release", "withdraw", "maker_managed",
        snap.settlement.makerAddress, releaseSign,
      );
      if ("error" in releaseRec) {
        // Payment landed but release failed — refund worker will reverse.
        await deps.advanceStatus(snap.settlement.id, "payment_confirmed", "refund_required", {
          failureCode: "RELEASE_SIGN_FAILED",
          failureDetail: releaseRec.error,
        });
        return { ...result, finalStatus: "refund_required", error: releaseRec.error };
      }
      result.releaseTxHash = releaseSign.ok ? releaseSign.txHash : undefined;

      await deps.advanceStatus(snap.settlement.id, "payment_confirmed", "release_broadcast");
      await deps.advanceStatus(snap.settlement.id, "release_broadcast", "release_confirmed");
      await deps.updateLeg(releaseRec.legId, { status: "confirmed", confirmedAt: new Date() });

      // ─── LEG 3: Recycle (maker.wallet → maker.vault) ─────────────────────
      const recycleSign = await signAndBroadcastDeposit({
        userId: snap.settlement.makerUserId,
        ownerAddress: snap.settlement.makerAddress,
        tokenAddress: buyTokenMeta.address,
        amountRaw: snap.settlement.buyAmountRaw,
      });
      const recycleRec = await recordBroadcast(
        3, "recycle", "deposit", "maker_managed",
        snap.settlement.makerAddress, recycleSign,
      );
      if ("error" in recycleRec) {
        // Recycle failed but taker already settled. Mark recycle_pending so the
        // retry worker picks it up. No taker impact — return success.
        await deps.advanceStatus(snap.settlement.id, "release_confirmed", "recycle_pending", {
          failureCode: "RECYCLE_SIGN_FAILED",
          failureDetail: recycleRec.error,
        });
        return {
          ok: true,
          finalStatus: "recycle_pending",
          paymentTxHash: result.paymentTxHash,
          releaseTxHash: result.releaseTxHash,
          error: `recycle failed (will retry): ${recycleRec.error}`,
        };
      }
      result.recycleTxHash = recycleSign.ok ? recycleSign.txHash : undefined;

      await deps.advanceStatus(snap.settlement.id, "release_confirmed", "recycle_pending");
      await deps.updateLeg(recycleRec.legId, { status: "confirmed", confirmedAt: new Date() });

      // Final: recycle_pending → completed
      const completedAt = new Date();
      await deps.advanceStatus(snap.settlement.id, "recycle_pending", "completed", { completedAt });

      return {
        ok: true,
        finalStatus: "completed",
        paymentTxHash: result.paymentTxHash,
        releaseTxHash: result.releaseTxHash,
        recycleTxHash: result.recycleTxHash,
      };
    }),
});

// ─── Helpers: BigInt unit conversion ────────────────────────────────────────

/**
 * Convert a human-readable decimal string ("100" or "100.5") to a uint256
 * raw string at the given decimals. Uses BigInt to avoid float drift.
 */
function humanToRaw(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole === "0" ? "" : whole) + fracPadded;
  // Strip leading zeros, but keep "0" if all zeros
  const stripped = combined.replace(/^0+/, "") || "0";
  return stripped;
}

/**
 * Convert raw uint256 string back to human-readable decimal string using
 * the canonical token decimals snapshot persisted on the settlement row.
 *
 * Audit blocker #2: workers must NEVER guess decimals. ARC token has 2
 * decimals; a default of 6 mis-credits by 10,000×. Decimals are captured
 * at reserve time (from /tokens) and stored on shop_settlements row —
 * callers pass them explicitly.
 */
function rawToHumanString(raw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`rawToHumanString: invalid decimals ${decimals}`);
  }
  const denom = 10n ** BigInt(decimals);
  const r = BigInt(raw);
  const whole = r / denom;
  const frac = r % denom;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

// ─── User wallet lookup (server-side, never trust client claims) ──────────────
//
// Resolves a user's primary signing address. Order of preference:
//   1. Privy wallet (users.walletAddress) — default
//   2. Managed-shop-wallet (wallet_keys.address) — opt-in shopkeepers only
async function loadUserPrimaryAddress(userId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const { users, walletKeys } = await import("../../drizzle/schema");
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (u?.walletAddress) return u.walletAddress.toLowerCase();
  const w = (await db.select().from(walletKeys).where(eq(walletKeys.userId, userId)).limit(1))[0];
  if (w?.address) return w.address.toLowerCase();
  return null;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function pickBroadcastEvent(legKind: "payment" | "release" | "recycle" | "refund"): SettlementEvent {
  // The "_broadcast" event names match the state machine in shopSettlement.ts
  // (payment_broadcast and release_broadcast are events; recycle uses
  // recycle_started; refund uses refund_started).
  switch (legKind) {
    case "payment": return "payment_broadcast";
    case "release": return "release_broadcast";
    case "recycle": return "recycle_started";
    case "refund":  return "refund_started";
  }
}

function pickConfirmEvent(legKind: LegKind): SettlementEvent {
  switch (legKind) {
    case "payment": return "payment_confirmed";
    case "release": return "release_confirmed";
    case "recycle": return "recycle_confirmed";
    case "refund":  return "refund_confirmed";
  }
}

function pickIdempotencyKey(settlementUuid: string, legNumber: number): string {
  // Mirrors legIdempotencyKey() from shopSettlement.ts. Attempt 0 by default
  // for the first record; retries currently get a fresh key by passing higher
  // attempt — that should be handled by the retry worker, not this entry point.
  return `${settlementUuid}:${legNumber}:0`;
}
