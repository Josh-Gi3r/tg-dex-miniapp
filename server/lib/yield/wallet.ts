/**
 * ─── Yield Bot — Pool Wallet ─────────────────────────────────────────────────
 *
 * Wraps the bot's pooled hot wallet behind a lazy ethers.Wallet. The
 * private key comes from YIELD_BOT_PRIVATE_KEY at boot time; if absent,
 * the wallet helper returns null and every yield endpoint short-circuits
 * to a "not configured" response. That keeps the demo deploy from
 * accidentally signing transactions.
 */

import { ethers } from "ethers";

let cached: ethers.Wallet | null | undefined;

function buildWallet(): ethers.Wallet | null {
  const key = process.env.YIELD_BOT_PRIVATE_KEY;
  if (!key) return null;
  const rpc =
    process.env.FEATURE_MAINNET === "true"
      ? process.env.MAINNET_RPC_URL
      : process.env.SEPOLIA_RPC_URL;
  if (!rpc) return null;
  const provider = new ethers.JsonRpcProvider(rpc);
  return new ethers.Wallet(key, provider);
}

export function getYieldBotWallet(): ethers.Wallet | null {
  if (cached === undefined) cached = buildWallet();
  return cached;
}

export function isYieldBotConfigured(): boolean {
  return getYieldBotWallet() !== null;
}

export function getYieldBotAddress(): string | null {
  return getYieldBotWallet()?.address ?? null;
}
