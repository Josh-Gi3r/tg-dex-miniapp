/**
 * ─── the venue REST API — Response Types ──────────────────────────────────────────
 *
 * Mirrors the JSON shapes documented at https://docs.example.com/api-reference.
 * Only the fields we actually consume are typed strictly; unmapped fields
 * are allowed via index signatures so we don't need to update types every
 * time the venue adds a non-breaking field.
 *
 * Snake_case is preserved exactly as the API returns it. Conversion to
 * camelCase happens at the call site if the consumer prefers.
 */

// ─── System ──────────────────────────────────────────────────────────────────

export interface VenueHealth {
  status: "healthy" | "degraded";
  version: string;
  timestamp: string;
  executor_id: number;
  relayer_executor_id: number | null;
  signature_ready: boolean;
}

export interface VenueSystemTime {
  timestamp: number;
}

export interface VenueConfig {
  chain_id: number;
  venue_address: string;
  vault_address: string;
  sor_address: string;
  domain_separator: string;
  eip712_domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  limits?: {
    vl_batch?: { min: number; max: number };
  };
}

// ─── Tokens & Markets ────────────────────────────────────────────────────────

export interface VenueToken {
  currency: string; // ISO code (USD, EUR, SGD…)
  symbol: string;
  address: string;
  decimals: number;
  min_trade_amount_raw: string;
  min_trade_amount: string;
}

export interface VenueTokensResponse {
  tokens: VenueToken[];
}

export interface VenueMarket {
  symbol: string; // e.g. "EURC/USDC"
  base_symbol: string;
  quote_symbol: string;
  base_address: string;
  quote_address: string;
  tick_precision: number;
  quantity_precision: number;
  base_decimals: number;
  quote_decimals: number;
  min_ask_amount_raw: string;
  min_ask_amount: string;
  min_bid_quote_amount_raw: string;
  min_bid_quote_amount: string;
}

export interface VenueMarketsResponse {
  markets: VenueMarket[];
}

// ─── FX Rate ─────────────────────────────────────────────────────────────────

export interface VenueFxRate {
  pair: string;
  rate: string;
  as_of: number | null;
  rate_24h_ago: string | null;
  as_of_24h_ago: number | null;
  change_pct: string | null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Documented public error codes from the venue (Order/Swap envelopes share most).
 * Anything not in this set collapses to TRANSIENT_SETTLEMENT_FAILURE.
 */
export type VenueErrorCode =
  | "ALLOWANCE_INSUFFICIENT"
  | "INTENT_DEADLINE_EXPIRED"
  | "SLIPPAGE_EXCEEDED"
  | "NO_LIQUIDITY"
  | "QUOTE_STALE"
  | "AMOUNT_BELOW_MIN"
  | "STP_BLOCKED"
  | "TRANSIENT_SETTLEMENT_FAILURE";

export interface VenueErrorEnvelope {
  detail: string;
  error_code?: VenueErrorCode | string;
}

// ─── Common request-builder return type ─────────────────────────────────────

export interface VenueUnsignedTx {
  to: string;
  data: string;
  value: string; // hex
  chainId: string; // hex
  nonce: string; // hex
  gas: string; // hex
  type: string; // hex (e.g. "0x2")
  maxFeePerGas: string; // hex
  maxPriorityFeePerGas: string; // hex
}
