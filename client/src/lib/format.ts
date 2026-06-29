/**
 * ─── Client-Side Formatting Utilities ────────────────────────────────────────
 *
 * Shared display helpers used across all tabs and components.
 * These run in the browser only.
 *
 * For server-side formatting, see server/lib/format.ts.
 */

/**
 * Truncates an Ethereum address for display.
 * e.g. truncateAddress("0x1234567890abcdef1234567890abcdef12345678") => "0x1234...5678"
 */
export function truncateAddress(address: string, chars = 4): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 2 + chars)}...${address.slice(-chars)}`;
}

/**
 * Formats a token amount with appropriate decimal places.
 * e.g. formatAmount("1234.5678", 2) => "1,234.57"
 */
export function formatAmount(value: string | number, decimals = 4): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "0";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(n);
}

/**
 * Formats a USD value for display.
 * e.g. formatUsd(1234.5) => "$1,234.50"
 */
export function formatUsd(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Formats a timestamp (ms since epoch or Date) to a human-readable local date/time.
 * e.g. formatDate(1700000000000) => "Nov 14, 2023, 10:13 PM"
 */
export function formatDate(timestamp: number | Date | null | undefined): string {
  if (!timestamp) return "\u2014";
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Formats a timestamp as a relative time string.
 * e.g. formatRelativeTime(Date.now() - 60000) => "1 min ago"
 */
export function formatRelativeTime(timestamp: number | Date | null | undefined): string {
  if (!timestamp) return "\u2014";
  const ms = timestamp instanceof Date ? timestamp.getTime() : timestamp;
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Returns the Etherscan URL for a transaction hash.
 * Uses Sepolia by default; pass isMainnet=true for mainnet.
 */
export function getExplorerUrl(txHash: string, isMainnet = false): string {
  const base = isMainnet ? "https://etherscan.io" : "https://sepolia.etherscan.io";
  return `${base}/tx/${txHash}`;
}
