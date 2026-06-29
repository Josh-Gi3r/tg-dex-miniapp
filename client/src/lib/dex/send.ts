/**
 * ─── the venue Send / Transfer Orchestrator ───────────────────────────────────────
 *
 * Used by:
 *   - The Send tab (Send → cross-currency: swap with custom recipient,
 *     same-token: direct transfer)
 *   - The fiat-leg P2P confirmReceived flow (changer releases stablecoin
 *     to taker after confirming fiat received)
 *
 * Two entry points:
 *   - runSameTokenSend()   — direct ERC-20 transfer via POST /transfer
 *                             + sign + POST /transfer/send
 *   - runCrossTokenSend()  — swap + transfer via POST /swap with custom
 *                             recipient set on the signed Intent
 *
 * Both return a final on-chain txHash suitable for an Etherscan link.
 */

import {
  buildIntentTypedData,
  type IntentTypedData,
} from "./signing";
import { ensureVenueApiKey } from "./apiKey";
import { broadcastViaVenue } from "./broadcast";
import type { VenueWalletInfo } from "@/lib/privy/useEmbeddedWallet";
import type { trpc } from "@/lib/trpc";

interface SameTokenSendParams {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  token: string;          // ERC-20 contract address
  amount: string;         // raw uint256 as decimal
  to: string;
}

export async function runSameTokenSend(
  params: SameTokenSendParams,
): Promise<{ txHash: string }> {
  const { wallet, utils } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // /transfer requires API key — auto-provision on first call.
  await ensureVenueApiKey({ wallet, utils });

  const built = await utils.client.dex.transferBuild.mutate({
    token: params.token,
    amount: params.amount,
    to: params.to,
  });
  const tx = built.tx as { to: string; data: string; value?: string; chainId?: number };
  const txHash = await broadcastViaVenue({ wallet, utils, kind: "transfer", tx });
  return { txHash };
}

interface CrossTokenSendParams {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  recipient: string;       // who the swap output goes to
  gasMode?: "receive_less" | "pay_more";
}

export async function runCrossTokenSend(
  params: CrossTokenSendParams,
): Promise<{ txHash: string; tradeId: string }> {
  const { wallet, utils } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // /swap is signature-only but the post-trade /orders/{id} polling that
  // gets the tx hash needs an API key. Auto-provision so the user gets
  // the link instead of an empty hash.
  await ensureVenueApiKey({ wallet, utils });

  // 1. Quote
  const quote = await utils.client.dex.swapQuote.mutate({
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    recipient: params.recipient,
    gasMode: params.gasMode ?? "receive_less",
  });

  // 2. Sign Intent
  const intent: IntentTypedData = quote.routeParams;
  const payload = buildIntentTypedData(quote.domain, intent);
  const signature = await wallet.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message as unknown as Record<string, unknown>,
  });

  // 3. Permit (always sign when quote.permit is non-null — see swap.ts comment)
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

  // 4. Execute
  const exec = await utils.client.dex.swapExecute.mutate({
    quoteUuid: quote.quoteUuid,
    signature,
    permitSignature,
    permitDeadline,
  });

  // 5. Best-effort poll for the settled tx hash
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
      // tolerate transient
    }
  }

  return {
    txHash: txHash ?? "",
    tradeId: exec.tradeId,
  };
}
