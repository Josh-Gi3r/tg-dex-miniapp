/**
 * Server environment variables — single source of truth.
 * Never read process.env directly in router or lib files; use ENV instead.
 *
 * Required: DATABASE_URL, JWT_SECRET, TELEGRAM_BOT_TOKEN, OWNER_OPEN_ID
 * Optional: TELEGRAM_BOT_USERNAME, TG_BOT_USERNAME, BOT_WEBHOOK_URL,
 *           SEPOLIA_RPC_URL, MAINNET_RPC_URL, PRIVY_APP_ID,
 *           DEX_API_BASE, APP_TREASURY_WALLET
 *
 * Security: JWT_SECRET must be set in production. An empty-string JWT secret
 * is equivalent to no secret — the server throws at startup rather than
 * silently issuing forgeable tokens.
 */

const _jwtSecret = process.env.JWT_SECRET ?? "";
if (!_jwtSecret && process.env.NODE_ENV === "production") {
  throw new Error(
    "[env] JWT_SECRET is required in production. " +
    "Generate one with: openssl rand -hex 32"
  );
}

export const ENV = {
  appId:               process.env.VITE_APP_ID ?? "dex-miniapp",
  jwtSecret:           _jwtSecret,
  databaseUrl:         process.env.DATABASE_URL ?? "",
  ownerOpenId:         process.env.OWNER_OPEN_ID ?? "",
  ownerName:           process.env.OWNER_NAME ?? "",
  isProduction:        process.env.NODE_ENV === "production",

  // Telegram — set TELEGRAM_BOT_USERNAME to your bot's @handle (no @).
  // No production-safe default is provided.
  telegramBotToken:    process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME ?? process.env.TG_BOT_USERNAME ?? "your_bot_username",
  botWebhookUrl:       process.env.BOT_WEBHOOK_URL ?? "",

  // Blockchain RPC endpoints
  sepoliaRpcUrl:       process.env.SEPOLIA_RPC_URL ?? "",
  mainnetRpcUrl:       process.env.MAINNET_RPC_URL ?? "",

  // Feature mode: "demo" (default) or "production"
  featureMode:         process.env.FEATURE_MODE ?? "demo",
  featureMainnet:      process.env.FEATURE_MAINNET === "true",

  // Auth provider. Default: Privy embedded wallets (pluggable — see server/lib/auth/).
  // Set PRIVY_APP_ID from your Privy dashboard; leave blank to use the fallback
  // Telegram-cookie session auth which requires no external provider.
  privyAppId:          process.env.PRIVY_APP_ID ?? "",

  // Settlement venue REST API.
  // Defaults to testnet to match FEATURE_MAINNET=false default.
  // Set DEX_API_BASE=<mainnet-url> when flipping FEATURE_MAINNET=true.
  dexApiBase:          process.env.DEX_API_BASE ?? "https://api-testnet.your-venue.example/api/v1",
  // Treasury/fee-recipient wallet for promotion fees.
  // API keys are per-user — created on first login via the ManageApiKey EIP-712 flow
  // (see server/routers/dex.ts apiKeyPrepare/Complete).
  appTreasuryWallet:   process.env.APP_TREASURY_WALLET ?? "",

  // ─── Peer (zkP2P) fiat ⇄ crypto ramp — see docs/PEER_INTEGRATION.md ─────────
  // OFF by default. Peer settles on Base mainnet (8453) in real USDC.
  // Turning this on is a real-money decision.
  peerEnabled:         process.env.FEATURE_PEER === "true",
  // Runtime env: 'production' | 'staging' (api-staging, mostly empty).
  peerRuntimeEnv:      (process.env.PEER_RUNTIME_ENV ?? "production") as
                         "production" | "preproduction" | "staging",
  // Base RPC (Alchemy/Infura/etc.) — required for any Peer on-chain action.
  peerBaseRpcUrl:      process.env.PEER_BASE_RPC_URL ?? "",
  // Optional curator API key — enriches quotes + auto-fetches gating sigs.
  peerApiKey:          process.env.PEER_API_KEY ?? "",
  // Optional baseApiUrl override (else derived from peerRuntimeEnv).
  peerBaseApiUrl:      process.env.PEER_BASE_API_URL ?? "",
  // Monetization: referrer fee recipient + bps applied on each ramp.
  peerReferrerFeeRecipient: process.env.PEER_REFERRER_FEE_RECIPIENT ?? "",
  peerReferrerFeeBps:  Number(process.env.PEER_REFERRER_FEE_BPS ?? "0") || 0,
};
