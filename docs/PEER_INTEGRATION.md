# Peer (zkP2P) Integration — On-ramp + Off-ramp

> ⬆️ **For current state, read `docs/DEX_STATE_2026-06-10.md` first.** The full 5-surface
> P2P platform (orderbook/buy/sell/vaults/leaderboard) was built since this doc; this file is
> the protocol/decision background, not the live build state.


> Status: **FULL on+offramp suite built, end-to-end. FLAG-OFF + staging by default.
> NOT live (your call to flip).** Built 2026-06-09 from a firsthand read of the full
> `docs.peer.xyz` extract (`~/Desktop/peer/peer_docs_combined.md`) + `peer_dex_integration_plan.md`.
> Typechecks + builds clean (`pnpm check` / `pnpm build` = 0 errors). This doc is the
> source of truth for the integration.
>
> **To turn it on:** set `FEATURE_PEER=true`, `PEER_BASE_RPC_URL=<Base RPC>`, fund the
> user's Base wallet (and ideally wire a paymaster for gasless), optionally
> `PEER_API_KEY` + `PEER_REFERRER_FEE_RECIPIENT`/`_BPS`. The Cash tab appears in the nav
> only when `FEATURE_PEER=true` — zero footprint when off. ⚠️ This is Base **mainnet +
> real USDC** (see below).

## What Peer is

Peer = **zkP2P**: a permissionless P2P **fiat ⇄ crypto** protocol that settles on **Base
mainnet (chainId 8453)** in **USDC**. Makers lock USDC in an on-chain escrow and advertise
fiat payment methods (Wise / Venmo / Revolut / Zelle / …) + conversion rates. Takers pay
fiat off-chain, **prove the payment** with a zkTLS / Buyer-TEE attestation, and the escrow
releases USDC. No custody, gasless options, 20+ destination chains via bridging.

- On-ramp (buy): user pays fiat → receives USDC/crypto.
- Off-ramp (sell): user sends USDC → receives fiat from a maker.

## 🔴 The one decision that gates everything: Base mainnet vs INV-2

**Peer has no testnet.** `production`, `preproduction`, and `staging` are **all Base 8453**
(staging only swaps the API host to `api-staging.zkp2p.xyz`). The fiat rails are real
(Wise/Venmo/Revolut), so there is no fake-money path for the on-chain write flow.

This **structurally conflicts with `INV-2` (dex-app is testnet-only, `FEATURE_MAINNET=false`)**.
A working Peer ramp is, by construction, a **mainnet + real-USDC + real-fiat** feature. It
cannot be exercised end-to-end on Sepolia.

→ **This is the operator's call, not an autonomous one.** Nothing in this scaffold flips the live app.
Everything is behind `FEATURE_PEER` (default off) and points at `staging` by default. What is
safe to run today without any money or wallet: **quotes + orderbook reads** (price discovery).
The **write path** (`signalIntent` / `fulfillIntent` / `createDeposit`) needs a funded Base
wallet = real money, and stays gated.

## The other gating decision: shell = Path A vs Path B

Peer exposes three integration surfaces (they are NOT interchangeable):

| Surface | Package | Runs where | Fit for dex-app |
|---|---|---|---|
| Extension deeplink onramp (`peerExtensionSdk.onramp()`) | `@zkp2p/sdk` | **Desktop Chrome only** | ❌ Telegram can't load the extension |
| Mobile headless SDK | `@zkp2p/zkp2p-react-native-sdk` | **Native React Native** app | ⭐ Best, but dex-app is not RN today |
| Core client SDK (`Zkp2pClient` / `OfframpClient`) | `@zkp2p/sdk` | Any JS/TS | ✅ The only fit for a web mini-app |

dex-app is a **Telegram web mini-app** (React+Vite in Telegram's WebView) → **Path A**:
orchestrate the protocol ourselves with `Zkp2pClient` (buy) + `OfframpClient` (sell), and run
the payment-proof step in a WebView.

**The known hard part (Peer's own docs say so):** generating the Buyer-TEE payment proof on
mobile web is painful — the React-Native SDK exists *precisely because* of this. If the proof
step proves too heavy inside Telegram's WebView, the fallback is a thin **native RN shell
(Path B)**, where `@zkp2p/zkp2p-react-native-sdk` solves proof + fulfill for you.

→ Recommendation: ship **off-ramp first** (Path C / `OfframpClient` — shell-independent, no
proof-capture problem) and the **read-only on-ramp quote surface**; treat the on-ramp *proof
+ fulfill* as a spike that decides Path A-web vs Path B-native.

## On-ramp flow (buy), Path A

1. `getQuote()` / `getQuotesBestByPlatform()` — how much USDC for X fiat, which maker/platform. *(read-only, no wallet, SAFE today)*
2. `signalIntent()` — reserve liquidity from a maker's deposit (on-chain write).
3. User pays the maker off-chain (Wise/Venmo/…).
4. Buyer-TEE proof — open the payment platform in a WebView, capture the session, call the attestation service `POST /buyer/verify/{platform}/{actionType}`. **← the hard part.**
5. `fulfillIntent({ intentHash, proof })` — escrow releases USDC to the recipient (bridges if the destination chain ≠ Base).

Status track for the UI state machine: Signaled → Paid → Proving → Fulfilled → (Bridged).

## Off-ramp flow (sell / provide liquidity), Path C

`OfframpClient.createDeposit({ token: USDC, amount, intentAmountRange, processorNames,
payeeData, conversionRates })` → `setAcceptingIntents()` → makers field intents → release on
buyer proof. Reads are RPC-first: `getDeposits()`, `getIntents()`, `client.indexer.*`.
`payeeData` is `{ offchainId, telegramUsername?, metadata? }` — note it **already carries
`telegramUsername`**, which fits dex-app directly.

## Money/infra prerequisites (all operator-side, real-world)

1. **A Base smart-account wallet for app users**, exposed as a viem `WalletClient`. dex-app
   today imports an ethers EOA on Sepolia; this needs a Base wallet seam (see `peerClient.ts`).
2. **Gasless**: TG users hold no Base ETH. Every write method has a `.prepare()` returning
   `{ to, data, value, chainId }` — route that calldata through **our relayer / ERC-4337
   paymaster** so the venue sponsors gas. Pairs with the smart-account wallet.
3. **Base RPC URL** (`PEER_BASE_RPC_URL`, e.g. Alchemy).
4. **Curator API key** (`PEER_API_KEY`) — *optional*. Enables auto-fetch of the `signalIntent`
   gating signature + richer quotes. Without it we fetch the gating sig ourselves.
5. **Monetization**: `referrerFeeConfig` on `getQuote`/`signalIntent` is the venue's revenue hook —
   set `PEER_REFERRER_FEE_RECIPIENT` + bps.
6. **Legal/KYC posture** for operating a fiat ramp — out of scope for code, flagged for the operator.

## Decimals & gotchas (from the docs — do not get these wrong)

- USDC amounts = **6 decimals** (`100_000000n` = 100 USDC). Conversion rates = **18 decimals**
  (`1_020000000000000000n` = 1.02). Never mix them.
- `toToken` format = `chainId:tokenAddress` (zero address = native). USDC on Base =
  `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`.
- **Never** append `/v1`/`/v2`/`/v3` to `baseApiUrl` — the SDK adds versions.
- `environment="staging"` does **not** rewrite `baseApiUrl`; pass the staging URL explicitly.
- `walletClient` is **required** by the client constructor for any send. Reads/quotes can use a
  throwaway account (we do this for price discovery, mirroring the existing `0x…dEaD` swap-quote pattern).
- `payeeData[]` must line up by index with `processorNames[]`.
- Venmo/PayPal/Wise takers need a one-time **identity attestation** before they're accepted.

## What's built (this commit) — the full suite

**Shared**
- `shared/peer-config.ts` — chain/USDC, service roots (`staging` default), payment platforms +
  fiat currencies, decimal helpers (USDC 6dp / rate 18dp), state machine, `FEATURE_PEER` flag.

**Server**
- `server/lib/peer/peerWallet.ts` — Base `WalletClient` from the user's existing AES-GCM managed
  key (reuses `decryptPrivateKey`; no new custody) + a throwaway read client for quotes.
- `server/lib/peer/peerClient.ts` — `Zkp2pClient` factories (read + per-user write).
- `server/lib/peer/peerService.ts` — orchestration: `getBestQuotes`, `signalIntent`,
  `fulfillIntent`, `cancelIntent`, `markPaid`, off-ramp `createDeposit` / `setAcceptingIntents`,
  status/list reads — all persisted to DB. Referrer-fee (revenue) wired.
- `server/routers/peer.ts` — full tRPC surface (`config`, `bestQuotes`, `signalIntent`,
  `fulfillIntent`, `cancelIntent`, `markPaid`, `createDeposit`, `setAcceptingIntents`,
  `myIntents`, `myDeposits`, `intent`). Mounted in `server/routers.ts`; writes guarded by
  `assertPeerWriteReady` (flag + Base RPC + the user's wallet).
- `drizzle/schema.ts` + `bootMigrations.ts` — `peer_intents` + `peer_deposits` tables, self-create at boot.
- `server/_core/env.ts` — `FEATURE_PEER`, `PEER_RUNTIME_ENV`, `PEER_BASE_RPC_URL`, `PEER_API_KEY`,
  `PEER_REFERRER_FEE_RECIPIENT`/`_BPS`.

**Client** (brutalist design system, plain-ESL copy, Cash tab appears only when enabled)
- `pages/tabs/CashTab.tsx` — Cash In (buy) with live quotes per platform; Cash Out (sell) =
  provide-liquidity + manage offers.
- `pages/PeerOrder.tsx` — buy lifecycle screen: send cash → mark paid → verify → done, with
  status polling + Base explorer links (mirrors `ActiveOrder`).
- `components/peer/` — `FiatCurrencyPickerSheet`, `PaymentPlatformPickerSheet`,
  `ProvideLiquiditySheet` (off-ramp/LP `createDeposit` form).
- Wired into `MiniApp.tsx` (Cash tab + `PeerOrder` overlay), gated on `peer.config.enabled`.

## What it deliberately does NOT do (your decisions)

- Does not flip `FEATURE_PEER`/touch the live app/move funds. Default off + `staging`.
- The **Buyer-TEE payment proof capture** inside the Telegram WebView is the one genuinely-hard
  seam (Peer's own docs say so) — `PeerOrder.verify()` drives the documented fulfill flow and
  submits a proof payload, but the in-WebView zkTLS *session capture* is the Path-A-vs-native
  spike, isolated there. Decide Path A (web) vs Path B (native RN shell) before a real buy.
- Does not wire a real Base wallet funding flow, relayer, or paymaster (gasless infra — your call).
- Does not add new payment-platform provider templates (uses the SDK's bundled wise/venmo/revolut/…).

## Suggested next steps (in order)

1. **Decide the two gates**: (a) mainnet posture for the ramp, (b) Path A-web vs Path B-native shell.
2. Wire a Base wallet seam + RPC; run a **read-only quote** end-to-end on staging to prove plumbing.
3. **Off-ramp first** (`OfframpClient`) — no proof-capture problem; lets the venue/changers provide liquidity.
4. Spike the on-ramp **proof step** in the Telegram WebView. If too heavy → native RN shell.
5. Add `referrerFeeConfig` (revenue), taker-registration gating, indexer status tracking.
6. Only then: flag-on for a closed test with a funded Base wallet + paymaster.

## Source pointers

- Full docs extract: `~/Desktop/peer/peer_docs_combined.md` (Client Reference §10, Offramp §9, V3 contracts §8).
- Integration plan: `~/Desktop/peer/peer_dex_integration_plan.md`.
- SDK: `@zkp2p/sdk@0.4.3` (+ `viem`), Node ≥22. Service roots: `api.zkp2p.xyz` (prod) /
  `api-staging.zkp2p.xyz` (staging); attestation `attestation-service.zkp2p.xyz`.
