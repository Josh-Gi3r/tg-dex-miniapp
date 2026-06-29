/**
 * ─── the venue Market Maker Orchestrator ──────────────────────────────────────────
 *
 * Drives the full Become-a-Market-Maker flow:
 *   1. Optional approve()/permit — make sure the venue Vault can pull the deposit
 *   2. Deposit into the Vault
 *   3. Place a limit order on the book at the maker's chosen rate
 *
 * On success the caller (MeTab Create Position step 3) gets back the the venue
 * order_id and packed uuid_int, which it stores on the p2pAds row so the
 * ad shows a "Live on the venue" badge in Browse.
 *
 * The `runMarketMakerSetup` function is intentionally one big async — it
 * gives the UI a single Promise to await and a clear chain of "approving →
 * depositing → going live" status callbacks.
 */

import {
  buildOrderTypedData,
  buildPermitTypedData,
  type OrderTypedData,
  type PermitTypedData,
} from "./signing";
import {
  encodeStandalone,
  generateUuid4,
  uuidStringToBigInt,
} from "./uuidInt";
import { fromRawAmount, toRawAmount } from "./tokens";
import { ensureVenueApiKey } from "./apiKey";
import { broadcastViaVenue } from "./broadcast";
import type { VenueWalletInfo } from "@/lib/privy/useEmbeddedWallet";
import type { trpc } from "@/lib/trpc";

export type MarketMakerStep =
  | "checking-allowance"
  | "approving"
  | "depositing"
  | "placing-order"
  | "polling"
  | "done";

export interface MarketMakerSetupParams {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  /** Token addresses (raw uint256-ready hex). */
  fromToken: string;
  toToken: string;
  /** Raw amounts as decimal strings — caller converts from human units. */
  fromAmount: string;
  toAmount: string;
  /** How much of fromAmount to deposit upfront. Same units as fromAmount. */
  initialDepositAmount: string;
  /** Order expiration unix-seconds. */
  expiration: number;
  /** Maker-specified protocol fee in basis points (typically 0–50). */
  feeBps?: number;
  /** Status callback invoked at each step transition. */
  onStep?: (step: MarketMakerStep) => void;
  /** UI/symbol fields persisted to our DB on draftAd. */
  adInputs: {
    fromTokenSymbol: string;
    toTokenSymbol: string;
    rateHuman: number;
    liquidityHuman: number;
    minOrderHuman: number;
    maxOrderHuman: number;
    terms?: string;
  };
}

export interface MarketMakerSetupResult {
  /** DB row id of the newly-created p2pAds row. */
  adId: number;
  orderId: string;
  uuidInt: string;
  status: string;
  depositTxHash: string | null;
  approveTxHash: string | null;
}

/** Thrown by runMarketMakerSetup when the deposit succeeded but order
 *  placement failed. Caller should surface a "Retry placement" CTA. */
export class OrderPlacementFailedError extends Error {
  readonly adId: number;
  readonly depositTxHash: string;
  readonly underlying: unknown;
  constructor(adId: number, depositTxHash: string, underlying: unknown) {
    const msg =
      underlying instanceof Error ? underlying.message : String(underlying);
    super(`Deposit succeeded but order placement failed: ${msg}`);
    this.name = "OrderPlacementFailedError";
    this.adId = adId;
    this.depositTxHash = depositTxHash;
    this.underlying = underlying;
  }
}

export async function runMarketMakerSetup(
  params: MarketMakerSetupParams,
): Promise<MarketMakerSetupResult> {
  const { wallet, utils, onStep } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // ── 0a. Ensure the venue API creds are provisioned. Required for /permit/metadata,
  //         /approve, /deposit, balance polling — auto-provisions on first
  //         call (one extra wallet popup, only the first time the user does
  //         a market-maker setup). ─────────────────────────────────────────
  await ensureVenueApiKey({ wallet, utils });

  // ── 0b. Persist a draft ad row BEFORE any signing/broadcasting ─────────────
  // Status='paused' so it doesn't appear in Browse. After the deposit+order
  // succeed, commitOrder flips it to 'active'. If the order step fails after
  // a successful deposit, the row stays paused with settlementDepositTxHash set
  // and the UI can offer a "Retry placement" CTA.
  const draft = await utils.client.p2p.draftAd.mutate({
    adType: "swap",
    fromToken: params.adInputs.fromTokenSymbol,
    toToken: params.adInputs.toTokenSymbol,
    rate: params.adInputs.rateHuman,
    liquidity: params.adInputs.liquidityHuman,
    minOrder: params.adInputs.minOrderHuman,
    maxOrder: params.adInputs.maxOrderHuman,
    terms: params.adInputs.terms,
  });
  const adId = draft.adId;

  // ── 1. Permit (EIP-2612) or approve() depending on token ──────────────────
  onStep?.("checking-allowance");
  // Bootstrap once — we need the Vault address as the permit spender
  const bootstrap = await utils.client.dex.bootstrap.query();
  // Pass `amount` so the server can compute the `required` boolean
  // (current_allowance < amount). When `required === false`, an existing
  // allowance covers the value and we skip permit signing entirely.
  const permit = await utils.client.dex.permitMetadata.query({
    token: params.fromToken,
    spender: "vault",
    amount: params.initialDepositAmount,
  });

  let approveTxHash: string | null = null;
  let permitSignature: string | undefined;
  let permitDeadline: number | undefined;

  if (permit.permitSupported && permit.required !== false && permit.domain && permit.nonce) {
    // Use server time so the deadline survives Telegram WebView clock skew
    const serverNow = await utils.client.dex.serverTime.query();
    permitDeadline = serverNow.timestamp + 3600; // 1h
    const permitMessage: PermitTypedData = {
      owner: wallet.address,
      spender: bootstrap.vaultAddress,
      value: params.initialDepositAmount,
      nonce: permit.nonce,
      deadline: String(permitDeadline),
    };
    const permitPayload = buildPermitTypedData(
      permit.domain as { name: string; version: string; chainId: number; verifyingContract: string },
      permitMessage,
    );
    permitSignature = await wallet.signTypedData({
      domain: permitPayload.domain,
      types: permitPayload.types,
      primaryType: permitPayload.primaryType,
      message: permitPayload.message as unknown as Record<string, unknown>,
    });
  } else {
    onStep?.("approving");
    const approveBuilt = await utils.client.dex.approveBuild.mutate({
      token: params.fromToken,
      amount: params.initialDepositAmount,
    });
    const approveTx = approveBuilt.tx as { to: string; data: string; value?: string; chainId?: number };
    approveTxHash = await broadcastViaVenue({ wallet, utils, kind: "tx", tx: approveTx });
  }

  // ── 2. Deposit into Vault ─────────────────────────────────────────────────
  onStep?.("depositing");
  const depositBuilt = await utils.client.dex.depositBuild.mutate({
    token: params.fromToken,
    amount: params.initialDepositAmount,
    permitSignature,
    permitDeadline,
    // Spec: `permit_amount` defaults to `amount` when omitted, but be
    // explicit so the signed permit value matches exactly.
    permitAmount: permitSignature ? params.initialDepositAmount : undefined,
  });
  const depositTx = depositBuilt.tx as { to: string; data: string; value?: string; chainId?: number };
  const depositTxHash = await broadcastViaVenue({ wallet, utils, kind: "tx", tx: depositTx });

  // Persist the deposit hash on our DB row IMMEDIATELY. If the order
  // step below fails, this is what lets MyAdsSection surface a "Retry
  // placement" CTA — the funds aren't stranded with no record.
  await utils.client.p2p.commitDeposit.mutate({ adId, depositTxHash });

  // From here on, any failure should throw OrderPlacementFailedError
  // so the caller can distinguish "deposit succeeded, retry just the
  // order" from "deposit failed, retry the whole flow."
  try {

  // ── 3. Resolve the market pair (base/quote ordering) ─────────────────────
  // the venue POST /orders uses market-pair convention:
  //   from_address = market base, to_address = market quote
  //   side='ask' spends from_address (base) to receive to_address (quote)
  //   side='bid' spends to_address (quote) to receive from_address (base)
  // The maker's UI is "I pay X to receive Y" — we map that onto the canonical
  // market by looking up which direction the venue lists it.
  const marketsResp = await utils.client.dex.markets.query();
  const market = marketsResp.markets.find(
    (m) =>
      (m.base_address.toLowerCase() === params.fromToken.toLowerCase() &&
        m.quote_address.toLowerCase() === params.toToken.toLowerCase()) ||
      (m.base_address.toLowerCase() === params.toToken.toLowerCase() &&
        m.quote_address.toLowerCase() === params.fromToken.toLowerCase()),
  );
  if (!market) {
    throw new Error(
      `No the venue market for ${params.fromToken}/${params.toToken}`,
    );
  }
  const baseFirst =
    market.base_address.toLowerCase() === params.fromToken.toLowerCase();
  const side: "ask" | "bid" = baseFirst ? "ask" : "bid";
  // Amount is always in market-base human units. Price is quote-per-base.
  const baseDecimals = market.base_decimals;
  const quoteDecimals = market.quote_decimals;
  const baseAmountHuman = baseFirst
    ? fromRawAmount(params.fromAmount, baseDecimals)
    : fromRawAmount(params.toAmount, baseDecimals);
  const quoteAmountHuman = baseFirst
    ? fromRawAmount(params.toAmount, quoteDecimals)
    : fromRawAmount(params.fromAmount, quoteDecimals);
  const priceHuman = (
    parseFloat(quoteAmountHuman) / Math.max(parseFloat(baseAmountHuman), 1e-18)
  ).toString();

  // Phase B1 — pre-flight check against the per-pair minimums from /markets.
  // ASK floor: qty * 10^base_decimals >= min_ask_amount_raw
  // BID floor: qty * price * 10^quote_decimals >= min_bid_quote_amount_raw
  // the venue 422s with AMOUNT_BELOW_MIN otherwise — surface a useful message
  // instead of "the venue /orders 422" to the user.
  if (side === "ask") {
    const minAskRaw = BigInt(market.min_ask_amount_raw ?? "0");
    const baseRaw = BigInt(toRawAmount(baseAmountHuman, baseDecimals));
    if (minAskRaw > 0n && baseRaw < minAskRaw) {
      throw new Error(
        `Position size below this market's minimum (${market.min_ask_amount} ${market.base_symbol}). Increase your liquidity.`,
      );
    }
  } else {
    const minBidQuoteRaw = BigInt(market.min_bid_quote_amount_raw ?? "0");
    const quoteRaw = BigInt(toRawAmount(quoteAmountHuman, quoteDecimals));
    if (minBidQuoteRaw > 0n && quoteRaw < minBidQuoteRaw) {
      throw new Error(
        `Position notional below this market's minimum (${market.min_bid_quote_amount} ${market.quote_symbol}). Increase your liquidity or rate.`,
      );
    }
  }

  // ── 4. Sign Order with correctly-encoded uuid_int ────────────────────────
  onStep?.("placing-order");
  const { domain, executorId } = bootstrap;
  const orderId = generateUuid4();
  const uuidInt = encodeStandalone(uuidStringToBigInt(orderId), executorId);
  const order: OrderTypedData = {
    user: wallet.address,
    expiration: params.expiration,
    feeBps: params.feeBps ?? 0,
    recipient: wallet.address,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    toAmount: params.toAmount,
    initialDepositAmount: params.initialDepositAmount,
    uuid: uuidInt.toString(),
  };
  const orderPayload = buildOrderTypedData(domain, order);
  const signature = await wallet.signTypedData({
    domain: orderPayload.domain,
    types: orderPayload.types,
    primaryType: orderPayload.primaryType,
    message: orderPayload.message as unknown as Record<string, unknown>,
  });

  // Per spec: POST /orders does NOT accept `recipient` or `fee_bps`.
  const submitted = await utils.client.dex.ordersSubmit.mutate({
    orderId,
    uuidInt: uuidInt.toString(),
    fromAddress: market.base_address,
    toAddress: market.quote_address,
    side,
    amount: baseAmountHuman,
    price: priceHuman,
    owner: wallet.address,
    expiration: params.expiration,
    signature,
  });

  // Flip the row from paused → active with the live the venue order linkage
  await utils.client.p2p.commitOrder.mutate({
    adId,
    settlementOrderId: submitted.orderId,
    settlementOrderUuidInt: submitted.uuidInt,
  });

  onStep?.("done");
  return {
    adId,
    orderId: submitted.orderId,
    uuidInt: submitted.uuidInt,
    status: submitted.status,
    depositTxHash,
    approveTxHash,
  };

  } catch (err) {
    // Deposit succeeded; order placement (or anything after) failed.
    // The DB row stays paused with settlementDepositTxHash set so MyAdsSection
    // can offer a "Retry placement" CTA via runRetryOrderPlacement below.
    throw new OrderPlacementFailedError(adId, depositTxHash, err);
  }
}

// ─── Retry Order Placement (recovery path for partial failures) ────────────────

interface RetryOrderPlacementParams {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  /** DB row id from the failed setup attempt. */
  adId: number;
  /** Token addresses (must match what was deposited). */
  fromToken: string;
  toToken: string;
  /** Same raw amounts and expiration the original setup tried to place. */
  fromAmount: string;
  toAmount: string;
  initialDepositAmount: string;
  expiration: number;
  feeBps?: number;
}

/**
 * Re-runs ONLY the sign-and-place-order steps for an ad whose deposit
 * already succeeded but whose order submission failed. Skips the deposit
 * entirely — the funds are already in the Vault.
 */
export async function runRetryOrderPlacement(
  params: RetryOrderPlacementParams,
): Promise<{ orderId: string; uuidInt: string; status: string }> {
  const { wallet, utils, adId } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // The original setup left creds provisioned; this is defensive.
  await ensureVenueApiKey({ wallet, utils });

  const bootstrap = await utils.client.dex.bootstrap.query();
  const marketsResp = await utils.client.dex.markets.query();
  const market = marketsResp.markets.find(
    (m) =>
      (m.base_address.toLowerCase() === params.fromToken.toLowerCase() &&
        m.quote_address.toLowerCase() === params.toToken.toLowerCase()) ||
      (m.base_address.toLowerCase() === params.toToken.toLowerCase() &&
        m.quote_address.toLowerCase() === params.fromToken.toLowerCase()),
  );
  if (!market) throw new Error(`No the venue market for this pair`);
  const baseFirst =
    market.base_address.toLowerCase() === params.fromToken.toLowerCase();
  const side: "ask" | "bid" = baseFirst ? "ask" : "bid";
  const baseAmountHuman = baseFirst
    ? fromRawAmount(params.fromAmount, market.base_decimals)
    : fromRawAmount(params.toAmount, market.base_decimals);
  const quoteAmountHuman = baseFirst
    ? fromRawAmount(params.toAmount, market.quote_decimals)
    : fromRawAmount(params.fromAmount, market.quote_decimals);
  const priceHuman = (
    parseFloat(quoteAmountHuman) / Math.max(parseFloat(baseAmountHuman), 1e-18)
  ).toString();

  const orderId = generateUuid4();
  const uuidInt = encodeStandalone(
    uuidStringToBigInt(orderId),
    bootstrap.executorId,
  );
  const order: OrderTypedData = {
    user: wallet.address,
    expiration: params.expiration,
    feeBps: params.feeBps ?? 0,
    recipient: wallet.address,
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    toAmount: params.toAmount,
    initialDepositAmount: params.initialDepositAmount,
    uuid: uuidInt.toString(),
  };
  const orderPayload = buildOrderTypedData(bootstrap.domain, order);
  const signature = await wallet.signTypedData({
    domain: orderPayload.domain,
    types: orderPayload.types,
    primaryType: orderPayload.primaryType,
    message: orderPayload.message as unknown as Record<string, unknown>,
  });

  const submitted = await utils.client.dex.ordersSubmit.mutate({
    orderId,
    uuidInt: uuidInt.toString(),
    fromAddress: market.base_address,
    toAddress: market.quote_address,
    side,
    amount: baseAmountHuman,
    price: priceHuman,
    owner: wallet.address,
    expiration: params.expiration,
    signature,
  });

  await utils.client.p2p.commitOrder.mutate({
    adId,
    settlementOrderId: submitted.orderId,
    settlementOrderUuidInt: submitted.uuidInt,
  });

  return submitted;
}

/**
 * Companion cancel orchestrator. Used by MeTab "Cancel Position".
 *
 * Per the spec, the signed CancelOrder.orderId field is the composite
 * uuid_int (uint256), but the request body must also include the
 * human-readable order_id (UUID4 string) so the venue can locate the order.
 *
 * the venue enforces a 5-minute cancel cooldown — surfaces as TOO_MANY_REQUESTS
 * inside the tRPC mutation, which the UI can show as a friendly toast.
 */
export async function runMarketMakerCancel(params: {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  /** Human-readable UUID4 order_id from when the order was placed. */
  orderId: string;
  /** Composite uuid_int (decimal string) from when the order was placed. */
  uuidInt: string;
}): Promise<void> {
  const { wallet, utils, orderId, uuidInt } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  const { domain } = await utils.client.dex.bootstrap.query();
  // The signed CancelOrder.orderId is the uint256 uuid_int, NOT the UUID string
  const message = { owner: wallet.address, orderId: uuidInt };
  const signature = await wallet.signTypedData({
    domain,
    types: { CancelOrder: [
      { name: "owner", type: "address" },
      { name: "orderId", type: "uint256" },
    ] },
    primaryType: "CancelOrder",
    message,
  });
  await utils.client.dex.ordersCancel.mutate({
    owner: wallet.address,
    orderId,
    uuidInt,
    signature,
  });
}
