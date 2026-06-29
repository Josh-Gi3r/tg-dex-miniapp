/**
 * ─── Server-Side Formatting Utilities ────────────────────────────────────────
 *
 * Shared number and currency formatting helpers used by router procedures.
 * These run server-side only.
 *
 * For client-side formatting, see client/src/lib/format.ts.
 */

/**
 * Formats a token amount to a human-readable string with appropriate decimals.
 * e.g. formatTokenAmount("1000000", 6) => "1.000000"
 */
export function formatTokenAmount(rawAmount: string, decimals: number): string {
  const n = BigInt(rawAmount);
  const divisor = BigInt(10 ** decimals);
  const whole = n / divisor;
  const frac = n % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  return `${whole}.${fracStr}`;
}

/**
 * Parses a human-readable token amount to raw integer string.
 * e.g. parseTokenAmount("1.5", 6) => "1500000"
 */
export function parseTokenAmount(humanAmount: string, decimals: number): string {
  const [whole, frac = ""] = humanAmount.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(whole ?? "0") * BigInt(10 ** decimals) + BigInt(fracPadded)).toString();
}

/**
 * Formats a USD value for display.
 * e.g. formatUsd("1234.5678") => "$1,234.57"
 */
export function formatUsd(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Calculates the XP level from a total XP value.
 * Matches the LEVEL_THRESHOLDS in shared/dex-api-config.ts.
 */
export function getLevel(xp: number): number {
  const thresholds = [0, 100, 300, 700, 1500, 3000, 6000, 10000, 20000, 50000];
  let level = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (xp >= (thresholds[i] ?? 0)) level = i;
  }
  return level;
}
