/**
 * shopSettlement.test.ts — pure-logic coverage for the coordinated 3-leg
 * shop trade orchestrator.
 *
 * What this locks in:
 *   - The state machine transitions follow SPEC §10.2 exactly
 *   - Illegal transitions throw IllegalTransitionError
 *   - Pre-check policy catches every failure mode before locks are taken
 *   - Idempotency key construction is collision-free for retries
 *   - Leg-builder helpers produce the right (signer, role, endpoint) tuple
 *
 * Side-effect-heavy paths (real the venue calls, real DB writes) are covered
 * in shopSettlementService.test.ts via injected mocks.
 */

import { describe, expect, it } from "vitest";

import {
  buildPaymentLeg,
  buildRecycleLeg,
  buildReleaseLeg,
  buildRefundLeg,
  IllegalTransitionError,
  isTerminal,
  legIdempotencyKey,
  nextStatus,
  precheckReserve,
  TERMINAL_STATUSES,
  type PrecheckInput,
  type SettlementEvent,
} from "./shopSettlement";

import type { ShopSettlementStatus } from "../../../drizzle/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — the canonical sequence from spec §10.2

describe("state machine — happy path", () => {
  it("walks the full sequence: quoted → … → completed", () => {
    let s: ShopSettlementStatus = "quoted";
    s = nextStatus(s, "reserve");
    expect(s).toBe("reserved");
    s = nextStatus(s, "taker_sign_payment");
    expect(s).toBe("payment_pending_signature");
    s = nextStatus(s, "payment_broadcast");
    expect(s).toBe("payment_broadcast");
    s = nextStatus(s, "payment_confirmed");
    expect(s).toBe("payment_confirmed");
    s = nextStatus(s, "maker_sign_release");
    expect(s).toBe("release_pending_signature");
    s = nextStatus(s, "release_broadcast");
    expect(s).toBe("release_broadcast");
    s = nextStatus(s, "release_confirmed");
    expect(s).toBe("release_confirmed");
    s = nextStatus(s, "recycle_started");
    expect(s).toBe("recycle_pending");
    s = nextStatus(s, "recycle_confirmed");
    expect(s).toBe("completed");
    expect(isTerminal(s)).toBe(true);
  });

  it("supports skip-recycle path (maker opts out of auto-deposit)", () => {
    let s: ShopSettlementStatus = "release_confirmed";
    s = nextStatus(s, "skip_recycle");
    expect(s).toBe("completed");
  });

  it("recycle_failed still completes the trade (recycle is best-effort)", () => {
    // The CORE of the locked architecture: if recycle fails, the taker still
    // got their goods, the maker still got paid. Only the maker's vault
    // auto-deposit didn't happen. The trade is functionally done.
    let s: ShopSettlementStatus = "recycle_pending";
    s = nextStatus(s, "recycle_failed");
    expect(s).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refund paths — the load-bearing safety net

describe("state machine — refund paths", () => {
  it("release_failed after payment confirmed → refund_required", () => {
    let s: ShopSettlementStatus = "payment_confirmed";
    s = nextStatus(s, "release_failed");
    expect(s).toBe("refund_required");
  });

  it("release_failed from release_broadcast (mid-broadcast) → refund_required", () => {
    let s: ShopSettlementStatus = "release_broadcast";
    s = nextStatus(s, "release_failed");
    expect(s).toBe("refund_required");
  });

  it("refund_required → refund_pending → refunded", () => {
    let s: ShopSettlementStatus = "refund_required";
    s = nextStatus(s, "refund_started");
    expect(s).toBe("refund_pending");
    s = nextStatus(s, "refund_confirmed");
    expect(s).toBe("refunded");
    expect(isTerminal(s)).toBe(true);
  });

  it("refund_failed → failed_manual_review", () => {
    let s: ShopSettlementStatus = "refund_pending";
    s = nextStatus(s, "refund_failed");
    expect(s).toBe("failed_manual_review");
  });

  it("manual_review from refund_required also routes to failed_manual_review", () => {
    let s: ShopSettlementStatus = "refund_required";
    s = nextStatus(s, "manual_review");
    expect(s).toBe("failed_manual_review");
  });

  it("admin can resolve failed_manual_review either way", () => {
    let s: ShopSettlementStatus = "failed_manual_review";
    const completed = nextStatus(s, "manual_resolved_completed");
    expect(completed).toBe("completed");
    const refunded = nextStatus(s, "manual_resolved_refunded");
    expect(refunded).toBe("refunded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation paths

describe("state machine — cancellation + expiry", () => {
  it("can cancel from quoted", () => {
    expect(nextStatus("quoted", "cancel")).toBe("cancelled");
  });

  it("can cancel from reserved", () => {
    expect(nextStatus("reserved", "cancel")).toBe("cancelled");
  });

  it("can cancel from payment_pending_signature (taker bails before signing)", () => {
    expect(nextStatus("payment_pending_signature", "cancel")).toBe("cancelled");
  });

  it("TTL expiry from reserved", () => {
    expect(nextStatus("reserved", "ttl_expired")).toBe("expired");
  });

  it("payment never sent → expired (NOT refund — funds never left taker)", () => {
    expect(nextStatus("payment_pending_signature", "payment_failed")).toBe("expired");
    expect(nextStatus("payment_broadcast", "payment_failed")).toBe("expired");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Illegal transitions — all the things that should throw

describe("state machine — illegal transitions throw", () => {
  it("cannot reserve from non-quoted", () => {
    expect(() => nextStatus("reserved", "reserve")).toThrow(IllegalTransitionError);
    expect(() => nextStatus("completed", "reserve")).toThrow(IllegalTransitionError);
  });

  it("cannot skip from payment_pending_signature directly to payment_confirmed", () => {
    expect(() =>
      nextStatus("payment_pending_signature", "payment_confirmed"),
    ).toThrow(IllegalTransitionError);
  });

  it("cannot sign release before payment is confirmed (no maker-leg-first)", () => {
    expect(() =>
      nextStatus("payment_broadcast", "maker_sign_release"),
    ).toThrow(IllegalTransitionError);
    expect(() =>
      nextStatus("reserved", "maker_sign_release"),
    ).toThrow(IllegalTransitionError);
  });

  it("cannot refund a trade that hasn't moved funds", () => {
    expect(() =>
      nextStatus("quoted", "refund_started"),
    ).toThrow(IllegalTransitionError);
    expect(() =>
      nextStatus("reserved", "refund_started"),
    ).toThrow(IllegalTransitionError);
  });

  it("terminal statuses reject all events", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(() => nextStatus(terminal, "reserve")).toThrow();
      expect(() => nextStatus(terminal, "cancel")).toThrow();
    }
  });

  it("IllegalTransitionError carries context for debugging", () => {
    try {
      nextStatus("reserved", "release_confirmed");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransitionError);
      if (e instanceof IllegalTransitionError) {
        expect(e.fromStatus).toBe("reserved");
        expect(e.event).toBe("release_confirmed");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency key construction

describe("legIdempotencyKey", () => {
  it("is deterministic for same inputs", () => {
    const a = legIdempotencyKey("abc-123", 1);
    const b = legIdempotencyKey("abc-123", 1);
    expect(a).toBe(b);
  });

  it("differs per leg number", () => {
    expect(legIdempotencyKey("abc-123", 1)).not.toBe(legIdempotencyKey("abc-123", 2));
    expect(legIdempotencyKey("abc-123", 2)).not.toBe(legIdempotencyKey("abc-123", 3));
  });

  it("differs per settlement", () => {
    expect(legIdempotencyKey("abc-123", 1)).not.toBe(legIdempotencyKey("xyz-789", 1));
  });

  it("differs per retry attempt (for recycle leg)", () => {
    expect(legIdempotencyKey("abc-123", 3, 0)).not.toBe(legIdempotencyKey("abc-123", 3, 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Leg builders — verify (signer, role, endpoint) tuples match spec

describe("leg builders", () => {
  const SETTLEMENT_UUID = "11111111-1111-4111-8111-111111111111";
  const TAKER = "0x" + "a".repeat(40);
  const MAKER = "0x" + "b".repeat(40);

  it("payment leg: taker signs, /transfer, Privy by default", () => {
    const leg = buildPaymentLeg(SETTLEMENT_UUID, TAKER, false);
    expect(leg.legNumber).toBe(1);
    expect(leg.legKind).toBe("payment");
    expect(leg.settlementEndpoint).toBe("transfer");
    expect(leg.signerAddress).toBe(TAKER);
    expect(leg.signerRole).toBe("taker_privy");
  });

  it("payment leg: taker_managed when taker has managed wallet", () => {
    const leg = buildPaymentLeg(SETTLEMENT_UUID, TAKER, true);
    expect(leg.signerRole).toBe("taker_managed");
  });

  it("release leg: maker signs, /withdraw, managed required", () => {
    const leg = buildReleaseLeg(SETTLEMENT_UUID, MAKER);
    expect(leg.legNumber).toBe(2);
    expect(leg.legKind).toBe("release");
    expect(leg.settlementEndpoint).toBe("withdraw");
    expect(leg.signerAddress).toBe(MAKER);
    expect(leg.signerRole).toBe("maker_managed");
  });

  it("recycle leg: maker signs, /deposit, managed", () => {
    const leg = buildRecycleLeg(SETTLEMENT_UUID, MAKER);
    expect(leg.legNumber).toBe(3);
    expect(leg.legKind).toBe("recycle");
    expect(leg.settlementEndpoint).toBe("deposit");
    expect(leg.signerRole).toBe("maker_managed");
  });

  it("refund leg: maker signs, /transfer, leg number 99 (out of band)", () => {
    const leg = buildRefundLeg(SETTLEMENT_UUID, MAKER);
    expect(leg.legNumber).toBe(99);
    expect(leg.legKind).toBe("refund");
    expect(leg.settlementEndpoint).toBe("transfer");
    expect(leg.signerAddress).toBe(MAKER);
    expect(leg.signerRole).toBe("maker_managed");
  });

  it("legs in retry have different idempotency keys", () => {
    const first = buildRecycleLeg(SETTLEMENT_UUID, MAKER, 0);
    const retry = buildRecycleLeg(SETTLEMENT_UUID, MAKER, 1);
    expect(first.idempotencyKey).not.toBe(retry.idempotencyKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Precheck — every failure mode the orchestrator must catch BEFORE locks

describe("precheckReserve", () => {
  const SUPPORTED = new Set(["USDT", "USDC", "XSGD"]);
  const MAKER = "0x" + "1".repeat(40);
  const TAKER = "0x" + "2".repeat(40);
  const baseInput: PrecheckInput = {
    makerVaultAvailableRaw: "1000000000",  // 1000 USDT-units
    takerWalletBalanceRaw: "1000000000",
    sellAmountRaw: "100000000",   // 100 units
    buyAmountRaw: "135000000",     // 135 units
    makerAddress: MAKER,
    takerAddress: TAKER,
    sellToken: "XSGD",
    buyToken: "USDT",
    supportedTokens: SUPPORTED,
  };

  it("passes on a clean baseline", () => {
    expect(precheckReserve(baseInput).ok).toBe(true);
  });

  it("rejects self-trade", () => {
    const d = precheckReserve({ ...baseInput, takerAddress: MAKER });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("SELF_TRADE");
  });

  it("rejects case-insensitive self-trade", () => {
    const d = precheckReserve({
      ...baseInput,
      makerAddress: MAKER.toLowerCase(),
      takerAddress: MAKER.toUpperCase(),
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("SELF_TRADE");
  });

  it("rejects unsupported sellToken", () => {
    const d = precheckReserve({ ...baseInput, sellToken: "XYZ" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("UNSUPPORTED_TOKEN");
  });

  it("rejects unsupported buyToken", () => {
    const d = precheckReserve({ ...baseInput, buyToken: "PHP" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("UNSUPPORTED_TOKEN");
  });

  it("rejects insufficient maker vault_available", () => {
    const d = precheckReserve({ ...baseInput, makerVaultAvailableRaw: "1" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("MAKER_INSUFFICIENT_VAULT");
  });

  it("rejects insufficient taker wallet", () => {
    const d = precheckReserve({ ...baseInput, takerWalletBalanceRaw: "1" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("TAKER_INSUFFICIENT_WALLET");
  });

  it("rejects rate drift > tolerance", () => {
    const d = precheckReserve({
      ...baseInput,
      currentMidRate: 1.35,
      quotedRate: 1.40,  // ~370 bps deviation
      maxRateDeviationBps: 200,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("RATE_DEVIATION_TOO_HIGH");
  });

  it("accepts rate drift within tolerance", () => {
    const d = precheckReserve({
      ...baseInput,
      currentMidRate: 1.35,
      quotedRate: 1.351,  // ~7.4 bps
      maxRateDeviationBps: 200,
    });
    expect(d.ok).toBe(true);
  });

  it("rejects when maker's managed wallet is killed", () => {
    const d = precheckReserve({
      ...baseInput,
      makerCap: {
        perTradeCapUsd: 500,
        dailyRemainingUsd: 5000,
        sellAmountUsd: 100,
        killed: true,
        allowed: true,
      },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("MAKER_WALLET_KILLED");
  });

  it("rejects when sellToken not in maker's allowlist", () => {
    const d = precheckReserve({
      ...baseInput,
      makerCap: {
        perTradeCapUsd: 500,
        dailyRemainingUsd: 5000,
        sellAmountUsd: 100,
        killed: false,
        allowed: false,
      },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("TOKEN_NOT_ALLOWED");
  });

  it("rejects when trade exceeds per-trade cap", () => {
    const d = precheckReserve({
      ...baseInput,
      makerCap: {
        perTradeCapUsd: 500,
        dailyRemainingUsd: 5000,
        sellAmountUsd: 1000,  // > 500
        killed: false,
        allowed: true,
      },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("PER_TRADE_CAP_EXCEEDED");
  });

  it("rejects when trade exceeds remaining daily cap", () => {
    const d = precheckReserve({
      ...baseInput,
      makerCap: {
        perTradeCapUsd: 5000,
        dailyRemainingUsd: 100,
        sellAmountUsd: 500,  // > 100 remaining
        killed: false,
        allowed: true,
      },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("DAILY_CAP_EXCEEDED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal-status invariant

describe("TERMINAL_STATUSES", () => {
  it("includes exactly the documented set", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      [
        "cancelled",
        "completed",
        "expired",
        "failed_manual_review",
        "refunded",
      ].sort(),
    );
  });

  it("isTerminal matches the set", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("reserved")).toBe(false);
    expect(isTerminal("payment_broadcast")).toBe(false);
  });
});
