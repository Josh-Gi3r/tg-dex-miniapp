/**
 * ─── Managed-Wallet the venue Swap (Take an Offer) ─────────────────────────────────
 *
 * Server-signs + submits a the venue /swap on a managed wallet's behalf:
 *   quote → sign the EIP-712 Intent (+ Permit when required) → POST /swap.
 *
 * This is the missing primitive that lets the trade-on-behalf agent TAKE a
 * resting CLOB order. It mirrors the proven client take-flow (dex.swapQuote →
 * dex.swapExecute) but signs server-side with the stored key (testnet /
 * imported-key model — same as placeMakerOrder). Never throws.
 *
 * STP: the caller MUST ensure ownerAddress != the maker of the order being
 * taken — the venue rejects self-trades with STP_BLOCKED.
 */
import { Wallet } from "ethers";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { walletKeys } from "../../../drizzle/schema";
import { decryptPrivateKey } from "../crypto";
import { getDexClient } from "./client";
import { DEX_EIP712_TYPES } from "@shared/dex-api-config";

export type SwapResult =
  | { ok: true; tradeId: string; status: string; minOut: string; maxIn: string }
  | { ok: false; code: string; detail: string };

export async function signAndBroadcastSwap(input: {
  userId: number;
  ownerAddress: string;   // the taker/agent wallet (must hold fromToken)
  fromToken: string;      // token address
  toToken: string;        // token address
  fromAmountRaw: string;  // raw uint256 as decimal string
  recipient?: string;     // who RECEIVES the output (defaults to owner — set for cross-token Send)
  gasMode?: "receive_less" | "pay_more";
}): Promise<SwapResult> {
  const recipient = input.recipient ?? input.ownerAddress;
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
    const serverTime = await client.getServerTime();
    const expiration = serverTime + 600;

    // 1. Quote (Authentication: None — no bearer).
    const qres = await fetch(`${client.base}/swap/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "dex-app-agent/1" },
      body: JSON.stringify({
        from_token: input.fromToken, to_token: input.toToken, from_amount: input.fromAmountRaw,
        owner_address: input.ownerAddress, recipient, expiration,
        gas_mode: input.gasMode ?? "receive_less",
      }),
    });
    if (!qres.ok) return { ok: false, code: "QUOTE_FAILED", detail: `${qres.status}: ${(await qres.text()).slice(0, 180)}` };
    const quote = (await qres.json()) as {
      uuid: string;
      route_params: {
        taker: string; inputToken: string; outputToken: string;
        maxInputAmount: string; minOutputAmount: string; recipient: string;
        initialDepositAmount: string; uuid: string; deadline: number;
      };
      permit: null | {
        permit_supported: boolean;
        eip712: { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, unknown> };
      };
    };
    const rp = quote.route_params;

    // 2. Sign the Intent — route_params verbatim, do NOT regenerate fields.
    let signature: string;
    try {
      signature = await signer.signTypedData(
        cfg.eip712_domain,
        { Intent: [...DEX_EIP712_TYPES.Intent] },
        {
          taker: rp.taker, inputToken: rp.inputToken, outputToken: rp.outputToken,
          maxInputAmount: rp.maxInputAmount, minOutputAmount: rp.minOutputAmount,
          recipient: rp.recipient, initialDepositAmount: rp.initialDepositAmount,
          uuid: rp.uuid, deadline: rp.deadline,
        },
      );
    } catch (e) {
      return { ok: false, code: "SIGN_FAILED", detail: e instanceof Error ? e.message : String(e) };
    }

    // 3. Permit — sign when the quote ships a non-null permit block (per spec,
    //    always sign when present, not only when permit_required).
    let permitSignature: string | undefined;
    let permitDeadline: number | undefined;
    if (quote.permit) {
      if (!quote.permit.permit_supported)
        return { ok: false, code: "PERMIT_UNSUPPORTED", detail: "input token needs pre-approval (no EIP-2612)" };
      const p = quote.permit.eip712;
      try {
        permitSignature = await signer.signTypedData(p.domain, { Permit: p.types.Permit ?? [...DEX_EIP712_TYPES.Permit] }, p.message);
        permitDeadline = Number((p.message as { deadline: number | string }).deadline);
      } catch (e) {
        return { ok: false, code: "PERMIT_SIGN_FAILED", detail: e instanceof Error ? e.message : String(e) };
      }
    }

    // 4. Submit.
    const sres = await fetch(`${client.base}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "dex-app-agent/1" },
      body: JSON.stringify({ uuid: quote.uuid, signature, permit_signature: permitSignature, permit_deadline: permitDeadline }),
    });
    if (!sres.ok) return { ok: false, code: `SWAP_${sres.status}`, detail: (await sres.text()).slice(0, 180) };
    const body = (await sres.json()) as { trade_id: string; status: string };
    return { ok: true, tradeId: body.trade_id, status: body.status, minOut: rp.minOutputAmount, maxIn: rp.maxInputAmount };
  } catch (err) {
    return { ok: false, code: "UNEXPECTED", detail: err instanceof Error ? err.message : String(err) };
  }
}
