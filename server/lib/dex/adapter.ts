/**
 * ─── Settlement Venue Adapter Interface ──────────────────────────────────────
 *
 * Defines the contract that any settlement venue must satisfy.
 * The default implementation (DexClient in ./client.ts) targets the
 * the venue Protocol venue. To connect a different venue:
 *
 *   1. Implement SettlementAdapter.
 *   2. Return your implementation from getSettlementAdapter() below.
 *   3. All server-side settlement code already depends only on this interface.
 *
 * On-chain types (Vault address, EIP-712 domain) are fetched dynamically from
 * the venue's GET /config — never hardcode them in this file.
 */

export interface VenueConfig {
  /** EIP-712 domain returned by the venue's GET /config */
  eip712_domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  /** Vault contract address (spender for ERC-20 approvals) */
  vault_address: string;
  /** Executor ID (required for order submission on some venues) */
  executor_id?: number;
}

export interface VenueHealth {
  status: string;
  executor_id?: number;
}

export interface VenueToken {
  symbol: string;
  address: string;
  decimals: number;
  currency?: string;
  name?: string;
}

export interface VenueTokensResponse {
  tokens: VenueToken[];
}

export interface VenueMarketsResponse {
  markets: Array<{
    base_symbol?: string;
    quote_symbol?: string;
    [key: string]: unknown;
  }>;
}

export interface VenueFxRate {
  base: string;
  quote: string;
  rate: string;
  timestamp?: number;
}

export interface VenueAuthCreds {
  apiKey: string;
  apiSecret: string;
}

export interface VenueBalance {
  token: string;
  symbol: string;
  decimals: number;
  wallet_balance: string;
  vault_available: string;
  vault_frozen: string;
  vault_total: string;
  total: string;
}

/**
 * Minimum interface a settlement venue adapter must implement.
 * The DexClient default covers the full the venue Protocol surface.
 * Implementors may add extra methods; the core app only requires these.
 */
export interface SettlementAdapter {
  /** Bootstrap — fetches /health and /config once, caches for process lifetime. */
  bootstrap(): Promise<{ health: VenueHealth; config: VenueConfig }>;

  /** Returns the venue's on-chain config (contracts + EIP-712 domain). */
  getConfig(): Promise<VenueConfig>;

  /** Returns live FX rate. null = no provider data within recency window. */
  getFxRate(base: string, quote: string): Promise<VenueFxRate | null>;

  /** Returns available tokens (live, cached for short TTL). */
  getTokens(): Promise<VenueTokensResponse>;

  /** Returns wallet + vault balances for an owner address (authenticated). */
  getBalances(
    ownerAddress: string,
    creds: VenueAuthCreds,
  ): Promise<{ owner_address: string; balances: VenueBalance[] }>;

  /** POST to the venue API (for order submission, deposits, etc.). */
  post<T>(path: string, body: unknown, creds?: VenueAuthCreds): Promise<T>;

  /** Generic authenticated GET. */
  call<T>(path: string, opts: { method: "GET" | "POST" | "DELETE"; auth?: VenueAuthCreds; query?: Record<string, string | number | undefined> }): Promise<T>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────
//
// Swap this function to use a different venue adapter.
// The DexClient is imported lazily to avoid the circular bootstrap problem.

let _adapter: SettlementAdapter | null = null;

export function getSettlementAdapter(): SettlementAdapter {
  if (!_adapter) {
    // Default: DexClient (the venue Protocol venue).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDexClient } = require("./client");
    _adapter = getDexClient() as SettlementAdapter;
  }
  return _adapter;
}

/** Override the adapter (useful in tests or when wiring a custom venue). */
export function setSettlementAdapter(adapter: SettlementAdapter): void {
  _adapter = adapter;
}
