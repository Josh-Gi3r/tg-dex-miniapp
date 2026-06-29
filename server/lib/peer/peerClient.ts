/**
 * ─── Peer (zkP2P) client factory ─────────────────────────────────────────────
 *
 * Thin wrappers that construct `Zkp2pClient` with the right runtime env, Base
 * RPC, and (optional) curator API key. The SDK exports ONE unified client class
 * (`Zkp2pClient` === `OfframpClient`) that does quotes, intents AND deposits.
 *
 * NEVER import on the client side.
 */
import { Zkp2pClient } from "@zkp2p/sdk";
import { ENV } from "../../_core/env";
import { PEER_CHAIN_ID, PEER_SERVICE_ROOTS, type PeerRuntimeEnv } from "../../../shared/peer-config";
import { getReadWalletClient, getUserWalletClient } from "./peerWallet";

function runtimeEnv(): PeerRuntimeEnv {
  return ENV.peerRuntimeEnv;
}

function baseApiUrl(): string {
  // Explicit override wins; else derive from the runtime env. `staging` does
  // NOT auto-rewrite baseApiUrl in the SDK — we always pass it explicitly.
  if (ENV.peerBaseApiUrl) return ENV.peerBaseApiUrl;
  return PEER_SERVICE_ROOTS[runtimeEnv()].baseApiUrl;
}

export function attestationServiceUrl(): string {
  return PEER_SERVICE_ROOTS[runtimeEnv()].attestationServiceUrl;
}

// The SDK's expected walletClient type comes from the viem version it was built
// against; our viem instance is structurally identical but a distinct type
// identity, so we bridge it at this single boundary.
type PeerWalletClient = ConstructorParameters<typeof Zkp2pClient>[0]["walletClient"];

function make(walletClient: ReturnType<typeof getReadWalletClient>): Zkp2pClient {
  return new Zkp2pClient({
    walletClient: walletClient as unknown as PeerWalletClient,
    chainId: PEER_CHAIN_ID,
    runtimeEnv: runtimeEnv(),
    baseApiUrl: baseApiUrl(),
    ...(ENV.peerBaseRpcUrl ? { rpcUrl: ENV.peerBaseRpcUrl } : {}),
    ...(ENV.peerApiKey ? { apiKey: ENV.peerApiKey } : {}),
  });
}

/** Read-only client (throwaway account) — quotes, orderbook, intent/deposit reads. */
export function getPeerReadClient(): Zkp2pClient {
  return make(getReadWalletClient());
}

/**
 * Per-user client backed by the user's Base wallet — required for any write
 * (signalIntent / fulfillIntent / createDeposit). Returns null if the user has
 * no managed wallet.
 */
export async function getPeerClientForUser(
  userId: number,
): Promise<{ client: Zkp2pClient; address: `0x${string}` } | null> {
  const wallet = await getUserWalletClient(userId);
  if (!wallet) return null;
  return { client: make(wallet.walletClient), address: wallet.address };
}
