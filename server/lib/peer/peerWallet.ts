/**
 * ─── Peer Base wallet seam ───────────────────────────────────────────────────
 *
 * Peer (zkP2P) needs a viem `WalletClient` on Base (8453) to sign on-chain
 * actions (signalIntent / fulfillIntent / createDeposit). app custodies user
 * keys as AES-256-GCM ciphertext in `walletKeys` (see server/lib/crypto.ts) and
 * signs server-side — so we reuse that exact key here and produce a Base wallet
 * client from the same private key. No new custody model.
 *
 * Two clients:
 *  - `getReadWalletClient()` — a constant throwaway account, NEVER funded, used
 *    only to satisfy the SDK constructor for read-only calls (quotes, orderbook,
 *    intent/deposit reads). Mirrors the existing `0x…dEaD` swap-quote pattern.
 *  - `getUserWalletClient(userId)` — the user's real Base wallet for writes.
 *
 * NEVER import this file on the client side.
 *
 * ⚠️ Gasless: TG users hold no Base ETH. For production, route writes through a
 * relayer/paymaster via the SDK's `.prepare()` calldata (see peerService). The
 * direct-send path here works when the wallet holds Base ETH (e.g. a funded
 * test wallet) — that's the closed-test path until the paymaster is wired.
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { walletKeys } from "../../../drizzle/schema";
import { decryptPrivateKey } from "../crypto";
import { ENV } from "../../_core/env";

/** A constant, never-funded throwaway key for read-only SDK construction. */
const READ_ONLY_PK =
  "0x00000000000000000000000000000000000000000000000000000000deadbeef" as const;

function baseRpcTransport() {
  // Prefer an explicit Base RPC; fall back to viem's default Base transport.
  return ENV.peerBaseRpcUrl ? http(ENV.peerBaseRpcUrl) : http();
}

export function getBasePublicClient() {
  return createPublicClient({ chain: base, transport: baseRpcTransport() });
}

// Single factory so the read client and per-user client share ONE inferred
// walletClient type (otherwise their accounts infer as distinct types and the
// Zkp2pClient factory rejects one of them).
function walletClientForAccount(account: ReturnType<typeof privateKeyToAccount>) {
  return createWalletClient({ account, chain: base, transport: baseRpcTransport() });
}
export type BaseWalletClient = ReturnType<typeof walletClientForAccount>;

/** Read-only wallet client (throwaway account) for quotes/reads. */
export function getReadWalletClient(): BaseWalletClient {
  return walletClientForAccount(privateKeyToAccount(READ_ONLY_PK));
}

export interface UserBaseWallet {
  address: `0x${string}`;
  walletClient: BaseWalletClient;
}

/**
 * Build a Base `WalletClient` from the user's managed key. Returns null if the
 * user has no managed wallet. The same encrypted key backs the user's Sepolia
 * app wallet — an EOA private key is chain-agnostic, so it signs Base txs too.
 */
export async function getUserWalletClient(userId: number): Promise<UserBaseWallet | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(walletKeys)
    .where(eq(walletKeys.userId, userId))
    .limit(1);

  if (!row?.encryptedKey || !row.address) return null;

  let privateKey: string;
  try {
    privateKey = decryptPrivateKey(row.encryptedKey);
  } catch (err) {
    console.error(`[peerWallet] decryptPrivateKey failed for user ${userId}:`, err);
    return null;
  }

  const normalizedPk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(normalizedPk);
  return { address: account.address, walletClient: walletClientForAccount(account) };
}
