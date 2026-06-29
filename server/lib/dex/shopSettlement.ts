/**
 * ─── Shop Settlement Orchestrator ────────────────────────────────────────────
 *
 * Coordinated 3-leg stablecoin trade between a shopkeeper (maker) and a
 * taker. Implements the state machine specified in SPEC.md §10.2.
 *
 * Settlement order (LOAD-BEARING — risk-safe order):
 *   1. taker pays maker wallet      (the venue /transfer)
 *   2. maker withdraws vault → taker (the venue /withdraw 3-step)
 *   3. maker recycles received      (the venue /deposit)
 *
 * Why this order: if leg 2 fails after leg 1 succeeds, the maker has
 * the taker's payment in wallet (recoverable, refundable). Maker's
 * vault inventory is never debited until taker's payment lands.
 *
 * Not atomic at the protocol level — coordinated. State machine + refund
 * worker is what makes it feel atomic to the user.
 *
 * The pure state-transition logic lives in this file. Side effects
 * (the venue API calls, DB writes, signing) are injected as a `Deps` interface
 * so the core can be unit-tested without the venue/DB.
 */

import { randomUUID } from "node:crypto";

import type {
  ShopSettlement,
  ShopSettlementLeg,
  ShopSettlementStatus,
} from "../../../drizzle/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Pure types

export type SignerRole = "taker_privy" | "taker_managed" | "maker_managed";
export type LegKind = "payment" | "release" | "recycle" | "refund";
export type SettlementEndpoint = "transfer" | "withdraw" | "deposit";
export type LegStatus = "pending_signature" | "broadcast" | "confirmed" | "failed";

export interface ReserveRequest {
  adId: number;
  makerUserId: number;
  takerUserId: number;
  makerAddress: string;
  takerAddress: string;
  sellToken: string;       // symbol, e.g. "XSGD" (maker pays out)
  buyToken: string;        // symbol, e.g. "USDT" (taker pays)
  sellAmountRaw: string;   // uint256 string
  buyAmountRaw: string;
  // Token decimals snapshot at reserve time (from the venue /tokens).
  // Workers MUST read these from the persisted settlement row, never guess.
  // ARC has 2 decimals; defaulting to 6 mis-credits 10,000× (audit blocker #2).
  sellDecimals: number;
  buyDecimals: number;
  rateUsed: string;        // decimal string with 8 places
  ttlSeconds?: number;     // default 90s per SPEC
}

export interface ReserveResult {
  settlementId: number;
  settlementUuid: string;
  status: ShopSettlementStatus;
  reservedUntil: Date;
}

export interface LegBroadcastResult {
  legId: number;
  txHash: string;
  legNumber: number;
}

export interface SettlementSnapshot {
  settlement: ShopSettlement;
  legs: ShopSettlementLeg[];
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine — pure functions, no side effects

/**
 * Allowed state transitions per SPEC §10.2. Throws on illegal transitions.
 * Returns the new status if valid.
 */
export function nextStatus(
  current: ShopSettlementStatus,
  event: SettlementEvent,
): ShopSettlementStatus {
  const map: Record<ShopSettlementStatus, Partial<Record<SettlementEvent, ShopSettlementStatus>>> = {
    quoted: {
      reserve: "reserved",
      cancel: "cancelled",
    },
    reserved: {
      taker_sign_payment: "payment_pending_signature",
      cancel: "cancelled",
      ttl_expired: "expired",
    },
    payment_pending_signature: {
      payment_broadcast: "payment_broadcast",
      cancel: "cancelled",
      payment_failed: "expired", // payment never sent, release locks
    },
    payment_broadcast: {
      payment_confirmed: "payment_confirmed",
      payment_failed: "expired",
    },
    payment_confirmed: {
      maker_sign_release: "release_pending_signature",
      release_failed: "refund_required",
    },
    release_pending_signature: {
      release_broadcast: "release_broadcast",
      release_failed: "refund_required",
    },
    release_broadcast: {
      release_confirmed: "release_confirmed",
      release_failed: "refund_required",
    },
    release_confirmed: {
      recycle_started: "recycle_pending",
      // If we skip recycle (e.g. maker explicitly opts out), go straight to completed.
      // The funds just sit in maker's wallet — not lost, just not auto-deposited.
      skip_recycle: "completed",
    },
    recycle_pending: {
      recycle_confirmed: "completed",
      recycle_failed: "completed", // taker leg already settled; recycle is best-effort, retryable
    },
    completed: {},
    expired: {},
    cancelled: {},
    refund_required: {
      refund_started: "refund_pending",
      manual_review: "failed_manual_review",
    },
    refund_pending: {
      refund_confirmed: "refunded",
      refund_failed: "failed_manual_review",
    },
    refunded: {},
    failed_manual_review: {
      manual_resolved_completed: "completed",
      manual_resolved_refunded: "refunded",
    },
  };

  const allowed = map[current];
  const next = allowed[event];
  if (!next) {
    throw new IllegalTransitionError(
      `Cannot transition from ${current} via event ${event}`,
      current,
      event,
    );
  }
  return next;
}

export type SettlementEvent =
  | "reserve"
  | "taker_sign_payment"
  | "payment_broadcast"
  | "payment_confirmed"
  | "payment_failed"
  | "maker_sign_release"
  | "release_broadcast"
  | "release_confirmed"
  | "release_failed"
  | "recycle_started"
  | "recycle_confirmed"
  | "recycle_failed"
  | "skip_recycle"
  | "cancel"
  | "ttl_expired"
  | "refund_started"
  | "refund_confirmed"
  | "refund_failed"
  | "manual_review"
  | "manual_resolved_completed"
  | "manual_resolved_refunded";

export class IllegalTransitionError extends Error {
  constructor(
    msg: string,
    public readonly fromStatus: ShopSettlementStatus,
    public readonly event: SettlementEvent,
  ) {
    super(msg);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Terminal states — no further transitions possible. Used by the worker
 * to skip already-finished settlements.
 */
export const TERMINAL_STATUSES: ReadonlySet<ShopSettlementStatus> = new Set([
  "completed",
  "expired",
  "cancelled",
  "refunded",
  "failed_manual_review",
]);

export function isTerminal(s: ShopSettlementStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

/**
 * Generate a unique idempotency key for a settlement leg. Caller passes the
 * settlement uuid + leg number + a uniqueness nonce. Collisions are
 * impossible if the inputs are unique within (uuid, legNumber).
 */
export function legIdempotencyKey(
  settlementUuid: string,
  legNumber: number,
  attempt = 0,
): string {
  return `${settlementUuid}:${legNumber}:${attempt}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-check policy — runs before reserve. Returns a structured decision.

export interface PrecheckInput {
  makerVaultAvailableRaw: string;    // maker's vault_available for sellToken
  takerWalletBalanceRaw: string;     // taker's wallet balance for buyToken
  sellAmountRaw: string;
  buyAmountRaw: string;
  makerAddress: string;
  takerAddress: string;
  sellToken: string;
  buyToken: string;
  // the venue-supported token list (symbols)
  supportedTokens: ReadonlySet<string>;
  // Optional: current market mid rate to verify quoted rate is within tolerance.
  // Pass undefined to skip rate-deviation check.
  currentMidRate?: number;
  quotedRate?: number;
  maxRateDeviationBps?: number;  // default 200 (2%)
  // Managed-wallet caps if maker is using one
  makerCap?: {
    perTradeCapUsd: number;
    dailyRemainingUsd: number;
    sellAmountUsd: number;
    killed: boolean;
    allowed: boolean;  // sellToken in token_allowlist
  };
}

export type PrecheckDecision =
  | { ok: true }
  | { ok: false; code: PrecheckFailCode; detail: string };

export type PrecheckFailCode =
  | "MAKER_INSUFFICIENT_VAULT"
  | "TAKER_INSUFFICIENT_WALLET"
  | "SELF_TRADE"
  | "UNSUPPORTED_TOKEN"
  | "RATE_DEVIATION_TOO_HIGH"
  | "MAKER_WALLET_KILLED"
  | "TOKEN_NOT_ALLOWED"
  | "PER_TRADE_CAP_EXCEEDED"
  | "DAILY_CAP_EXCEEDED";

export function precheckReserve(input: PrecheckInput): PrecheckDecision {
  // Self-trade check
  if (input.makerAddress.toLowerCase() === input.takerAddress.toLowerCase()) {
    return { ok: false, code: "SELF_TRADE", detail: "Maker and taker share the same wallet" };
  }
  // Token support
  if (!input.supportedTokens.has(input.sellToken)) {
    return { ok: false, code: "UNSUPPORTED_TOKEN", detail: `${input.sellToken} not in the venue /tokens` };
  }
  if (!input.supportedTokens.has(input.buyToken)) {
    return { ok: false, code: "UNSUPPORTED_TOKEN", detail: `${input.buyToken} not in the venue /tokens` };
  }
  // Vault inventory
  if (BigInt(input.makerVaultAvailableRaw) < BigInt(input.sellAmountRaw)) {
    return {
      ok: false,
      code: "MAKER_INSUFFICIENT_VAULT",
      detail: `Maker vault_available ${input.makerVaultAvailableRaw} < required ${input.sellAmountRaw}`,
    };
  }
  // Taker wallet balance
  if (BigInt(input.takerWalletBalanceRaw) < BigInt(input.buyAmountRaw)) {
    return {
      ok: false,
      code: "TAKER_INSUFFICIENT_WALLET",
      detail: `Taker wallet ${input.takerWalletBalanceRaw} < required ${input.buyAmountRaw}`,
    };
  }
  // Rate deviation
  if (
    input.currentMidRate !== undefined &&
    input.quotedRate !== undefined &&
    input.maxRateDeviationBps !== undefined
  ) {
    const drift = Math.abs(input.quotedRate - input.currentMidRate) / input.currentMidRate;
    if (drift * 10000 > input.maxRateDeviationBps) {
      return {
        ok: false,
        code: "RATE_DEVIATION_TOO_HIGH",
        detail: `Quoted rate ${input.quotedRate} deviates ${(drift * 10000).toFixed(0)}bps from mid ${input.currentMidRate} (cap ${input.maxRateDeviationBps}bps)`,
      };
    }
  }
  // Managed-wallet caps (if maker is using one)
  if (input.makerCap) {
    if (input.makerCap.killed) {
      return { ok: false, code: "MAKER_WALLET_KILLED", detail: "Maker's managed wallet is killed" };
    }
    if (!input.makerCap.allowed) {
      return { ok: false, code: "TOKEN_NOT_ALLOWED", detail: `${input.sellToken} not in maker's allowlist` };
    }
    if (input.makerCap.sellAmountUsd > input.makerCap.perTradeCapUsd) {
      return {
        ok: false,
        code: "PER_TRADE_CAP_EXCEEDED",
        detail: `Trade size $${input.makerCap.sellAmountUsd.toFixed(2)} > per-trade cap $${input.makerCap.perTradeCapUsd.toFixed(2)}`,
      };
    }
    if (input.makerCap.sellAmountUsd > input.makerCap.dailyRemainingUsd) {
      return {
        ok: false,
        code: "DAILY_CAP_EXCEEDED",
        detail: `Trade size $${input.makerCap.sellAmountUsd.toFixed(2)} exceeds remaining daily cap $${input.makerCap.dailyRemainingUsd.toFixed(2)}`,
      };
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps interface for the orchestrator. Real impls in shopSettlementService.ts;
// tests inject mocks.

export interface ShopSettlementDeps {
  /** Insert + return new settlement row. Validates settlement_uuid uniqueness. */
  insertSettlement(input: ReserveRequest & { uuid: string; reservedUntil: Date }): Promise<{ id: number }>;
  /** Atomically advance status with optimistic check that current matches `expectedFrom`. */
  advanceStatus(
    settlementId: number,
    expectedFrom: ShopSettlementStatus,
    to: ShopSettlementStatus,
    extra?: { failureCode?: string; failureDetail?: string; completedAt?: Date },
  ): Promise<boolean>;
  /** Insert a leg row. Throws on idempotency key collision. */
  insertLeg(input: {
    settlementId: number;
    legNumber: number;
    legKind: LegKind;
    settlementEndpoint: SettlementEndpoint;
    idempotencyKey: string;
    signerAddress: string;
    signerRole: SignerRole;
  }): Promise<{ id: number }>;
  /** Update a leg row (broadcast / confirmed / failed). */
  updateLeg(
    legId: number,
    fields: Partial<{
      status: LegStatus;
      txHash: string;
      blockNumber: number;
      gasUsed: number;
      failureCode: string;
      failureDetail: string;
      broadcastAt: Date;
      confirmedAt: Date;
    }>,
  ): Promise<void>;
  /** Read settlement + its legs. */
  loadSettlement(idOrUuid: number | string): Promise<SettlementSnapshot | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserve — first step. Pure-orchestration; no the venue calls yet.

export async function reserveSettlement(
  req: ReserveRequest,
  deps: ShopSettlementDeps,
): Promise<ReserveResult> {
  const uuid = randomUUID();
  const ttlMs = (req.ttlSeconds ?? 90) * 1000;
  const reservedUntil = new Date(Date.now() + ttlMs);

  const { id } = await deps.insertSettlement({ ...req, uuid, reservedUntil });

  // Insert created at status=quoted, immediately advance to reserved
  await deps.advanceStatus(id, "quoted", "reserved");

  return {
    settlementId: id,
    settlementUuid: uuid,
    status: "reserved",
    reservedUntil,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legs — each is a pure plumbing function around deps. The actual the venue calls
// live in the higher-level service that injects deps.

export function buildPaymentLeg(
  settlementUuid: string,
  takerAddress: string,
  isManagedTaker: boolean,
): {
  legNumber: number;
  legKind: LegKind;
  settlementEndpoint: SettlementEndpoint;
  idempotencyKey: string;
  signerAddress: string;
  signerRole: SignerRole;
} {
  return {
    legNumber: 1,
    legKind: "payment",
    settlementEndpoint: "transfer",
    idempotencyKey: legIdempotencyKey(settlementUuid, 1),
    signerAddress: takerAddress,
    signerRole: isManagedTaker ? "taker_managed" : "taker_privy",
  };
}

export function buildReleaseLeg(
  settlementUuid: string,
  makerAddress: string,
): {
  legNumber: number;
  legKind: LegKind;
  settlementEndpoint: SettlementEndpoint;
  idempotencyKey: string;
  signerAddress: string;
  signerRole: SignerRole;
} {
  return {
    legNumber: 2,
    legKind: "release",
    settlementEndpoint: "withdraw",
    idempotencyKey: legIdempotencyKey(settlementUuid, 2),
    signerAddress: makerAddress,
    signerRole: "maker_managed",
  };
}

export function buildRecycleLeg(
  settlementUuid: string,
  makerAddress: string,
  attempt = 0,
): {
  legNumber: number;
  legKind: LegKind;
  settlementEndpoint: SettlementEndpoint;
  idempotencyKey: string;
  signerAddress: string;
  signerRole: SignerRole;
} {
  return {
    legNumber: 3,
    legKind: "recycle",
    settlementEndpoint: "deposit",
    idempotencyKey: legIdempotencyKey(settlementUuid, 3, attempt),
    signerAddress: makerAddress,
    signerRole: "maker_managed",
  };
}

export function buildRefundLeg(
  settlementUuid: string,
  makerAddress: string,
): {
  legNumber: number;
  legKind: LegKind;
  settlementEndpoint: SettlementEndpoint;
  idempotencyKey: string;
  signerAddress: string;
  signerRole: SignerRole;
} {
  return {
    legNumber: 99,
    legKind: "refund",
    settlementEndpoint: "transfer",
    idempotencyKey: legIdempotencyKey(settlementUuid, 99),
    signerAddress: makerAddress,
    signerRole: "maker_managed",
  };
}
