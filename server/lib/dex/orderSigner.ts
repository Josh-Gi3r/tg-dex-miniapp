/**
 * ─── Managed-Wallet the venue Order Placement ─────────────────────────────────────
 *
 * Signs + posts a REAL the venue limit order on a maker's behalf using their
 * managed-shop-wallet key. This is what turns a P2P ad from a DB row into
 * live, vault-backed liquidity on the the venue CLOB.
 *
 * Proven on testnet 2026-05-29 (shop 1 ask, XSGD/USDT). Mirrors the
 * dex-agents/templates/market-maker order-signer + uuid-int recipe.
 *
 * EIP-712 Order struct uses SPEND/RECEIVE semantics (maker gives fromToken,
 * receives toToken). The POST /orders body uses MARKET base/quote + a side
 * flag — both are derived here from the market orientation so the signed
 * struct and the wire payload always agree (a mismatch is rejected by the venue).
 */
import { Wallet } from "ethers";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { walletKeys } from "../../../drizzle/schema";
import { decryptPrivateKey } from "../crypto";
import { getDexClient } from "./client";

const ORDER_TYPES = {
  Order: [
    { name: "user", type: "address" },
    { name: "expiration", type: "uint48" },
    { name: "feeBps", type: "uint48" },
    { name: "recipient", type: "address" },
    { name: "fromToken", type: "address" },
    { name: "toToken", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "toAmount", type: "uint256" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
  ],
};
const ZERO = "0x0000000000000000000000000000000000000000";

export type PlaceMakerOrderResult =
  | { ok: true; orderId: string; uuidInt: string; side: "ask" | "bid"; price: number; amountBase: number }
  | { ok: false; code: string; detail: string };

function packUuidInt(executorId: bigint, uuidBits: bigint, groupId: bigint, legId: bigint): bigint {
  return (executorId << 252n) | (uuidBits << 124n) | (groupId << 12n) | legId;
}
function makeOrderId(executorId: bigint): { orderId: string; uuidInt: string } {
  const uuid = randomUUID();
  const bits = BigInt("0x" + uuid.replace(/-/g, ""));
  return { orderId: uuid, uuidInt: packUuidInt(executorId, bits, bits >> 16n, 0n).toString() };
}
function toRaw(human: number | string, decimals: number): bigint {
  const [i, f = ""] = human.toString().split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
/**
 * Place a real the venue limit order for a maker selling `fromSymbol` to receive
 * `toSymbol`: provides `liquidity` units of fromSymbol at `rate` (toSymbol per
 * fromSymbol). Resolves the market, derives side/amount/price, signs with the
 * managed wallet, posts to /orders. Never throws.
 */
export async function placeMakerOrder(input: {
  userId: number;
  ownerAddress: string;
  fromSymbol: string;
  toSymbol: string;
  liquidity: number; // human units of fromSymbol the maker is offering
  rate: number;      // toSymbol per fromSymbol
  expirationSeconds?: number;
}): Promise<PlaceMakerOrderResult> {
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
    const executorId = BigInt((await client.getHealth()).executor_id ?? 0);
    const domain = cfg.eip712_domain;

    // Resolve tokens + market.
    const tokensRes = await client.getTokens();
    const tokens = (tokensRes as any).tokens ?? tokensRes;
    const bySym: Record<string, { addr: string; dec: number }> = {};
    for (const t of tokens) bySym[t.symbol] = { addr: t.address, dec: t.decimals };
    const from = bySym[input.fromSymbol];
    const to = bySym[input.toSymbol];
    if (!from || !to) return { ok: false, code: "UNKNOWN_TOKEN", detail: `${input.fromSymbol}/${input.toSymbol}` };

    const marketsRes = await client.getMarkets();
    const markets = (marketsRes as any).markets ?? marketsRes;
    const m = markets.find(
      (mk: any) =>
        (mk.base_symbol === input.fromSymbol && mk.quote_symbol === input.toSymbol) ||
        (mk.base_symbol === input.toSymbol && mk.quote_symbol === input.fromSymbol),
    );
    if (!m) return { ok: false, code: "NO_MARKET", detail: `No deployed market ${input.fromSymbol}/${input.toSymbol}` };

    const baseAddr = m.base_address.toLowerCase();
    const baseDec = m.base_decimals as number;
    const quoteDec = m.quote_decimals as number;
    const isAsk = from.addr.toLowerCase() === baseAddr; // maker spends base => ask

    // POST body uses MARKET base/quote + a side flag. `amount` is always in BASE;
    // `price` is quote-per-base. Derive both from the ad, round to the market's
    // precision as CLEAN decimal strings, then compute the signed raw amounts
    // FROM those rounded values — so the signed struct exactly matches what the venue
    // reconstructs from amount/price (otherwise: "Invalid signature" /
    // INVALID_PRECISION from float artifacts like 0.78371199999).
    //   ask: maker sells base(=from). base amount = liquidity, price = rate.
    //   bid: maker sells quote(=from) to buy base(=to). base amount = liquidity*rate, price = 1/rate.
    const qp = Math.max(0, Number(m.quantity_precision ?? 6));
    const tp = Math.max(0, Number(m.tick_precision ?? 6));
    const baseHuman = isAsk ? input.liquidity : input.liquidity * input.rate;
    const priceHuman = isAsk ? input.rate : 1 / input.rate;
    // Round to market precision, then format CLEAN (no trailing zeros — the venue
    // rejects "8000.000000" with INVALID_DECIMAL_FORMAT). parseFloat(toFixed)
    // gives a value with ≤precision decimals and no trailing zeros.
    const amountNum = parseFloat(baseHuman.toFixed(qp));
    const priceNum = parseFloat(priceHuman.toFixed(tp));
    const amountStr = String(amountNum);
    const priceStr = String(priceNum);
    if (!(amountNum > 0) || !(priceNum > 0))
      return { ok: false, code: "BELOW_STEP", detail: "amount/price rounds to zero — increase liquidity" };
    const minAsk = Number(m.min_ask_amount ?? 0);
    if (isAsk && minAsk && amountNum < minAsk)
      return { ok: false, code: "BELOW_MIN", detail: `amount ${amountNum} < market min ${minAsk}` };

    // Raw amounts derived from the rounded human values (match the venue's reconstruction).
    const baseAmtRaw = toRaw(amountStr, baseDec);
    const quoteAmtRaw = BigInt(Math.round(amountNum * priceNum * 10 ** quoteDec));
    const fromAmount = isAsk ? baseAmtRaw : quoteAmtRaw; // maker SPENDS this
    const toAmount = isAsk ? quoteAmtRaw : baseAmtRaw;   // maker RECEIVES this

    const expiration = Math.floor(Date.now() / 1000) + (input.expirationSeconds ?? 30 * 24 * 60 * 60);
    const ids = makeOrderId(executorId);
    const struct = {
      user: input.ownerAddress,
      expiration,
      feeBps: 0,
      recipient: ZERO,
      fromToken: from.addr,
      toToken: to.addr,
      fromAmount,
      toAmount,
      initialDepositAmount: 0n,
      uuid: BigInt(ids.uuidInt),
    };
    let signature: string;
    try {
      signature = await signer.signTypedData(domain, ORDER_TYPES, { ...struct });
    } catch (err) {
      return { ok: false, code: "SIGN_FAILED", detail: err instanceof Error ? err.message : String(err) };
    }

    try {
      const res = await client.post<{ order_id: string }>("/orders", {
        owner_address: input.ownerAddress,
        side: isAsk ? "ask" : "bid",
        amount: amountStr,
        price: priceStr,
        order_type: "limit",
        from_address: m.base_address,
        to_address: m.quote_address,
        order_id: ids.orderId,
        uuid_int: ids.uuidInt,
        signature,
        expiration,
      });
      return {
        ok: true,
        orderId: res.order_id ?? ids.orderId,
        uuidInt: ids.uuidInt,
        side: isAsk ? "ask" : "bid",
        price: priceNum,
        amountBase: amountNum,
      };
    } catch (err) {
      return { ok: false, code: "POST_FAILED", detail: err instanceof Error ? err.message : String(err) };
    }
  } catch (err) {
    return { ok: false, code: "UNEXPECTED", detail: err instanceof Error ? err.message : String(err) };
  }
}
