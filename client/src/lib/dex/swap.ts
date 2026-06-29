/**
 * ─── the venue Swap Orchestrator ──────────────────────────────────────────────────
 *
 * Drives the multi-step Take-an-Offer flow inside a single async call:
 *   1. trpc.dex.swapQuote       — server fetches quote from the venue
 *   2. wallet.signTypedData      — Privy / external wallet signs Intent
 *   3. wallet.signTypedData      — sign Permit (only when permit_required)
 *   4. trpc.dex.swapExecute     — server posts signed payload to /swap
 *   5. trpc.p2p.executeSwap      — server records the trade in our DB
 *
 * Returns the real on-chain tx hash + the venue trade_id, suitable for showing
 * an Etherscan link to the user.
 */

import type { trpc } from "@/lib/trpc";
import {
  buildIntentTypedData,
  type IntentTypedData,
} from "./signing";
import { ensureVenueApiKey } from "./apiKey";
import type { VenueWalletInfo } from "@/lib/privy/useEmbeddedWallet";

interface SwapOrchestratorParams {
  wallet: VenueWalletInfo;
  fromToken: string;        // token contract address
  toToken: string;
  fromAmount: string;        // raw uint256 as decimal string
  recipient?: string;        // defaults to user's own wallet
  /** receive_less (default) preserves spend; pay_more preserves output. */
  gasMode?: "receive_less" | "pay_more";
  /** tRPC utils returned by trpc.useUtils() — used to call procedures imperatively. */
  utils: ReturnType<typeof trpc.useUtils>;
  /** P2P ad context, recorded in our DB on success. */
  adContext: {
    adId: string;
    fromTokenSymbol: string;
    toTokenSymbol: string;
    fromAmountHuman: number;
    toAmountHuman: number;
    rateUsed: number;
    advertiserHandle?: string;
  };
}

export interface SwapOrchestratorResult {
  /** Empty until the swap settles on chain — poll dex.orderStatus. */
  txHash: string;
  tradeId: string;
  status: string;
  recordedOrderId: string;
}

export async function runSwapOrchestrator(
  params: SwapOrchestratorParams,
): Promise<SwapOrchestratorResult> {
  const { wallet, utils, adContext } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // The swap itself doesn't need an API key, but the /orders/{id} polling
  // step that surfaces the on-chain tx hash does. Auto-provision creds so
  // the user sees a real Etherscan link, not an empty hash. One wallet
  // popup the first time a user does ANY API-key-gated action.
  await ensureVenueApiKey({ wallet, utils });

  // 1. Quote — the venue returns route_params we sign verbatim. When the input
  //    token is non-equity-only, `permit` is non-null and ships pre-shaped
  //    EIP-712 typed data ready to feed straight to signTypedData.
  const quote = await utils.client.dex.swapQuote.mutate({
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    recipient: params.recipient,
    gasMode: params.gasMode ?? "receive_less",
  });

  // 2. Sign Intent — route_params verbatim, do not regenerate fields
  const intent: IntentTypedData = quote.routeParams;
  const intentPayload = buildIntentTypedData(quote.domain, intent);
  const signature = await wallet.signTypedData({
    domain: intentPayload.domain,
    types: intentPayload.types,
    primaryType: intentPayload.primaryType,
    message: intentPayload.message as unknown as Record<string, unknown>,
  });

  // 3. Sign Permit when the quote ships one. The eip712 sub-object is shaped
  //    exactly as signTypedData expects — pass through verbatim. Per spec:
  //    "permit_signature is Yes when permit != null". Always sign when present
  //    (don't gate on permit_required) — the venue rejects /swap if permit fields
  //    are missing whenever the quote has a non-null permit block.
  let permitSignature: string | undefined;
  let permitDeadline: number | undefined;
  if (quote.permit) {
    if (!quote.permit.permit_supported) {
      throw new Error(
        "Token doesn't support EIP-2612 permit — pre-approve via Wallet tab first",
      );
    }
    permitDeadline = Number(
      (quote.permit.eip712.message as { deadline: number | string }).deadline,
    );
    permitSignature = await wallet.signTypedData({
      domain: quote.permit.eip712.domain,
      types: quote.permit.eip712.types as Record<
        string,
        ReadonlyArray<{ readonly name: string; readonly type: string }>
      >,
      primaryType: quote.permit.eip712.primaryType,
      message: quote.permit.eip712.message,
    });
  }

  // 4. Execute on the venue — POST /swap takes the quote uuid (NOT route_params)
  const exec = await utils.client.dex.swapExecute.mutate({
    quoteUuid: quote.quoteUuid,
    signature,
    permitSignature,
    permitDeadline,
  });

  // 5. Poll briefly for the settled tx hash. /swap returns trade_id only;
  //    the on-chain hash surfaces via GET /orders/{id}.settlement_summary.
  //    We poll up to ~6s here so the UI can show a real Etherscan link;
  //    longer-running settlements complete in the background and the next
  //    visit to the trade history will reflect the final state.
  let txHash: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const status = await utils.client.dex.orderStatus.query({
        tradeId: exec.tradeId,
      });
      if (status.txHash) {
        txHash = status.txHash;
        break;
      }
      if (status.status === "failed" || status.status === "cancelled") break;
    } catch {
      // tolerate transient — try again
    }
  }

  // 6. Record in our DB
  const recorded = await utils.client.p2p.executeSwap.mutate({
    adId: adContext.adId,
    fromToken: adContext.fromTokenSymbol,
    toToken: adContext.toTokenSymbol,
    fromAmount: adContext.fromAmountHuman,
    toAmount: adContext.toAmountHuman,
    rateUsed: adContext.rateUsed,
    advertiserHandle: adContext.advertiserHandle,
    settlementTradeId: exec.tradeId,
    txHash: txHash ?? undefined,
  });

  return {
    txHash: txHash ?? "",
    tradeId: exec.tradeId,
    status: exec.status,
    recordedOrderId: recorded.orderId,
  };
}
