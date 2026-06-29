/**
 * ─── the venue Vault Withdraw Orchestrator ────────────────────────────────────────
 *
 * Drives the dual-signature instant-withdraw flow:
 *   1. Sign WithdrawIntent (user side)
 *   2. POST /withdraw → the venue co-signs with executor key, returns
 *      executor_signature
 *   3. POST /withdraw/build → returns unsigned tx with both sigs attached
 *   4. Sign + broadcast tx (Privy → /tx/send)
 *
 * Used by the Me tab Wallet sub-tab "Withdraw from Vault" button.
 */

import {
  buildWithdrawIntentTypedData,
  type WithdrawIntentTypedData,
} from "./signing";
import { makeRandomUuid } from "./uuidInt";
import { ensureVenueApiKey } from "./apiKey";
import { broadcastViaVenue } from "./broadcast";
import type { VenueWalletInfo } from "@/lib/privy/useEmbeddedWallet";
import type { trpc } from "@/lib/trpc";

interface WithdrawParams {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  /** Token contract addresses to withdraw. Use a single-element array for single-token withdraws. */
  tokens: string[];
  /** Raw uint256 amounts as decimal strings. Must match tokens[] length. */
  amounts: string[];
  /** Where the withdrawn funds go. Defaults to the user's own wallet. */
  recipient?: string;
  /** Withdraw deadline (unix seconds, decimal string). Defaults to +10 min. */
  deadline?: string;
}

export async function runWithdraw(
  params: WithdrawParams,
): Promise<{ txHash: string }> {
  const { wallet, utils } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // Withdraw POST endpoints accept Optional API Key — but our broadcast
  // step uses /withdraw/send which prefers attribution. Auto-provision
  // for rate-limit fairness; doesn't matter if it 404s on first request.
  await ensureVenueApiKey({ wallet, utils });

  if (params.tokens.length !== params.amounts.length) {
    throw new Error("tokens and amounts arrays must be the same length");
  }
  const recipient = params.recipient ?? wallet.address;
  // Use server time so deadlines survive Telegram WebView clock skew
  let resolvedDeadline = params.deadline;
  if (!resolvedDeadline) {
    const t = await utils.client.dex.serverTime.query();
    resolvedDeadline = String(t.timestamp + 600);
  }

  // 1. Build + sign WithdrawIntent
  const { domain } = await utils.client.dex.bootstrap.query();
  const uuid = makeRandomUuid().toString();
  const intent: WithdrawIntentTypedData = {
    user: wallet.address,
    tokens: params.tokens,
    amounts: params.amounts,
    recipient,
    deadline: resolvedDeadline,
    uuid,
  };
  const payload = buildWithdrawIntentTypedData(domain, intent);
  const userSignature = await wallet.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message as unknown as Record<string, unknown>,
  });

  // 2. Submit to /withdraw → executor co-signs (returns executor address + sig)
  const coSig = await utils.client.dex.withdrawIntent.mutate({
    tokens: params.tokens,
    amounts: params.amounts,
    recipient,
    deadline: resolvedDeadline,
    uuid,
    userSignature,
  });

  // 3. Build the unsigned tx — needs both the executor address AND its sig
  const built = await utils.client.dex.withdrawBuild.mutate({
    tokens: params.tokens,
    amounts: params.amounts,
    recipient,
    deadline: resolvedDeadline,
    uuid,
    userSignature,
    executor: coSig.executor,
    executorSignature: coSig.executorSignature,
  });

  // 4. Sign locally and broadcast through the venue's /withdraw/send relay so
  //    its selector validation runs (only accepts signed
  //    `executeInstantWithdrawDualSig` calls). Falls back to direct wallet
  //    broadcast when the wallet doesn't support eth_signTransaction.
  const tx = built.tx as { to: string; data: string; value?: string; chainId?: number };
  const txHash = await broadcastViaVenue({ wallet, utils, kind: "withdraw", tx });
  return { txHash };
}
