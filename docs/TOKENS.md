# Tokens — what's tradeable, and why others aren't

**Source of truth:** `TESTNET_TRADEABLE_SYMBOLS` in `shared/dex-config.ts`. Verified against live `/tokens` 2026-06-01.

the venue lists **~117 tokens** on testnet, but only a handful are actually usable in dex-app. A user must never be offered a token that will just fail — so the Swap picker (`TokenPickerSheet`) and the shop create-ad selector (`MeTab`) show **only the tradeable set below**, not the raw `/tokens` list.

## ✅ Tradeable on testnet (the only ones in Swap / P2P pickers)
Funded in the seed-shop the venue vaults + market-made by the Open Book Bot, so swaps quote and P2P bursts settle. Matches `SEED_TOKEN_ALLOWLIST`.

| Symbol | Name | Address (testnet) | Decimals | EIP-2612 permit (gasless deposit) |
|---|---|---|---|---|
| USDT | Tether USD | `0x8365421d…f2ad` | 6 | ❌ needs ETH for gas |
| USDC | USD Coin | `0x965d4b45…2d0e` | 6 | ✅ permit-capable (gasless) |
| XSGD | XSGD | `0x058e06ca…20aa` | 6 | ❌ needs ETH for gas |
| JPYC | JPY Coin | `0x0b2dfe45…2150` | 6 | ❌ needs ETH for gas |
| EURT | Euro Tether | `0x02aa4187…bf07` | 6 | ❌ needs ETH for gas |

## ❌ NOT offered (the venue lists them, but no testnet liquidity → would fail)
`MYRC` (not even in `/tokens` — instant fail), `TNSGD`, `IDRX`, `IDRT`, `XIDR`, and the other ~108 `/tokens` entries. They are **not funded** in any vault and the Open Book Bot makes no market in them — a swap or shop trade in them errors out. They remain in `SEPOLIA_TOKENS` only so legacy type references resolve; **they are filtered out of every user-facing picker.**

## Gas / permit (the `depositFundWithPermit` note)
- **Gasless** (gas netted from output via `receive_less`) is only available when the **input token supports EIP-2612 permit** — on our set, **only USDC**. USDT/XSGD/JPYC/EURT need real Sepolia ETH for gas.
- This is fine today: managed/imported wallets hold ETH, and our deposit path does `approve → /deposit` (works for all). Wiring `depositFundWithPermit` (1-tx, gasless) would only help USDC and adds per-token permit detection + a fallback on the money path → **deferred** as a low-value optimization (logged here, not built).
- Withdrawals and non-USDC maker deposits also need ETH for gas — relevant when funding seed shops or testers.

## Notes / nuances
- **P2P burst is vault-to-vault**, so a maker can technically offer any token they hold in vault + the taker pays in any token — but the reserve rate-tolerance check uses `/fx/rate`, which only resolves cleanly for the tradeable set. So we restrict the create-ad picker to the same 5.
- On **mainnet** the tradeable set is different/larger (different funded tokens) — `TESTNET_TRADEABLE_SYMBOLS` is a testnet curation; revisit before any mainnet flip.
- **Do not reintroduce fiat-currency grouping** ("US Dollar / SGD / MYR / IDR" headers) in the picker — the product is stablecoin↔stablecoin token-to-token, not a fiat corridor. A per-token flag emoji is fine; grouping by fiat is the killed framing.
