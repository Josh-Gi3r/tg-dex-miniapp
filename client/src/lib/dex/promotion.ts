/**
 * ─── the venue Promotion Orchestrator ─────────────────────────────────────────────
 *
 * Drives the "buy a Pinned/Featured/Boosted promotion" flow:
 *   1. Build USDT transfer from user wallet → treasury (dex.transferBuild)
 *   2. Sign + broadcast (Privy → dex.txSend)
 *   3. Record promotion in DB with the resulting txHash (p2p.purchasePromotion)
 *
 * The treasury wallet address is fetched once via system config rather than
 * hardcoded — the server returns it from /api/dex/config when configured.
 */

import { runSameTokenSend } from "./send";
import type { VenueWalletInfo } from "@/lib/privy/useEmbeddedWallet";
import type { trpc } from "@/lib/trpc";

interface PurchasePromotionParams {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  /** USDT contract address (Sepolia or mainnet, taken from /tokens) */
  usdtAddress: string;
  /** Treasury wallet that receives the fee. */
  treasuryAddress: string;
  /** Raw uint256 USDT amount as decimal string. */
  amountRaw: string;
  /** Human-readable amount for the DB row, e.g. "5". */
  amountUsdt: string;
  adId: number;
  tier: "boosted" | "highlighted" | "pinned";
  durationHours: number;
}

export async function runPurchasePromotion(
  params: PurchasePromotionParams,
): Promise<{ txHash: string; endsAt: Date }> {
  const { wallet, utils } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // 1. Transfer USDT to treasury
  const { txHash } = await runSameTokenSend({
    wallet,
    utils,
    token: params.usdtAddress,
    amount: params.amountRaw,
    to: params.treasuryAddress,
  });

  // 2. Record promotion in DB with txHash as audit trail
  const result = await utils.client.p2p.purchasePromotion.mutate({
    adId: params.adId,
    tier: params.tier,
    amountUsdt: params.amountUsdt,
    durationHours: params.durationHours,
    txHash,
  });

  // result.endsAt is a Date when DB available, undefined when simulated
  const endsAt =
    result.endsAt instanceof Date
      ? result.endsAt
      : new Date(Date.now() + params.durationHours * 60 * 60 * 1000);
  return { txHash, endsAt };
}
