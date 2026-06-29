/**
 * ─── Peer (zkP2P) service ────────────────────────────────────────────────────
 *
 * High-level orchestration for the fiat ⇄ crypto ramp, wrapping the unified
 * `Zkp2pClient`. Persists intents/deposits to the DB so app tracks state
 * across the async pay→prove→fulfill lifecycle.
 *
 * Onramp (buy):  getBestQuotes → signalIntent → (user pays) → fulfillIntent
 * Offramp (LP):  createDeposit → setAcceptingIntents → makers field intents
 *
 * NEVER import on the client side. See docs/PEER_INTEGRATION.md.
 */
import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { apiGetOrderbook } from "@zkp2p/sdk";
import { getDb } from "../../db";
import { peerIntents, peerDeposits } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";
import {
  PEER_CHAIN_ID,
  USDC_BASE,
  USDC_BASE_TOTOKEN,
  PEER_SERVICE_ROOTS,
  usdcToBaseUnits,
  rateTo18,
  rateFrom18,
  baseUnitsToUsdc,
  type PeerSide,
} from "../../../shared/peer-config";
import { getPeerReadClient, getPeerClientForUser } from "./peerClient";

function peerBaseApiUrl(): string {
  return ENV.peerBaseApiUrl || PEER_SERVICE_ROOTS[ENV.peerRuntimeEnv].baseApiUrl;
}

const THROWAWAY_ADDR = "0x000000000000000000000000000000000000dEaD";

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable." });
  }
  return db;
}

// ─── Guards ───────────────────────────────────────────────────────────────────

export function assertPeerEnabled(): void {
  if (!ENV.peerEnabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Cash in/out is not switched on yet.",
    });
  }
}

/** Writes additionally need a Base RPC; the per-user wallet check happens later. */
export function assertPeerWriteReady(): void {
  assertPeerEnabled();
  if (!ENV.peerBaseRpcUrl) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Cash in/out is read-only until a Base connection is set up.",
    });
  }
}

function referrerFeeConfig(): { recipient: `0x${string}`; feeBps: number } | undefined {
  const r = ENV.peerReferrerFeeRecipient;
  if (r && /^0x[a-fA-F0-9]{40}$/.test(r) && ENV.peerReferrerFeeBps > 0) {
    return { recipient: r as `0x${string}`, feeBps: ENV.peerReferrerFeeBps };
  }
  return undefined;
}

// ─── Quote response shapes (documented; narrowed from the SDK return) ──────────

export interface PeerQuoteOption {
  platform: string;
  available: boolean;
  depositId?: string;
  /** Hashed payee details needed to signal an intent against this maker. */
  payeeDetails?: string;
  /** Fiat the taker pays (for the requested amount). */
  fiatAmount?: string;
  /** USDC the taker receives. */
  usdcAmount?: string;
  conversionRate?: string;
  referrerFeeAmount?: string;
  raw: unknown;
}

interface BestByPlatformRaw {
  responseObject?: {
    platformQuotes?: Array<{
      platform: string;
      available?: boolean;
      bestQuote?: {
        intent?: { depositId?: number | string; processorName?: string };
        payeeData?: unknown;
        payeeDetails?: string;
        fiatAmount?: string;
        tokenAmount?: string;
        conversionRate?: string;
        referrerFeeAmount?: string;
        [k: string]: unknown;
      };
    }>;
    quoteExpiresAt?: number;
  };
}

// ─── Onramp: quotes ────────────────────────────────────────────────────────────

export interface PeerQuoteInput {
  side: PeerSide;
  fiatCurrency: string;
  /** Human amount. Interpreted as fiat when isExactFiat (default for buy). */
  amount: string;
  isExactFiat?: boolean;
  /** Taker/recipient address; defaults to a throwaway for pure price discovery. */
  userAddress?: string;
  recipientAddress?: string;
  /** Destination chain/token for the bought asset; defaults to Base USDC. */
  destinationChainId?: number;
  destinationToken?: string;
}

export async function peerGetBestQuotes(input: PeerQuoteInput): Promise<{
  options: PeerQuoteOption[];
  expiresAt?: number;
}> {
  // Quotes are read-only price discovery — available to EVERYONE (no money flag,
  // no wallet). Resilient: any upstream failure degrades to an empty list so the
  // UI shows "no offers right now" rather than erroring.
  const client = getPeerReadClient();
  const user = input.userAddress ?? THROWAWAY_ADDR;
  const recipient = input.recipientAddress ?? user;

  let res: BestByPlatformRaw;
  try {
    res = (await client.getQuotesBestByPlatform({
      fiatCurrency: input.fiatCurrency,
      user,
      recipient,
      destinationChainId: input.destinationChainId ?? PEER_CHAIN_ID,
      destinationToken: input.destinationToken ?? USDC_BASE,
      amount: input.amount,
      isExactFiat: input.isExactFiat ?? true,
      ...(referrerFeeConfig() ? { referrerFeeConfig: referrerFeeConfig() } : {}),
    })) as unknown as BestByPlatformRaw;
  } catch (err) {
    console.warn("[peerService] getQuotesBestByPlatform failed:", err);
    return { options: [] };
  }

  const platformQuotes = res.responseObject?.platformQuotes ?? [];
  const options: PeerQuoteOption[] = platformQuotes.map((pq) => ({
    platform: pq.platform,
    available: pq.available ?? Boolean(pq.bestQuote),
    depositId: pq.bestQuote?.intent?.depositId?.toString(),
    payeeDetails: pq.bestQuote?.payeeDetails,
    fiatAmount: pq.bestQuote?.fiatAmount,
    usdcAmount: pq.bestQuote?.tokenAmount,
    conversionRate: pq.bestQuote?.conversionRate,
    referrerFeeAmount: pq.bestQuote?.referrerFeeAmount,
    raw: pq.bestQuote ?? pq,
  }));

  return { options, expiresAt: res.responseObject?.quoteExpiresAt };
}

// ─── Liquidity orderbook (the live book of makers) ─────────────────────────────

export interface PeerOrderLevel {
  depositId: string;
  /** On-chain numeric deposit id (for signalIntent). */
  depositIdOnContract: string;
  payeeDetails: string;
  depositor: string;
  platform: string;
  /** Human fiat-per-USDC price, e.g. "1.0090". */
  price: string;
  /** Spread vs 1.00 market, in %. Negative = below market (cheaper to buy). */
  spreadPct: number;
  /** USDC available at this maker. */
  usdcAvailable: string;
  minOrder: string;
  maxOrder: string;
  successRateBps: number;
}

interface RawOrderbookEntry {
  depositId?: string;
  depositIdOnContract?: string;
  payeeDetailsHash?: string;
  depositor?: string;
  paymentPlatform?: string;
  currency?: string;
  price?: string;
  availableTokenAmount?: string;
  intentAmountMin?: string;
  intentAmountMax?: string;
  successRateBps?: number;
}

export async function peerGetOrderbook(input: {
  fiatCurrency: string;
  paymentPlatform?: string;
  limit?: number;
}): Promise<{ market: number; levels: PeerOrderLevel[] }> {
  let entries: RawOrderbookEntry[] = [];
  try {
    const ob = (await apiGetOrderbook(
      {
        currency: input.fiatCurrency,
        chainId: PEER_CHAIN_ID,
        token: USDC_BASE,
        ...(input.paymentPlatform ? { paymentPlatform: input.paymentPlatform } : {}),
      },
      { baseApiUrl: peerBaseApiUrl() },
    )) as unknown as { responseObject?: { entries?: RawOrderbookEntry[] }; entries?: RawOrderbookEntry[] };
    entries = ob.responseObject?.entries ?? ob.entries ?? [];
  } catch (err) {
    console.warn("[peerService] apiGetOrderbook failed:", err);
    return { market: 1, levels: [] };
  }

  const levels: PeerOrderLevel[] = entries
    .map((e) => {
      const price = e.price ? rateFrom18(e.price) : "0";
      const priceNum = Number(price);
      return {
        depositId: e.depositId ?? "",
        depositIdOnContract: e.depositIdOnContract ?? "",
        payeeDetails: e.payeeDetailsHash ?? "",
        depositor: e.depositor ?? "",
        platform: e.paymentPlatform ?? "",
        price,
        spreadPct: priceNum > 0 ? (priceNum - 1) * 100 : 0,
        usdcAvailable: e.availableTokenAmount ? baseUnitsToUsdc(e.availableTokenAmount) : "0",
        minOrder: e.intentAmountMin ? baseUnitsToUsdc(e.intentAmountMin) : "0",
        maxOrder: e.intentAmountMax ? baseUnitsToUsdc(e.intentAmountMax) : "0",
        successRateBps: e.successRateBps ?? 0,
      };
    })
    // Keep sane, real liquidity: a price in a believable band + non-dust size.
    .filter((l) => Number(l.price) >= 0.8 && Number(l.price) <= 1.3 && Number(l.usdcAvailable) >= 1)
    .sort((a, b) => Number(a.price) - Number(b.price))
    .slice(0, input.limit ?? 60);

  return { market: 1, levels };
}

// ─── Vaults (delegated rate-management — indexer.getRateManagers) ──────────────

export interface PeerVault {
  rateManagerId: string;
  name: string;
  uri: string;
  feePct: number;
  /** Filled volume (USDC). */
  volume: number;
  /** Currently delegated balance (USDC). */
  delegated: number;
  pnlUsd: number;
  fulfilledIntents: number;
}

export async function peerGetVaults(limit = 25): Promise<PeerVault[]> {
  try {
    const client = getPeerReadClient();
    const raw = (await client.indexer.getRateManagers({ limit })) as unknown;
    const arr = (Array.isArray(raw) ? raw : (raw as { items?: unknown[] })?.items ?? []) as Array<{
      manager?: { rateManagerId?: string; name?: string; uri?: string; fee?: string };
      aggregate?: { totalFilledVolume?: string; totalPnlUsdCents?: string; currentDelegatedBalance?: string; fulfilledIntents?: number };
    }>;
    return arr
      .map((v) => ({
        rateManagerId: v.manager?.rateManagerId ?? "",
        name: v.manager?.name ?? "Vault",
        uri: v.manager?.uri ?? "",
        feePct: v.manager?.fee ? Number(rateFrom18(v.manager.fee)) * 100 : 0,
        volume: v.aggregate?.totalFilledVolume ? Number(baseUnitsToUsdc(v.aggregate.totalFilledVolume)) : 0,
        delegated: v.aggregate?.currentDelegatedBalance ? Number(baseUnitsToUsdc(v.aggregate.currentDelegatedBalance)) : 0,
        pnlUsd: v.aggregate?.totalPnlUsdCents ? Number(v.aggregate.totalPnlUsdCents) / 100 : 0,
        fulfilledIntents: v.aggregate?.fulfilledIntents ?? 0,
      }))
      .sort((a, b) => b.volume - a.volume);
  } catch (err) {
    console.warn("[peerService] getRateManagers failed:", err);
    return [];
  }
}

// ─── Leaderboard (top liquidity providers, aggregated from the live book) ──────

export interface PeerMakerRank {
  depositor: string;
  totalUsdc: number;
  deposits: number;
  platforms: string[];
  avgSuccessPct: number;
}

export async function peerGetLeaderboard(fiatCurrency = "USD", limit = 25): Promise<PeerMakerRank[]> {
  const { levels } = await peerGetOrderbook({ fiatCurrency, limit: 500 });
  const byMaker = new Map<string, { usdc: number; deposits: number; platforms: Set<string>; successSum: number }>();
  for (const l of levels) {
    if (!l.depositor) continue;
    const m = byMaker.get(l.depositor) ?? { usdc: 0, deposits: 0, platforms: new Set(), successSum: 0 };
    m.usdc += Number(l.usdcAvailable);
    m.deposits += 1;
    m.platforms.add(l.platform);
    m.successSum += l.successRateBps;
    byMaker.set(l.depositor, m);
  }
  return [...byMaker.entries()]
    .map(([depositor, m]) => ({
      depositor,
      totalUsdc: m.usdc,
      deposits: m.deposits,
      platforms: [...m.platforms],
      avgSuccessPct: m.deposits ? m.successSum / m.deposits / 100 : 0,
    }))
    .sort((a, b) => b.totalUsdc - a.totalUsdc)
    .slice(0, limit);
}

// ─── Onramp: signal intent ─────────────────────────────────────────────────────

export interface PeerSignalInput {
  side: PeerSide;
  depositId: string;
  processorName: string;
  payeeDetails: string;
  fiatCurrency: string;
  /** Human USDC amount to claim. */
  usdcAmount: string;
  /** Human fiat amount (for display/record). */
  fiatAmount: string;
  /** Human conversion rate (e.g. "1.02"). */
  conversionRate: string;
  /** Destination for the bought asset; defaults to the user's own Base address. */
  toAddress?: string;
  destinationChainId?: number;
  destinationToken?: string;
}

export async function peerSignalIntent(userId: number, input: PeerSignalInput): Promise<{
  rowId: number;
  signalTxHash: string;
  intentHash?: string;
}> {
  assertPeerWriteReady();
  const per = await getPeerClientForUser(userId);
  if (!per) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a wallet first." });
  }
  const { client, address } = per;
  const toAddress = (input.toAddress ?? address) as `0x${string}`;

  const fee = referrerFeeConfig();
  const signalTxHash = (await client.signalIntent({
    depositId: input.depositId,
    amount: usdcToBaseUnits(input.usdcAmount),
    toAddress,
    processorName: input.processorName,
    payeeDetails: input.payeeDetails,
    fiatCurrencyCode: input.fiatCurrency,
    conversionRate: rateTo18(input.conversionRate),
    ...(fee ? { referrerFeeConfig: fee } : {}),
  })) as unknown as string;

  // Resolve the intent hash from the user's on-chain intents (newest for this
  // deposit). Runtime-verify on a funded wallet — see docs/PEER_INTEGRATION.md.
  let intentHash: string | undefined;
  try {
    const intents = (await client.getAccountIntents(address)) as unknown as Array<{
      intentHash?: string;
      depositId?: string | number | bigint;
    }>;
    const match = intents
      .filter((i) => String(i.depositId) === String(input.depositId))
      .at(-1);
    intentHash = match?.intentHash;
  } catch (err) {
    console.warn("[peerService] getAccountIntents after signal failed:", err);
  }

  const db = await requireDb();
  const [ins] = await db.insert(peerIntents).values({
    userId,
    side: input.side,
    intentHash: intentHash ?? null,
    depositId: input.depositId,
    paymentPlatform: input.processorName,
    fiatCurrency: input.fiatCurrency,
    fiatAmount: input.fiatAmount,
    usdcAmount: input.usdcAmount,
    conversionRate: rateTo18(input.conversionRate).toString(),
    destinationChainId: input.destinationChainId ?? PEER_CHAIN_ID,
    destinationToken: input.destinationToken ?? USDC_BASE_TOTOKEN,
    recipientAddress: toAddress,
    payeeDetails: input.payeeDetails,
    status: "signaled",
    signalTxHash,
    referrerFeeBps: fee?.feeBps ?? null,
  });

  return { rowId: Number(ins.insertId), signalTxHash, intentHash };
}

// ─── Onramp: fulfill (submit the buyer-TEE payment proof) ──────────────────────

export interface PeerFulfillInput {
  intentHash: `0x${string}`;
  /**
   * Buyer-TEE proof input captured client-side in the payment WebView, or a
   * Reclaim proof object/JSON string. Passed straight to the SDK, which encodes
   * the attestation. Shape: { proofType:'buyerTee', encryptedSessionMaterial,
   * params, actionPlatform?, actionType? }.
   */
  proof: Record<string, unknown> | string;
}

export async function peerFulfillIntent(userId: number, input: PeerFulfillInput): Promise<{
  fulfillTxHash: string;
}> {
  assertPeerWriteReady();
  const per = await getPeerClientForUser(userId);
  if (!per) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a wallet first." });

  await markIntentStatus(userId, input.intentHash, "proving");
  try {
    const fulfillTxHash = (await per.client.fulfillIntent({
      intentHash: input.intentHash,
      proof: input.proof,
    })) as unknown as string;

    await updateIntentByHash(userId, input.intentHash, {
      status: "fulfilled",
      fulfillTxHash,
    });
    return { fulfillTxHash };
  } catch (err) {
    await updateIntentByHash(userId, input.intentHash, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function peerCancelIntent(userId: number, intentHash: `0x${string}`): Promise<void> {
  assertPeerWriteReady();
  const per = await getPeerClientForUser(userId);
  if (!per) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a wallet first." });
  await per.client.cancelIntent({ intentHash });
  await updateIntentByHash(userId, intentHash, { status: "cancelled" });
}

// ─── Offramp / LP: create + manage deposits ────────────────────────────────────

export interface PeerDepositPaymentLeg {
  platform: string;
  fiatCurrency: string;
  /** Human conversion rate, e.g. "1.02" USDC per 1 fiat. */
  conversionRate: string;
  /** Platform-specific payee id (Wisetag, cashtag, IBAN, …). */
  offchainId: string;
  telegramUsername?: string;
}

export interface PeerCreateDepositInput {
  /** Human USDC amount to lock. */
  amount: string;
  minIntent: string;
  maxIntent: string;
  legs: PeerDepositPaymentLeg[];
}

export async function peerCreateDeposit(userId: number, input: PeerCreateDepositInput): Promise<{
  rowId: number;
  createTxHash?: string;
}> {
  assertPeerWriteReady();
  const per = await getPeerClientForUser(userId);
  if (!per) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a wallet first." });

  const processorNames = input.legs.map((l) => l.platform);
  const payeeData = input.legs.map((l) => ({
    offchainId: l.offchainId,
    ...(l.telegramUsername ? { telegramUsername: l.telegramUsername } : {}),
  }));
  const conversionRates = input.legs.map((l) => [
    { currency: l.fiatCurrency, conversionRate: rateTo18(l.conversionRate).toString() },
  ]);

  const { hash: createTxHash } = await per.client.createDeposit({
    token: USDC_BASE,
    amount: usdcToBaseUnits(input.amount),
    intentAmountRange: { min: usdcToBaseUnits(input.minIntent), max: usdcToBaseUnits(input.maxIntent) },
    processorNames,
    payeeData,
    conversionRates,
  });

  const db = await requireDb();
  const [ins] = await db.insert(peerDeposits).values({
    userId,
    token: USDC_BASE,
    amount: input.amount,
    minIntent: input.minIntent,
    maxIntent: input.maxIntent,
    paymentConfig: JSON.stringify(input.legs),
    status: "active",
    acceptingIntents: true,
    createTxHash: createTxHash ?? null,
  });

  return { rowId: Number(ins.insertId), createTxHash };
}

export async function peerSetAcceptingIntents(
  userId: number,
  rowId: number,
  accepting: boolean,
): Promise<void> {
  assertPeerWriteReady();
  const per = await getPeerClientForUser(userId);
  if (!per) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a wallet first." });

  const db = await requireDb();
  const [row] = await db
    .select()
    .from(peerDeposits)
    .where(and(eq(peerDeposits.id, rowId), eq(peerDeposits.userId, userId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Deposit not found." });
  if (!row.depositId) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Deposit is still being created." });
  }

  await per.client.setAcceptingIntents({ depositId: BigInt(row.depositId), accepting });
  await db
    .update(peerDeposits)
    .set({ acceptingIntents: accepting, status: accepting ? "active" : "paused" })
    .where(eq(peerDeposits.id, rowId));
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function peerListUserIntents(userId: number) {
  const db = await requireDb();
  return db
    .select()
    .from(peerIntents)
    .where(eq(peerIntents.userId, userId))
    .orderBy(desc(peerIntents.createdAt))
    .limit(50);
}

export async function peerListUserDeposits(userId: number) {
  const db = await requireDb();
  return db
    .select()
    .from(peerDeposits)
    .where(eq(peerDeposits.userId, userId))
    .orderBy(desc(peerDeposits.createdAt))
    .limit(50);
}

export async function peerGetIntentRow(userId: number, rowId: number) {
  const db = await requireDb();
  const [row] = await db
    .select()
    .from(peerIntents)
    .where(and(eq(peerIntents.id, rowId), eq(peerIntents.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** On-chain status for an intent via the SDK (best-effort). */
export async function peerGetOnchainIntent(intentHash: `0x${string}`): Promise<unknown | null> {
  assertPeerEnabled();
  try {
    const client = getPeerReadClient();
    return await client.getIntent(intentHash);
  } catch (err) {
    console.warn("[peerService] getIntent failed:", err);
    return null;
  }
}

/** Mark the user's fiat as sent (onramp) — moves quoted/signaled → paid. */
export async function peerMarkPaid(userId: number, rowId: number): Promise<void> {
  const db = await requireDb();
  const row = await peerGetIntentRow(userId, rowId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
  await db.update(peerIntents).set({ status: "paid" }).where(eq(peerIntents.id, rowId));
}

// ─── DB status helpers ──────────────────────────────────────────────────────

async function markIntentStatus(userId: number, intentHash: string, status: string) {
  const db = await requireDb();
  await db
    .update(peerIntents)
    .set({ status })
    .where(and(eq(peerIntents.userId, userId), eq(peerIntents.intentHash, intentHash)));
}

async function updateIntentByHash(
  userId: number,
  intentHash: string,
  patch: Partial<{ status: string; fulfillTxHash: string; error: string }>,
) {
  const db = await requireDb();
  await db
    .update(peerIntents)
    .set(patch)
    .where(and(eq(peerIntents.userId, userId), eq(peerIntents.intentHash, intentHash)));
}
