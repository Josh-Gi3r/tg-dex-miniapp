# dex-app — Architecture

Current system design (present-tense). For state/roadmap see `docs/DEX_STATE_AND_NEXT_PLAN.md`; for invariants see `docs/BUILD_PLAN.md`.

## Stack
- **Client** (`client/`): React + Vite SPA, Telegram WebApp SDK, tRPC client. Served as static assets by the Express server in prod.
- **Server** (`server/`): Express + tRPC (`server/routers/*`, mounted in `server/routers.ts`). Auth context in `server/_core/`. Background scheduler runs **in-process** (`startBackgroundSchedulers` in `server/_core/index.ts`).
- **DB**: MySQL via Drizzle (`drizzle/schema.ts`, driver `drizzle-orm/mysql2`), `DATABASE_URL`. Schema self-applies at boot via `server/_core/bootMigrations.ts` (idempotent `COLUMN_CHECKS`/table checks) + testnet auto-seed.
- **the DEX**: REST in `server/lib/dex/*` — `client` (HTTP), `walletSigner`/`swapSigner`/`orderSigner`/`orderCanceller` (EIP-712 signing + broadcast), `shopSettlement*` (the burst), `txVerifier` (on-chain receipt verify), `analysis`/`bookScanner`/`openBookBot` (rates/CLOB), `apiKey` (provisioning + 401 self-heal), `fundTestnetWallet`.

## The two systems (INV-1)
- **CLOB**: the DEX's anonymous order book. The **Open Book Bot** (`openBookBot.ts`) posts a capped slice of seed-shop liquidity as real `/orders`; `analysis.ts`/`bookScanner.ts` read it back via a **marginal-slope** quote read (two sizes cancel the DEX's fixed per-trade fee) for the rates board + AI grounding.
- **P2P shops**: app-DB offers (`p2pAds`), identity-locked, settled by the burst. A shop ad backs `vault_available` and posts **no** CLOB order (posting one would freeze inventory → starve the burst [INV-5] and leak it to the anonymous book [INV-1]).

## Wallet / custody (INV-3)
- Import-only: `wallet.importPrivateKey` derives the address, AES-256-GCM encrypts the key (`server/lib/crypto.ts`, `KEY_ENCRYPTION_SECRET`, PBKDF2 100k, per-key IV + auth tag), stores in `walletKeys` (`imported=true`). The server signs on the user's behalf (custodial, testnet-only). `getOrCreate` surfaces a wallet **only** if `imported=true` — auto-generate is disabled; legacy auto-gen rows are ignored.
- Seed shops: 22 deterministic wallets from `SEED_MNEMONIC` (`m/44'/60'/0'/0/i`), funded on-chain, used to demonstrate the marketplace.

## Signing (EIP-712)
Types in `shared/dex-api-config.ts`, **verified byte-for-byte against the live venue contracts**:
- `Order(user,expiration u48,feeBps u48,recipient,fromToken,toToken,fromAmount,toAmount,initialDepositAmount,uuid)` — maker orders; `feeBps=0`, `recipient=0x0` (proceeds stay in vault).
- `Intent(taker,inputToken,outputToken,maxInputAmount,minOutputAmount,recipient,initialDepositAmount,uuid,deadline u48)` — swaps/SOR (the `taker` field is required; older specs that omit it are wrong).
- `WithdrawIntent(user,tokens[],amounts[],recipient,deadline,uuid)` — dual-sig withdraw.
- Domain `{name:"DEX App",version:"1",chainId,verifyingContract}` is read live from `/config` (never hardcoded → auto-adapts testnet/mainnet). the DEX verifies via `SignatureChecker` → **EOA and EIP-1271** smart-account sigs both accepted (basis for the future session-key path).

## P2P settlement — the 3-leg burst
`server/routers/shopSettlement.ts` (`reserve` → `executeBurst`):
1. **Reserve** — atomic conditional UPDATE debits `liquidityRemaining` (CAS), pre-checks vault/balance/rate/caps, 90–180s TTL.
2. **Burst** (taker pays first, so the maker's vault is never touched until payment lands):
   - **Leg 1 — payment**: taker wallet → maker wallet (`/transfer`).
   - Re-read maker `vault_available` (TOCTOU recheck) + **verify the payment on-chain** (`txVerifier`, bounded receipt poll) *before* releasing. Abort → `expired` if unconfirmed (taker not charged for the release).
   - **Leg 2 — release**: maker vault → taker wallet (3-step dual-sig `/withdraw`).
   - **Leg 3 — recycle**: maker wallet → maker vault (`/deposit`).
   - Refund branch on leg-2 failure. The maker can be offline (app signs their legs from the pre-funded vault).

the DEX's native atomic primitive (`Vault.transferLedger`) is `TRADER_ROLE`-gated (executor-only), so the burst is the app-side workaround — no the DEX-team change required.

## Vault model (INV-5)
`vault_available` backs shop ads + is what the burst withdraws; `vault_frozen` is inventory locked behind resting CLOB orders. The same units cannot back both — `postAdLive`/`editAd` keep ads vault-backed with no CLOB order.

## Auth & sessions
Telegram `initData` (HMAC-validated, `server/_core/oauth.ts`) → per-user upsert by `telegramId` → signed JWT session cookie. `telegramUsername` is set **only** from validated initData (never client-writable — protects the `@username → wallet` resolver). Privy bearer path exists but is inert (`appId` unset).

## Background workers (in-process scheduler)
Open Book Bot (~90s), book-scan (~180s), rate-log (~300s), fills (~30s), shop-settlement (~60s), yield (~600s) — re-entrancy-guarded, testnet-gated. Also reachable via secret-gated `/internal/*` endpoints (auth: `INTERNAL_CRON_SECRET` → falls back to `JWT_SECRET`, constant-time compare). No external cron; `JWT_SECRET` never leaves the server.

## Security
AES-256-GCM key storage (fails closed in prod without `KEY_ENCRYPTION_SECRET`); per-user `assertRateLimit` on money/auth mutations; on-chain payment verify before fund release; Telegram webhook gated by `TELEGRAM_WEBHOOK_SECRET` (constant-time); 1 MB body cap; emergency on-chain withdrawal (`Vault.emergencyWithdraw`, ~24h) means funds are recoverable even if the API is down. Open items tracked in `docs/AUDIT_FINAL_PREPUSH.md`.

## DB (key tables)
`users`, `walletKeys`, `p2pAds`, `changer_profiles`, `shop_settlements`, `shop_settlement_legs`, `managed_wallet_caps`, `transactions`, `rate_history`, `send_claims`, `agent_trades`. Migrations are boot-applied.

## Deploy
Railway auto-deploys `main` (`npm run build` → `npm run start`). See `DEPLOY.md`.
