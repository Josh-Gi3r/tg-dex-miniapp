/**
 * ─── Settlement Venue + Token Registry Configuration ─────────────────────────
 *
 * Token registry + Telegram + block-explorer helpers for the DEX Mini App.
 *
 * Live contract addresses (Vault, SOR, Batcher), the EIP-712 domain, and the
 * executor_id are fetched dynamically from `GET /config` via
 * `server/lib/dex/client.ts` — never hardcode them here.
 *
 * SUPPORTED_TOKENS below is a Sepolia fallback used by `resolveToken()` in
 * `client/src/lib/dex/tokens.ts` when the live `GET /tokens` response isn't
 * available (e.g. during the cold-cache window). Live venue data wins.
 *
 * To connect a different settlement venue:
 *   1. Replace the token addresses below with your venue's testnet/mainnet tokens.
 *   2. Set DEX_API_BASE in .env to your venue's REST endpoint.
 *   3. Set TELEGRAM_BOT_USERNAME (or TG_BOT_USERNAME env) to your bot.
 */

// ─── Network Identifiers ─────────────────────────────────────────────────────

/** Ethereum Sepolia testnet chain ID. */
export const SEPOLIA_CHAIN_ID = 11155111;
/** Ethereum mainnet chain ID. */
export const MAINNET_CHAIN_ID = 1;

/** Read the active chain from env. Server reads process.env; the Vite client
 *  reads import.meta.env. Returns mainnet chain when FEATURE_MAINNET is
 *  enabled, Sepolia otherwise. */
export function getActiveChainId(): number {
  const fromImportMeta =
    typeof import.meta !== "undefined"
      ? (import.meta as any).env?.VITE_FEATURE_MAINNET
      : undefined;
  const fromProcess =
    typeof process !== "undefined" ? process.env?.FEATURE_MAINNET : undefined;
  const enabled = (fromImportMeta ?? fromProcess) === "true";
  return enabled ? MAINNET_CHAIN_ID : SEPOLIA_CHAIN_ID;
}

export function isMainnetActive(): boolean {
  return getActiveChainId() === MAINNET_CHAIN_ID;
}

// ─── Supported Tokens — Local fallback registry ──────────────────────────────
//
// Runtime source of truth is GET /tokens from your venue. These maps are used
// when the live response is cold (initial page load, /tokens fetch error) or in
// tests. Replace addresses with your venue's actual token contracts.
//
// The first 5 (USDT/USDC/XSGD/JPYC/EURT) are the TRADEABLE set — funded in the
// seed-shop vaults (see scripts/setup-demo-shops.mjs and docs/TOKENS.md).
// The remaining tokens (TNSGD/MYRC/IDRX/IDRT/XIDR) are listed but have no
// testnet liquidity by default and are excluded from swap/shop pickers.
const SEPOLIA_TOKENS = {
  USDT:  { symbol: "USDT",  name: "Tether USD",             address: "0x8365421d0e1b316fc6398d21be162992216bf2ad", decimals: 6,  currency: "USD" },
  USDC:  { symbol: "USDC",  name: "USD Coin",               address: "0x965d4b4546716e416e950bc30467d128455d2d0e", decimals: 6,  currency: "USD" },
  XSGD:  { symbol: "XSGD",  name: "XSGD",                  address: "0x058e06ca2628165a6cd1e80e4dc82203dc0020aa", decimals: 6,  currency: "SGD" },
  JPYC:  { symbol: "JPYC",  name: "JPY Coin",              address: "0x0b2dfe45ca948a5f75e358e4000ed0adf1142150", decimals: 6,  currency: "JPY" },
  EURT:  { symbol: "EURT",  name: "Euro Tether",           address: "0x02aa41876fe62da9e28fe8a970a5dfa3dfdabf07", decimals: 6,  currency: "EUR" },
  TNSGD: { symbol: "TNSGD", name: "TrueNZD SGD",           address: "0x4638F8eB9F2047Ab18d70E12539E0B16fF2998A2", decimals: 6,  currency: "SGD" },
  MYRC:  { symbol: "MYRC",  name: "Malaysian Ringgit Coin", address: "0x68077f53a6562D42051C86b09160EA577f3C7476", decimals: 6,  currency: "MYR" },
  IDRX:  { symbol: "IDRX",  name: "Indonesian Rupiah X",   address: "0x258f1E146b8Bd0dEcf54bAD8f1f01fE69025601c", decimals: 6,  currency: "IDR" },
  IDRT:  { symbol: "IDRT",  name: "Rupiah Token",           address: "0x26db12e7cB7Be8Ab22a97B7e4c3d33C0bfE89e82", decimals: 6,  currency: "IDR" },
  XIDR:  { symbol: "XIDR",  name: "XIDR",                  address: "0xe02bbf861736147e1506d07239d7f2D291FB39fC", decimals: 6,  currency: "IDR" },
} as const;

/**
 * Tokens tradeable on testnet: funded in demo-shop vaults and market-made by
 * the Open Book Bot, so swaps quote and P2P bursts settle.
 * This is the ONLY set offered in Swap + shop pickers. See docs/TOKENS.md.
 * Gas note: only USDC supports EIP-2612 permit (gasless deposit).
 */
export const TESTNET_TRADEABLE_SYMBOLS = ["USDT", "USDC", "XSGD", "JPYC", "EURT"] as const;

// Mainnet well-known stablecoin addresses (Ethereum L1).
// Replace with your venue's mainnet token list or load from GET /tokens.
const MAINNET_TOKENS = {
  USDC: { symbol: "USDC", name: "USD Coin",  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6,  currency: "USD" },
  USDT: { symbol: "USDT", name: "Tether USD",address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6,  currency: "USD" },
  DAI:  { symbol: "DAI",  name: "Dai",       address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, currency: "USD" },
  EURC: { symbol: "EURC", name: "Euro Coin", address: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", decimals: 6,  currency: "EUR" },
  XSGD: { symbol: "XSGD", name: "XSGD",      address: "0x70e8dE73cE538DA2bEEd35D14187F6959a8ecA96", decimals: 6,  currency: "SGD" },
} as const;

/** Sepolia fallback for legacy callers. New code should use getAllTokens() / getTokenBySymbol(). */
export const SUPPORTED_TOKENS = SEPOLIA_TOKENS;

export type TokenSymbol = keyof typeof SEPOLIA_TOKENS;

type AnyToken = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  currency: string;
};

function tokensForChain(chainId: number): Record<string, AnyToken> {
  return chainId === MAINNET_CHAIN_ID
    ? (MAINNET_TOKENS as unknown as Record<string, AnyToken>)
    : (SEPOLIA_TOKENS as unknown as Record<string, AnyToken>);
}

/** Returns all tokens for the currently active chain. */
export function getAllTokens(): AnyToken[] {
  return Object.values(tokensForChain(getActiveChainId()));
}

/** Returns a token by symbol on the active chain. */
export function getTokenBySymbol(symbol: string): AnyToken | undefined {
  return tokensForChain(getActiveChainId())[symbol];
}

/** Returns a token by its contract address on the active chain. */
export function getTokenByAddress(address: string): AnyToken | undefined {
  return getAllTokens().find(
    (token) => token.address.toLowerCase() === address.toLowerCase()
  );
}

// ─── Explorer Utilities ───────────────────────────────────────────────────────

/** Picks the right Etherscan host for the active chain. Override EXPLORER_BASE in .env for other chains. */
function etherscanBase(isMainnet?: boolean): string {
  const m = isMainnet ?? isMainnetActive();
  const override = typeof process !== "undefined"
    ? process.env?.EXPLORER_BASE
    : undefined;
  if (override) return override;
  return m ? "https://etherscan.io" : "https://sepolia.etherscan.io";
}

/** Returns the block explorer URL for a transaction hash. */
export function getExplorerUrl(txHash: string, isMainnet?: boolean): string {
  return `${etherscanBase(isMainnet)}/tx/${txHash}`;
}

/** Returns the block explorer URL for a wallet address. */
export function getAddressExplorerUrl(address: string, isMainnet?: boolean): string {
  return `${etherscanBase(isMainnet)}/address/${address}`;
}

// ─── Telegram Deep Links ──────────────────────────────────────────────────────
//
// Set TELEGRAM_BOT_USERNAME in .env (or TG_BOT_USERNAME) to your bot handle.
// Do NOT hardcode your bot username here — it must be a config value.

function getTelegramBotUsername(): string {
  const fromEnv =
    (typeof process !== "undefined" && (process.env?.TELEGRAM_BOT_USERNAME || process.env?.TG_BOT_USERNAME)) ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_TG_BOT_USERNAME);
  return (fromEnv as string | undefined) ?? "your_bot_username";
}

/** @deprecated Use getTelegramBotUsername() — this constant is a placeholder. */
export const TELEGRAM_BOT_USERNAME = getTelegramBotUsername();

/**
 * Returns the Mini App deep link URL.
 * e.g. getMiniAppUrl("ref_123") => "https://t.me/your_bot_username/app?startapp=ref_123"
 */
export function getMiniAppUrl(startParam?: string): string {
  const base = `https://t.me/${getTelegramBotUsername()}/app`;
  return startParam ? `${base}?startapp=${startParam}` : base;
}
