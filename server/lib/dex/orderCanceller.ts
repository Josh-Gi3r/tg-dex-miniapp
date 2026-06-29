/**
 * ─── Managed-Wallet the venue Order Cancel ─────────────────────────────────────────
 *
 * Server-signs a CancelOrder and posts /orders/cancel on a managed wallet's
 * behalf. Needed to EDIT a vault-backed ad (you can't mutate a resting CLOB
 * order — you cancel + repost) and to truly retire an ad's order (the DB
 * cancelAd only flips a row; the order would otherwise keep resting).
 *
 * the venue enforces a 5-minute minimum order lifetime → 429 with Retry-After.
 * Mirrors orderSigner/swapSigner. Never throws.
 */
import { Wallet } from "ethers";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { walletKeys } from "../../../drizzle/schema";
import { decryptPrivateKey } from "../crypto";
import { getDexClient } from "./client";
import { DEX_EIP712_TYPES } from "@shared/dex-api-config";

export type CancelResult =
  | { ok: true }
  | { ok: false; code: string; detail: string; retryAfterSec?: number };

export async function signAndCancelOrder(input: {
  userId: number;
  ownerAddress: string;
  orderId: string;  // human UUID4
  uuidInt: string;  // composite uuid_int — what CancelOrder.orderId signs over
}): Promise<CancelResult> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, code: "NO_DB", detail: "DB unavailable" };
    const row = (await db.select().from(walletKeys).where(eq(walletKeys.userId, input.userId)).limit(1))[0];
    if (!row?.encryptedKey || !row.address) return { ok: false, code: "NO_WALLET", detail: "No wallet for user" };
    if (row.address.toLowerCase() !== input.ownerAddress.toLowerCase())
      return { ok: false, code: "ADDR_MISMATCH", detail: "owner != stored wallet" };
    const signer = new Wallet(decryptPrivateKey(row.encryptedKey));

    const client = getDexClient();
    const cfg = await client.getConfig();
    let signature: string;
    try {
      signature = await signer.signTypedData(
        cfg.eip712_domain,
        { CancelOrder: [...DEX_EIP712_TYPES.CancelOrder] },
        { owner: input.ownerAddress, orderId: input.uuidInt },
      );
    } catch (e) {
      return { ok: false, code: "SIGN_FAILED", detail: e instanceof Error ? e.message : String(e) };
    }

    const res = await fetch(`${client.base}/orders/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "dex-app-cancel/1" },
      body: JSON.stringify({
        owner_address: input.ownerAddress,
        order_id: input.orderId,
        uuid_int: input.uuidInt,
        signature,
      }),
    });
    if (res.status === 429) {
      const raw = res.headers.get("retry-after");
      const retryAfterSec = raw && Number.isFinite(Number(raw)) ? Math.min(Number(raw), 600) : 300;
      return { ok: false, code: "COOLDOWN", detail: "5-minute cancel cooldown", retryAfterSec };
    }
    if (!res.ok) return { ok: false, code: `CANCEL_${res.status}`, detail: (await res.text()).slice(0, 160) };
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "UNEXPECTED", detail: err instanceof Error ? err.message : String(err) };
  }
}
