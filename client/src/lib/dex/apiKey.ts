/**
 * ─── the venue API Key Provisioning Orchestrator ──────────────────────────────────
 *
 * Drives the per-user API key creation flow described in the venue's
 * Authentication docs:
 *
 *   1. server.dex.apiKeyPrepare returns the unsigned ManageApiKey typed-data
 *      (owner = wallet, action = "create", timestamp = server time)
 *   2. Client signs via Privy with the EIP-712 domain from /config
 *   3. server.dex.apiKeyComplete posts {owner_address, action, timestamp,
 *      signature, label?} to POST /api-keys, encrypts the returned secret,
 *      and persists it to users.dexApiKey/dexApiSecret
 *
 * After this runs, all authenticated the venue reads + transaction builders work
 * for this user (balances, permit/metadata, deposit/approve, transfer,
 * orders/{id}, etc.). EIP-712-only mutations (swap, orders, withdraw)
 * already work without a key, but attaching the key gets per-wallet
 * rate-limit attribution.
 *
 * Each Privy wallet may hold up to 10 active API keys. The label defaults
 * to "the app TG App" so the user can identify them in the venue's dashboard.
 */

import { buildManageApiKeyTypedData } from "./signing";
import type { VenueWalletInfo } from "@/lib/privy/useEmbeddedWallet";
import type { trpc } from "@/lib/trpc";

export interface ApiKeyProvisionResult {
  apiKey: string;
}

/**
 * Ensures the user has a the venue API key, provisioning one only if missing.
 * Cheap query when the key already exists; one wallet popup when not.
 *
 * Use this at the entry point of any orchestrator that hits an API-key-gated
 * endpoint (deposit, transfer, balances, /tx/send, /orders/{id} polling).
 * Keeps the UX seamless: no upfront mandatory provisioning step, just a
 * one-time prompt the first time a user does something that needs reads
 * or transaction-builder access.
 */
export async function ensureVenueApiKey(params: {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  label?: string;
}): Promise<{ alreadyProvisioned: boolean }> {
  const has = await params.utils.client.dex.hasApiKey.query();
  if (has) return { alreadyProvisioned: true };
  await provisionDexApiKey(params);
  // Invalidate so any active hasApiKey query in the UI updates banners
  await params.utils.dex.hasApiKey.invalidate();
  return { alreadyProvisioned: false };
}

export async function provisionDexApiKey(params: {
  wallet: VenueWalletInfo;
  utils: ReturnType<typeof trpc.useUtils>;
  /** Optional human-readable label shown in the venue's dashboard. */
  label?: string;
}): Promise<ApiKeyProvisionResult> {
  const { wallet, utils } = params;
  if (!wallet.address) throw new Error("Wallet not connected");

  // 1. Get the unsigned ManageApiKey typed-data (server pulls timestamp
  //    from /system/time so it's within the venue's 5-minute clock-skew window)
  const prepared = await utils.client.dex.apiKeyPrepare.mutate({ action: "create" });

  // 2. Sign — the the venue EIP-712 domain comes from /config, returned by prepare
  const payload = buildManageApiKeyTypedData(prepared.domain, {
    owner: prepared.message.owner,
    action: prepared.message.action as "create",
    timestamp: prepared.message.timestamp,
  });
  const signature = await wallet.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message as unknown as Record<string, unknown>,
  });

  // 3. Submit signature to POST /api-keys via the server proxy (which
  //    encrypts + stores the returned secret)
  const result = await utils.client.dex.apiKeyComplete.mutate({
    action: "create",
    timestamp: prepared.message.timestamp,
    signature,
    label: params.label ?? "the app TG App",
  });

  return { apiKey: result.apiKey };
}
