/**
 * ─── the venue API Key Provisioning ───────────────────────────────────────────────
 *
 * Each the venue user gets a personal {api_key, api_secret} pair via the
 * dual-signed POST /api-keys flow. The lifecycle:
 *
 *   1. Build ManageApiKey{owner, action: "create", timestamp} typed data
 *   2. Client signs it via Privy → user_signature
 *   3. Server signs it with the executor key → executor_signature  ← the venue-side
 *      (we ask the the venue dev team whether this is auto-handled by their
 *      gateway, or whether we need an executor secret. See the asks list.)
 *   4. POST /api-keys with both signatures → returns {api_key, api_secret}
 *   5. Encrypt api_secret with AES-256-GCM and store on users table
 *
 * The Authorization header for every authenticated the venue call becomes:
 *   Authorization: Bearer ${api_key}:${api_secret}
 */

import { eq } from "drizzle-orm";
import { Wallet } from "ethers";
import { getDb } from "../../db";
import { users, walletKeys } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";
import { decryptPrivateKey, encryptPrivateKey } from "../crypto";
import { getDexClient, DexApiError, type VenueAuthCreds } from "./client";

/**
 * Returns decrypted the venue credentials for a user, or null when not yet
 * provisioned. The credentials live behind AES-256-GCM keyed on JWT_SECRET
 * (same scheme used for legacy wallet-key storage).
 */
export async function getDecryptedDexCreds(
  userId: number,
): Promise<VenueAuthCreds | null> {
  const drizzle = await getDb();
  if (!drizzle) return null;

  const rows = await drizzle
    .select({
      apiKey: users.dexApiKey,
      encryptedSecret: users.dexApiSecret,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row?.apiKey || !row.encryptedSecret) return null;

  try {
    const apiSecret = decryptPrivateKey(row.encryptedSecret);
    return { apiKey: row.apiKey, apiSecret };
  } catch (err) {
    console.error(`[dexApiKey] Failed to decrypt secret for user ${userId}:`, err);
    return null;
  }
}

/**
 * Persists newly provisioned the venue credentials. The plaintext secret is
 * encrypted before it touches the DB.
 */
export async function storeDexCreds(params: {
  userId: number;
  apiKey: string;
  apiSecret: string;
}): Promise<void> {
  const drizzle = await getDb();
  if (!drizzle) throw new Error("DB not available");
  const encrypted = encryptPrivateKey(params.apiSecret);
  await drizzle
    .update(users)
    .set({
      dexApiKey: params.apiKey,
      dexApiSecret: encrypted,
    })
    .where(eq(users.id, params.userId));
}

/**
 * Whether a user already has the venue credentials provisioned. Cheap check
 * suitable for tRPC middleware short-circuits.
 */
export async function hasDexCreds(userId: number): Promise<boolean> {
  const drizzle = await getDb();
  if (!drizzle) return false;
  const rows = await drizzle
    .select({ apiKey: users.dexApiKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(rows[0]?.apiKey);
}

/**
 * Re-mint a user's venue API key with their stored signing wallet and persist it.
 *
 * the venue periodically WIPES/ROTATES testnet API keys — when that happens every
 * stored key (the 22 seed shops + every imported tester) starts returning 401 on
 * authed calls, so balances vanish and trades fail. It looks like "the app broke"
 * but it's just a stale key. This re-provisions on demand: load the wallet key
 * from walletKeys (same store seed shops AND imported users use), sign a fresh
 * ManageApiKey, POST /api-keys, and store the new creds. Best-effort → null on
 * any failure (no wallet, decrypt error, the venue down). Used by `withDexReauth`.
 */
export async function reprovisionDexKey(
  userId: number,
): Promise<VenueAuthCreds | null> {
  try {
    const drizzle = await getDb();
    if (!drizzle) return null;
    const row = (await drizzle
      .select({ encryptedKey: walletKeys.encryptedKey, address: walletKeys.address })
      .from(walletKeys)
      .where(eq(walletKeys.userId, userId))
      .limit(1))[0];
    if (!row?.encryptedKey || !row.address) return null;

    let privateKey: string;
    try {
      privateKey = decryptPrivateKey(row.encryptedKey);
    } catch (err) {
      console.error(`[dexApiKey] decrypt wallet key failed for user ${userId}:`, err);
      return null;
    }
    const signer = new Wallet(privateKey);
    const owner = signer.address.toLowerCase();

    const client = getDexClient();
    const cfg = await client.getConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const types = {
      ManageApiKey: [
        { name: "owner", type: "address" },
        { name: "action", type: "string" },
        { name: "timestamp", type: "uint256" },
      ],
    };
    const signature = await signer.signTypedData(cfg.eip712_domain, types, {
      owner, action: "create", timestamp,
    });
    const res = await client.post<{ api_key?: string; api_secret?: string; secret?: string }>(
      "/api-keys",
      { owner_address: owner, action: "create", timestamp, signature, label: `reauth-${owner.slice(0, 8)}` },
    );
    const apiKey = res.api_key;
    const apiSecret = res.api_secret ?? res.secret;
    if (!apiKey || !apiSecret) return null;
    await storeDexCreds({ userId, apiKey, apiSecret });
    return { apiKey, apiSecret };
  } catch (err) {
    console.warn(`[dexApiKey] reprovision failed for user ${userId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Run an authed the venue call with automatic key-rotation recovery. Fetches the
 * user's creds, runs `fn(creds)`, and if the venue answers 401 (rotated/wiped key)
 * re-provisions ONCE with the stored wallet and retries. Makes the live testnet
 * demo self-heal instead of silently dying when the venue resets keys. Non-401 errors
 * propagate unchanged. Throws if the user has no provisionable wallet at all.
 */
export async function withDexReauth<T>(
  userId: number,
  fn: (creds: VenueAuthCreds) => Promise<T>,
): Promise<T> {
  let creds = await getDecryptedDexCreds(userId);
  if (!creds) {
    creds = await reprovisionDexKey(userId);
    if (!creds) throw new Error("venue API key not provisioned — import your wallet.");
  }
  try {
    return await fn(creds);
  } catch (err) {
    if (!(err instanceof DexApiError) || err.status !== 401) throw err;
    const fresh = await reprovisionDexKey(userId);
    if (!fresh) throw err;
    return await fn(fresh);
  }
}
