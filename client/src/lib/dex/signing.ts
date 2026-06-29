/**
 * ─── the venue EIP-712 Signing Builders ───────────────────────────────────────────
 *
 * Builds the {domain, types, primaryType, message} payloads that get fed to
 * `useVenueWallet().signTypedData(...)`. The payload is sent as-is to the
 * underlying Privy/external wallet via `eth_signTypedData_v4`.
 *
 * Domain values (chainId, verifyingContract, name, version) come from
 * GET /config — fetched once on bootstrap and cached.
 *
 * Helper note: amounts are passed as strings (not bigints) because the
 * structured-clone barrier in `eth_signTypedData_v4` rejects bigint values.
 * The wallet hex-encodes them internally based on the type definition.
 */

import { DEX_EIP712_TYPES, SIGN_EXPIRATION_BUFFER_SEC } from "@shared/dex-api-config";

export interface VenueDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

// ─── Order (limit order placement) ───────────────────────────────────────────

export interface OrderTypedData {
  user: string;
  expiration: number;        // unix seconds
  feeBps: number;            // protocol fee in basis points
  recipient: string;         // address that receives the fill
  fromToken: string;
  toToken: string;
  fromAmount: string;        // raw uint256 as decimal string
  toAmount: string;          // raw uint256 as decimal string
  initialDepositAmount: string;
  uuid: string;              // packed via encodeStandalone — passed as decimal string
}

export function buildOrderTypedData(domain: VenueDomain, message: OrderTypedData) {
  return {
    domain,
    types: { Order: DEX_EIP712_TYPES.Order },
    primaryType: "Order" as const,
    message,
  };
}

// ─── Intent (Take an Offer / Swap) ───────────────────────────────────────────

export interface IntentTypedData {
  taker: string;
  inputToken: string;
  outputToken: string;
  maxInputAmount: string;
  minOutputAmount: string;
  recipient: string;
  initialDepositAmount: string;
  uuid: string;
  deadline: number;          // unix seconds
}

export function buildIntentTypedData(domain: VenueDomain, message: IntentTypedData) {
  return {
    domain,
    types: { Intent: DEX_EIP712_TYPES.Intent },
    primaryType: "Intent" as const,
    message,
  };
}

// ─── CancelOrder ─────────────────────────────────────────────────────────────

export interface CancelOrderTypedData {
  owner: string;
  orderId: string;           // packed uuid_int as decimal
}

export function buildCancelOrderTypedData(
  domain: VenueDomain,
  message: CancelOrderTypedData,
) {
  return {
    domain,
    types: { CancelOrder: DEX_EIP712_TYPES.CancelOrder },
    primaryType: "CancelOrder" as const,
    message,
  };
}

// ─── CancelVLBatch ───────────────────────────────────────────────────────────

export interface CancelVLBatchTypedData {
  owner: string;
  vlBatchId: string;         // server-assigned string identifier
}

export function buildCancelVLBatchTypedData(
  domain: VenueDomain,
  message: CancelVLBatchTypedData,
) {
  return {
    domain,
    types: { CancelVLBatch: DEX_EIP712_TYPES.CancelVLBatch },
    primaryType: "CancelVLBatch" as const,
    message,
  };
}

// ─── WithdrawIntent ──────────────────────────────────────────────────────────

export interface WithdrawIntentTypedData {
  user: string;
  tokens: string[];
  amounts: string[];         // each uint256 as decimal
  recipient: string;
  deadline: string;          // uint256 as decimal
  uuid: string;              // uint256 as decimal
}

export function buildWithdrawIntentTypedData(
  domain: VenueDomain,
  message: WithdrawIntentTypedData,
) {
  return {
    domain,
    types: { WithdrawIntent: DEX_EIP712_TYPES.WithdrawIntent },
    primaryType: "WithdrawIntent" as const,
    message,
  };
}

// ─── ManageApiKey ────────────────────────────────────────────────────────────

export interface ManageApiKeyTypedData {
  owner: string;
  action: "create" | "rotate" | "revoke";
  timestamp: string;         // uint256 as decimal
}

export function buildManageApiKeyTypedData(
  domain: VenueDomain,
  message: ManageApiKeyTypedData,
) {
  return {
    domain,
    types: { ManageApiKey: DEX_EIP712_TYPES.ManageApiKey },
    primaryType: "ManageApiKey" as const,
    message,
  };
}

// ─── Permit (EIP-2612) ───────────────────────────────────────────────────────

export interface PermitTypedData {
  owner: string;
  spender: string;
  value: string;          // uint256 as decimal
  nonce: string;          // uint256 as decimal (from /permit/metadata)
  deadline: string;       // uint256 as decimal — unix seconds
}

/**
 * Builds an EIP-2612 Permit signature payload. The token's own EIP-712 domain
 * (name, version, chainId, verifyingContract) comes from GET /permit/metadata,
 * NOT from the venue's domain.
 */
export function buildPermitTypedData(
  tokenDomain: { name: string; version: string; chainId: number; verifyingContract: string },
  message: PermitTypedData,
) {
  return {
    domain: tokenDomain,
    types: { Permit: DEX_EIP712_TYPES.Permit },
    primaryType: "Permit" as const,
    message,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a deadline N seconds in the future, clamped against any server-time
 * skew. Uses the configured buffer to stay safely inside the venue's 5-minute
 * minimum on signed deadlines.
 */
export function deadlineFromNow(ttlSeconds: number, serverTimeNow?: number): number {
  const now = serverTimeNow ?? Math.floor(Date.now() / 1000);
  return now + Math.max(SIGN_EXPIRATION_BUFFER_SEC, ttlSeconds);
}
