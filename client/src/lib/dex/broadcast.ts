/**
 * ─── the venue Broadcast Helpers ──────────────────────────────────────────────────
 *
 * Wraps "sign locally, broadcast via the venue relay" for the three documented
 * relay endpoints (/tx/send, /transfer/send, /withdraw/send). Each has
 * stricter selector validation than direct wallet broadcast — the venue's
 * relayer rejects calls whose target/selector don't match the expected
 * pattern, which prevents us from accidentally broadcasting a malformed tx.
 *
 * Falls back to direct wallet broadcast (eth_sendTransaction) when the
 * wallet doesn't support eth_signTransaction. We bypass the venue's safety
 * check in that case but the user still gets through.
 */

import type { VenueWalletInfo } from "@/lib/privy/useEmbeddedWallet";
import type { trpc } from "@/lib/trpc";

export type BroadcastKind = "tx" | "transfer" | "withdraw";

interface BroadcastParams {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  kind: BroadcastKind;
  tx: { to: string; data: string; value?: string; chainId?: number };
}

/**
 * Signs `tx` and broadcasts it. Tries the the venue relay first
 * (sign-only → POST /tx/send / /transfer/send / /withdraw/send).
 * Falls back to direct wallet broadcast (eth_sendTransaction) if the
 * wallet doesn't expose eth_signTransaction separately.
 */
export async function broadcastViaVenue(
  params: BroadcastParams,
): Promise<string> {
  const { wallet, utils, kind, tx } = params;

  try {
    const rawTx = await wallet.signRawTransaction(tx);
    const result = await utils.client.dex.txSend.mutate({ rawTx, kind });
    return result.tx_hash;
  } catch (err: any) {
    // Wallets that don't support eth_signTransaction throw method-not-found
    // or "Method not supported". We treat any signRawTransaction failure
    // as a signal to fall back to direct broadcast — better to land the tx
    // than fail outright.
    const msg = (err?.message ?? String(err)).toLowerCase();
    const isUnsupported =
      msg.includes("not supported") ||
      msg.includes("method not found") ||
      msg.includes("not implemented") ||
      msg.includes("unsupported");
    if (!isUnsupported) {
      // Real error from the venue (bad selector, etc.) — surface it to caller
      throw err;
    }
    // Fall back: sign + broadcast directly via the wallet RPC. We lose
    // the venue's selector validation but the user still completes the action.
    return wallet.signAndSendTransaction(tx);
  }
}
