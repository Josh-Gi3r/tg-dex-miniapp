# dex-app — Code Map (function/module reference for future upgrades)

A navigable map of the load-bearing code: what each module/function does + how the flows connect. Built from the actual code (2026-06-01). For *why* decisions were made see `BUILD_PLAN.md` (invariants) + `DEX_STATE_AND_NEXT_PLAN.md` (state). Cleanup backlog (dead code to quarantine) in `AUDIT_FINAL_PREPUSH.md`.

Legend: ✅ live · ⚠️ legacy/blocked (kept but not the live path) · 🤖 background only.

---

## 1. the venue integration engine — `server/lib/dex/*` (the load-bearing layer)
| File | Key exports | Does |
|---|---|---|
| `client.ts` | `getDexClient`, `clearVenueReadCache` | HTTP client for the venue REST. `request()` (429 retry), `post()`, `getTokens/getBalances/getConfig/getFxRate`. `DexApiError`. |
| `apiKey.ts` | `getDecryptedDexCreds`, `storeDexCreds`, `hasDexCreds`, `reprovisionDexKey`, `withDexReauth` | Per-user the venue API key. **`withDexReauth(userId, fn)`** = 401 self-heal (re-mint key + retry once). `reprovisionDexKey` re-signs ManageApiKey from the stored wallet. |
| `walletSigner.ts` | `signAndBroadcastTransfer`, `signAndBroadcastDeposit`, `signAndBroadcastWithdraw` | The 3 wallet-level money primitives. Loads+decrypts the user's key (`loadManagedWallet`), signs, broadcasts via `/tx/send`. Withdraw = 3-step dual-sig. **These power Send + every burst leg.** |
| `swapSigner.ts` | `signAndBroadcastSwap` | Quote → sign EIP-712 `Intent` (+permit) → `POST /swap`. Powers Swap + cross-token Send. |
| `orderSigner.ts` | `placeMakerOrder` | Sign EIP-712 `Order` → `POST /orders` (a CLOB order). ⚠️ Used by the Open Book Bot only — **shop ads must NOT call this** (INV-1/INV-5). |
| `orderCanceller.ts` | `signAndCancelOrder` | Cancel a resting CLOB order (5-min cooldown aware). |
| `shopSettlement.ts` | `precheckReserve`, `reserveSettlement`, `buildPaymentLeg/ReleaseLeg/RecycleLeg/RefundLeg`, `nextStatus`, `isTerminal` | **The 3-leg burst state machine** (pure logic). |
| `shopSettlementDb.ts` | `debitReservation` (atomic CAS), `releaseReservation`, `recheckManagedWallet`, `createDbDeps` | DB side-effects for the burst (reservation debit is a conditional UPDATE = no double-spend). |
| `shopSettlementWorkers.ts` | `runTtlExpiryWorker`, `runRefundWorker`, `runRecycleRetryWorker`, `runShopSettlementCycleTracked` | 🤖 reconcile expired/refund/recycle. |
| `txVerifier.ts` | `verifyErc20Transfer`, `verifyVaultTransfer`, `getActiveRpcUrl` | On-chain receipt verify (used to confirm the taker payment BEFORE releasing maker funds). |
| `analysis.ts` | `marginalRate`, `analyzeDirections`, `tokenMap` | **`marginalRate()`** = 2-size slope read that cancels the venue's fixed fee (the correct board rate). |
| `bookScanner.ts` | `scanLiveBook`, `getCachedBook` | 🤖 reconstruct the CLOB to individual order levels (fine-walk). |
| `openBookBot.ts` | `runOpenBookCycle` | 🤖 posts seed-shop liquidity as real CLOB orders (feeds the rates board). |
| `rateLog.ts` | `runRateLogCycle` | 🤖 snapshots rate+mid → `rate_history`. |
| `fillPoller.ts` | `runFillCycle` | 🤖 reconciles maker order fills. |
| `tradeAgent.ts` | `runAgentForUser` | Douglas "trade-on-behalf" agent (scan edges → take best deal user holds). On-demand, not scheduled. |
| `fundTestnetWallet.ts` | `fundTestnetWallet` | ETH top-up (W1) + faucet claim. Mostly a no-op for already-funded team wallets. |

## 2. tRPC routers — `server/routers/*` (16 mounted in `server/routers.ts` + internal `p2p-actions` helper = 17 router files; `changer.ts` mounts as `shop`)
- **`dex.ts`** ✅ — the money + read surface: `swapManaged`, `sendToken`, `withdraw`, `balances` (401-self-healed), `liveBoard`, `liveBook`, `opportunities`, `bestRoute`, `rateHistory`, `myFills`, `tokens`, `markets`, `apiKey{Prepare,Complete,Revoke}`, raw build/sign helpers.
- **`p2p.ts`** ✅⚠️ — shops: `listAds`, **`postAdLive`** ✅ (vault-backed create, no CLOB order), **`editAd`** ✅ (vault-backed, no CLOB order), `cancelAd`, `getOrder`/`getActiveOrders` (changerId resolved via `changerProfiles`), **`messageCounterparty`** ✅ (bot-relay chat), `submitRating`, `storeChatId` (writes chatId only). ⚠️ `executeSwap` (retired — needs real txHash), `postAd`/`draftAd`/`commitDeposit`/`commitOrder` (legacy), `placeOrder`/`markPaid`/`confirmReceived`/`raiseDispute` (legacy fiat — blocked), `purchasePromotion` (hidden, unverified).
- **`shopSettlement.ts`** ✅ — **`reserve`** → **`executeBurst`** (the live P2P take). Plus `recordLeg`/`confirmLeg`/`failLeg`/`getSettlement`.
- **`wallet.ts`** ✅ — `importPrivateKey` ✅ (the real path), `getOrCreate` (imported-only — auto-gen disabled), `importWallet` (address-only), `fundStatus`.
- **`send.ts`** ✅ — `resolveRecipient` (@username→wallet), `createClaim`/`claimFunds`/`getClaim` (claim links).
- **`onboarding.ts`** ✅ — `seen`/`markSeen` (server-side tutorial memory; TG WebView loses localStorage).
- **`swap.ts`** ⚠️ — `getRate` ✅ (live FX), `getHistory` ✅; `recordSwap`/`registerWallet` legacy.
- Others: `assistant` ✅ (OpenAI Responses), `quests`/`referral`/`social`/`leaderboard` (gamification), `news` ✅, `signals`/`yield` (🤖), `changer` ⚠️ (legacy `changer_rates`, not the p2pAds model).

## 3. The 5 core flows (function chains)
- **Import wallet:** `wallet.importPrivateKey` → derive addr → `encryptPrivateKey` (AES-GCM) → store `walletKeys{imported:true}` → provision the venue key.
- **Swap:** `SwapTab` → `dex.swapManaged` → `signAndBroadcastSwap` (quote→sign Intent+permit→`/swap`).
- **Send:** `SendTab` → same-token `dex.sendToken`→`signAndBroadcastTransfer`; cross-token `dex.swapManaged`(recipient=dest); @username → `send.resolveRecipient` (direct) else `send.createClaim`.
- **P2P take:** `P2PTab` → `shopSettlement.reserve` (CAS debit) → `shopSettlement.executeBurst`: leg1 `signAndBroadcastTransfer` (taker→maker) → TOCTOU recheck + `verifyErc20Transfer` (payment confirmed BEFORE release) → leg2 `signAndBroadcastWithdraw` (maker vault→taker) → leg3 `signAndBroadcastDeposit` (recycle). Refund branch on failure.
- **Create shop:** `MeTab` Create Position → `p2p.postAdLive` → check vault → `signAndBroadcastDeposit` shortfall → insert `p2pAds{settlementOrderId:null}` (vault-backed, NO CLOB order).
- **Withdraw:** `MeTab` → `dex.withdraw` → `signAndBroadcastWithdraw` (3-step dual-sig).

## 4. Background scheduler — `server/_core/index.ts` `startBackgroundSchedulers()`
In-process (no external cron): Open Book Bot ~90s, book-scan ~180s, rate-log ~300s, fills ~30s, shop-settlement ~60s, yield ~600s. Re-entrancy-guarded, testnet-gated. Also reachable via secret-gated `/internal/*` (auth `internalAuthOk` → `INTERNAL_CRON_SECRET` ‖ `JWT_SECRET`).

## 5. Client — `client/src/`
- **`pages/MiniApp.tsx`** — shell: tab state, splash, import nudge, onboarding (auto video/tour per tab via server `onboarding.seen` + `?` re-summon).
- **tabs/**: `SwapTab`, `SendTab`, `P2PTab` (browse + take + my-ads), `MeTab` (wallet/import/withdraw/become-changer/promote — the largest file), `SignalsTab` (Assistant), `QuestsTab`, `NewsTab`, `HistoryTab`. `pages/ActiveOrder.tsx` (order detail + chat).
- **components/**: `TokenPickerSheet` (tradeable-set picker — `TESTNET_TRADEABLE_SYMBOLS`), `onboarding/` (`VideoTour` lazy MP4 player, `Walkthrough` spotlight tour, `walkthroughSteps`, `copy`).
- **hooks/**: `useOnboardingState` (localStorage coach flags — now backed by server), `useConfetti`, `useTelegram` (via `contexts/TelegramContext`).
- **contexts/**: `DemoGate` (`DEMO_MODE=false`), `TelegramContext`, `WalletContext`, `PrivyContext` (inert — Privy off), `ThemeContext`.

## 6. Shared + DB
- **`shared/dex-config.ts`** — `SUPPORTED_TOKENS` (fallback), **`TESTNET_TRADEABLE_SYMBOLS=[USDT,USDC,XSGD,JPYC,EURT]`** (the only set offered in pickers — see `docs/TOKENS.md`), `isMainnetActive`.
- **`shared/dex-api-config.ts`** — EIP-712 types (`Order`/`Intent`/`WithdrawIntent`/`CancelOrder`/`ManageApiKey`/`Permit`), **verified byte-for-byte vs live contracts**.
- **`drizzle/schema.ts`** (MySQL, **26 tables total**) — key ones: `users` (+`onboardingSeen`), `walletKeys` (+`imported`), `p2pAds`, `changer_profiles`, `shop_settlements`/`shop_settlement_legs`, `managed_wallet_caps`, `transactions`, `rate_history`, `send_claims`, `agent_trades`. Plus: `changer_rates`, `p2p_orders`, `badges`, `ratings`, `promotions`, `quest_completions`, `referrals`, `points_transactions`, `social_links`, `bot_recommendations` (+`recommendationSubscriptions`/`recommendationOutcomes`), `yield_positions`/`yield_cycles`/`yield_fills`. Boot-applied via `server/_core/bootMigrations.ts`.

## 7. Upgrade gotchas (read before touching these)
- **DB is MySQL (mysql2)** — no Postgres SQL (`DOUBLE PRECISION` etc.); insertId is an array (`result[0]?.insertId`).
- **Money amounts:** burst uses BigInt `humanToRaw` end-to-end; the postAdLive/editAd deposit-shortfall still uses float `*10**dec` (fine for 6-dec, fix before 18-dec/mainnet).
- **Never** make a shop ad post a CLOB order (INV-1/INV-5). **Never** let `storeChatId` write `telegramUsername` (spoofing). **Never** reintroduce fiat-currency grouping in the token picker.
- After any client-bundle change, **headless-verify the SPA mounts** (a vendor-chunk split once white-screened it).
