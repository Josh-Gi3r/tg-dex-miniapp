/**
 * ─── Peer (zkP2P) shared config ──────────────────────────────────────────────
 *
 * Constants + types shared by client and server for the Peer fiat ⇄ crypto
 * ramp. SAFE for client import — no secrets, no server-only deps.
 *
 * Peer/zkP2P settles on **Base mainnet (8453)** in USDC. There is NO testnet:
 * `production` / `preproduction` / `staging` are all chain 8453 (staging only
 * swaps the API host). See docs/PEER_INTEGRATION.md.
 *
 * Decimals (do NOT mix): USDC = 6, conversion rates = 18.
 */

// ─── Chain + token ────────────────────────────────────────────────────────────

export const PEER_CHAIN_ID = 8453; // Base mainnet
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** `toToken` format = `chainId:tokenAddress` (zero address = native). */
export function toToken(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress}`;
}
export const USDC_BASE_TOTOKEN = toToken(PEER_CHAIN_ID, USDC_BASE);

// ─── Runtime env + service roots ──────────────────────────────────────────────
// Default to STAGING so nothing built here can touch production liquidity until
// Josh explicitly flips it. `environment="staging"` does NOT rewrite baseApiUrl,
// so we pass the staging host explicitly (a documented gotcha).

export type PeerRuntimeEnv = "production" | "preproduction" | "staging";

export const PEER_SERVICE_ROOTS: Record<
  PeerRuntimeEnv,
  { baseApiUrl: string; attestationServiceUrl: string }
> = {
  production: {
    baseApiUrl: "https://api.zkp2p.xyz",
    attestationServiceUrl: "https://attestation-service.zkp2p.xyz",
  },
  preproduction: {
    baseApiUrl: "https://api-staging.zkp2p.xyz",
    attestationServiceUrl: "https://attestation-service-preprod.zkp2p.xyz",
  },
  staging: {
    baseApiUrl: "https://api-staging.zkp2p.xyz",
    attestationServiceUrl: "https://attestation-service-preprod.zkp2p.xyz",
  },
};

// ─── Payment platforms ────────────────────────────────────────────────────────
// Keys are the canonical zkP2P processor names. `needsTakerRegistration` =
// platforms that require a one-time identity attestation before a taker is
// accepted. `offchainIdHint` documents the payeeData.offchainId format.

export interface PeerPaymentPlatform {
  key: string;
  displayName: string;
  /** Fiat currencies this platform commonly settles. First = default. */
  currencies: string[];
  needsTakerRegistration: boolean;
  offchainIdHint: string;
}

export const PEER_PAYMENT_PLATFORMS: PeerPaymentPlatform[] = [
  { key: "wise", displayName: "Wise", currencies: ["USD", "EUR", "GBP", "SGD", "AUD"], needsTakerRegistration: true, offchainIdHint: "Wisetag without @" },
  { key: "revolut", displayName: "Revolut", currencies: ["USD", "EUR", "GBP"], needsTakerRegistration: true, offchainIdHint: "Revtag without @" },
  { key: "venmo", displayName: "Venmo", currencies: ["USD"], needsTakerRegistration: true, offchainIdHint: "Venmo username, exact casing, no @" },
  { key: "cashapp", displayName: "Cash App", currencies: ["USD"], needsTakerRegistration: false, offchainIdHint: "cashtag without $" },
  { key: "paypal", displayName: "PayPal", currencies: ["USD", "EUR", "GBP"], needsTakerRegistration: true, offchainIdHint: "paypal.me username (no prefix)" },
  { key: "zelle", displayName: "Zelle", currencies: ["USD"], needsTakerRegistration: false, offchainIdHint: "lowercase email" },
  { key: "monzo", displayName: "Monzo", currencies: ["GBP"], needsTakerRegistration: false, offchainIdHint: "monzo.me name" },
  { key: "mercadopago", displayName: "Mercado Pago", currencies: ["ARS", "BRL", "MXN"], needsTakerRegistration: false, offchainIdHint: "22-digit CVU" },
  { key: "chime", displayName: "Chime", currencies: ["USD"], needsTakerRegistration: false, offchainIdHint: "$chimesign lowercase" },
  { key: "n26", displayName: "N26", currencies: ["EUR"], needsTakerRegistration: false, offchainIdHint: "IBAN, spaces removed" },
];

export const PEER_PLATFORM_KEYS = PEER_PAYMENT_PLATFORMS.map((p) => p.key);

export function peerPlatform(key: string): PeerPaymentPlatform | undefined {
  return PEER_PAYMENT_PLATFORMS.find((p) => p.key === key);
}

// ─── Fiat currencies ──────────────────────────────────────────────────────────

export interface PeerFiatCurrency {
  code: string;
  symbol: string;
  flag: string;
  name: string;
}

export const PEER_FIAT_CURRENCIES: PeerFiatCurrency[] = [
  { code: "USD", symbol: "$", flag: "🇺🇸", name: "US Dollar" },
  { code: "EUR", symbol: "€", flag: "🇪🇺", name: "Euro" },
  { code: "GBP", symbol: "£", flag: "🇬🇧", name: "British Pound" },
  { code: "SGD", symbol: "S$", flag: "🇸🇬", name: "Singapore Dollar" },
  { code: "AUD", symbol: "A$", flag: "🇦🇺", name: "Australian Dollar" },
  { code: "ARS", symbol: "$", flag: "🇦🇷", name: "Argentine Peso" },
  { code: "BRL", symbol: "R$", flag: "🇧🇷", name: "Brazilian Real" },
  { code: "MXN", symbol: "$", flag: "🇲🇽", name: "Mexican Peso" },
];

export function peerFiat(code: string): PeerFiatCurrency | undefined {
  return PEER_FIAT_CURRENCIES.find((c) => c.code === code);
}

/** Platforms that can settle a given fiat currency. */
export function platformsForCurrency(code: string): PeerPaymentPlatform[] {
  return PEER_PAYMENT_PLATFORMS.filter((p) => p.currencies.includes(code));
}

// ─── Decimal helpers ──────────────────────────────────────────────────────────

export const USDC_DECIMALS = 6;
export const RATE_DECIMALS = 18;

/** "100.5" USDC → 100500000n base units (6 dp). */
export function usdcToBaseUnits(human: string | number): bigint {
  return parseUnits(String(human), USDC_DECIMALS);
}
/** 100500000n → "100.5". */
export function baseUnitsToUsdc(base: bigint | string): string {
  return formatUnits(BigInt(base), USDC_DECIMALS);
}
/** "1.02" → 1020000000000000000n (18 dp). */
export function rateTo18(human: string | number): bigint {
  return parseUnits(String(human), RATE_DECIMALS);
}
/** 1020000000000000000n → "1.02". */
export function rateFrom18(base: bigint | string): string {
  return formatUnits(BigInt(base), RATE_DECIMALS);
}

// Local parse/format so this file stays dependency-free on the client.
function parseUnits(value: string, decimals: number): bigint {
  const neg = value.startsWith("-");
  const v = neg ? value.slice(1) : value;
  const [whole, frac = ""] = v.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const digits = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  const out = BigInt(digits || "0");
  return neg ? -out : out;
}
function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = (neg ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = v.slice(0, v.length - decimals);
  const frac = v.slice(v.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

// ─── State machine ────────────────────────────────────────────────────────────

export type PeerSide = "onramp" | "offramp";

/** UI/DB status for a Peer intent (buyer onramp or maker-side fill). */
export type PeerIntentStatus =
  | "quoted" // a quote was selected, no on-chain action yet
  | "signaled" // signalIntent landed — liquidity reserved
  | "paid" // user marked fiat sent (onramp) / awaiting proof
  | "proving" // building/submitting the payment proof
  | "fulfilled" // escrow released on Base
  | "bridged" // funds bridged to a non-Base destination chain
  | "cancelled" // intent cancelled before fulfillment
  | "failed"; // error / refund

export const PEER_INTENT_ACTIVE_STATUSES: PeerIntentStatus[] = [
  "quoted",
  "signaled",
  "paid",
  "proving",
];

/** LP / off-ramp deposit lifecycle. */
export type PeerDepositStatus = "active" | "paused" | "withdrawn";

// ─── Feature flag ─────────────────────────────────────────────────────────────
// Server reads process.env.FEATURE_PEER; client reads import.meta.env.VITE_FEATURE_PEER.
// Default OFF. Turning it on does not move money — the write path also needs a
// funded Base wallet wired at the peerWallet seam.

export const PEER_FLAG_ENV = "FEATURE_PEER";
export const PEER_FLAG_VITE = "VITE_FEATURE_PEER";

export function isPeerEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env[PEER_FLAG_ENV] === "true" || env[PEER_FLAG_VITE] === "true";
}
