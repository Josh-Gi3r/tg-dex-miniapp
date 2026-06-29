/**
 * ─── Token Symbol Resolution ─────────────────────────────────────────────────
 *
 * Maps the UI symbols (USDT, XSGD, MYRC, …) to the contract addresses the venue
 * uses on the active chain. Resolution order:
 *   1. Live list from dex.tokens query (populated by GET /tokens)
 *   2. Static fallback in shared/dex-api-config.ts (Sepolia testnet)
 *
 * Returned info also includes decimals so callers can convert human amounts
 * to raw uint256 values for signed payloads.
 */

import { SUPPORTED_TOKENS, type TokenSymbol } from "@shared/venue-config";

export interface ResolvedToken {
  symbol: string;
  address: string;
  decimals: number;
  currency: string;
}

/**
 * Resolves a symbol against a the venue-tokens response (or null when the query
 * hasn't loaded yet). Falls back to the static SUPPORTED_TOKENS map.
 */
export function resolveToken(
  symbol: string,
  liveTokens?: Array<{ symbol: string; address: string; decimals: number; currency: string }> | null,
): ResolvedToken | null {
  const upper = symbol.toUpperCase();
  if (liveTokens?.length) {
    const live = liveTokens.find((t) => t.symbol.toUpperCase() === upper);
    if (live) {
      return {
        symbol: live.symbol,
        address: live.address,
        decimals: live.decimals,
        currency: live.currency,
      };
    }
  }
  const fallback = SUPPORTED_TOKENS[upper as TokenSymbol];
  if (fallback) {
    return {
      symbol: fallback.symbol,
      address: fallback.address,
      decimals: fallback.decimals,
      currency: fallback.currency,
    };
  }
  return null;
}

/**
 * Converts a human-readable amount ("1.5", "100") to a raw uint256 string
 * ("1500000", "100000000") given the token's decimal precision.
 *
 * Uses a string-multiplication path to avoid floating-point drift on amounts
 * with > ~7 significant digits.
 */
export function toRawAmount(human: string | number, decimals: number): string {
  const s = typeof human === "number" ? String(human) : human.trim();
  if (!s || isNaN(Number(s))) return "0";

  const negative = s.startsWith("-");
  const abs = negative ? s.slice(1) : s;
  const [intPart, fracPart = ""] = abs.split(".");
  const truncFrac = fracPart.slice(0, decimals);
  const paddedFrac = truncFrac.padEnd(decimals, "0");
  // Strip leading zeros from int part (but keep at least one digit)
  const cleanInt = (intPart ?? "0").replace(/^0+(?=\d)/, "");
  const combined = (cleanInt + paddedFrac).replace(/^0+(?=\d)/, "") || "0";
  return negative ? `-${combined}` : combined;
}

/**
 * Inverse of toRawAmount — converts a raw uint256 string back to a
 * human-readable string for display. Trims trailing zeros.
 */
export function fromRawAmount(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const abs = negative ? raw.slice(1) : raw;
  const padded = abs.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}
