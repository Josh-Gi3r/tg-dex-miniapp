/**
 * ─── Settlement Venue REST API Configuration ──────────────────────────────────
 *
 * Public REST API — backs the swap, order, balance, and transfer flows.
 *
 * **Default venue adapter (set DEX_API_BASE in env — see README).**
 * Replace DEX_API_BASE in your .env to point at a different settlement venue.
 *
 * The venue runs separate hosts per network:
 *   - Testnet:  https://api-testnet.your-venue.example/api/v1   (default)
 *   - Mainnet:  https://api.your-venue.example/api/v1
 *
 * Default is testnet to match FEATURE_MAINNET=false.
 * Set DEX_API_BASE=<mainnet-url> alongside FEATURE_MAINNET=true when going live.
 */

// Placeholder URLs — set DEX_API_BASE in .env to your actual venue endpoint.
export const DEX_API_BASE_DEFAULT = "https://api-testnet.your-venue.example/api/v1";
export const DEX_API_BASE_MAINNET  = "https://api.your-venue.example/api/v1";

/**
 * Returns the configured settlement venue REST API base URL.
 * Reads DEX_API_BASE from env when set; otherwise falls back to DEX_API_BASE_DEFAULT.
 */
export function getDexApiBase(envOverride?: string): string {
  const fromEnv = envOverride?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEX_API_BASE_DEFAULT;
}

/**
 * Per-group rate limits in requests per second.
 * Tune these to match whatever venue you connect to.
 */
export const DEX_RATE_LIMITS = {
  read:     10,
  trade:     5,
  cancel:    2,
  transfer:  2,
} as const;

/**
 * Standard EIP-712 type definitions for signed settlement payloads.
 * Domain.{chainId, verifyingContract} are filled at runtime from GET /config.
 *
 * These match the default venue format.
 * If your venue uses a different signing schema, update these types and
 * the signing layer in client/src/lib/dex/signing.ts accordingly.
 */
export const DEX_EIP712_TYPES = {
  Order: [
    { name: "user",                  type: "address" },
    { name: "expiration",            type: "uint48"  },
    { name: "feeBps",                type: "uint48"  },
    { name: "recipient",             type: "address" },
    { name: "fromToken",             type: "address" },
    { name: "toToken",               type: "address" },
    { name: "fromAmount",            type: "uint256" },
    { name: "toAmount",              type: "uint256" },
    { name: "initialDepositAmount",  type: "uint256" },
    { name: "uuid",                  type: "uint256" },
  ],
  Intent: [
    { name: "taker",                 type: "address" },
    { name: "inputToken",            type: "address" },
    { name: "outputToken",           type: "address" },
    { name: "maxInputAmount",        type: "uint256" },
    { name: "minOutputAmount",       type: "uint256" },
    { name: "recipient",             type: "address" },
    { name: "initialDepositAmount",  type: "uint256" },
    { name: "uuid",                  type: "uint256" },
    { name: "deadline",              type: "uint48"  },
  ],
  CancelOrder: [
    { name: "owner",   type: "address" },
    { name: "orderId", type: "uint256" },
  ],
  CancelVLBatch: [
    { name: "owner",     type: "address" },
    { name: "vlBatchId", type: "string"  },
  ],
  WithdrawIntent: [
    { name: "user",      type: "address"   },
    { name: "tokens",    type: "address[]" },
    { name: "amounts",   type: "uint256[]" },
    { name: "recipient", type: "address"   },
    { name: "deadline",  type: "uint256"   },
    { name: "uuid",      type: "uint256"   },
  ],
  ManageApiKey: [
    { name: "owner",     type: "address" },
    { name: "action",    type: "string"  },
    { name: "timestamp", type: "uint256" },
  ],
  // Standard EIP-2612 Permit. Uses the token's own EIP-712 domain.
  Permit: [
    { name: "owner",    type: "address" },
    { name: "spender",  type: "address" },
    { name: "value",    type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Buffer between server time and signed expiration deadlines (seconds).
 * Keeps signatures safely inside the venue's accepted window.
 */
export const SIGN_EXPIRATION_BUFFER_SEC = 60;

// Re-export token helpers so consumers can import from a single config entry-point.
export { getAllTokens, getTokenBySymbol, getExplorerUrl } from "./venue-config.js";
