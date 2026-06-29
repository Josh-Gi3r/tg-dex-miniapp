/**
 * ─── Managed-Wallet Signing Service ──────────────────────────────────────────
 *
 * Decrypts the maker's managed-shop-wallet private key and signs the
 * the venue-build txs needed by the refund + recycle workers. This is the piece
 * v3 left as "scaffolded only" — the workers enqueued legs but couldn't
 * actually sign + broadcast.
 *
 * Architecture:
 *   1. Load encrypted key from wallet_keys for the maker user
 *   2. Decrypt via crypto.ts decryptPrivateKey (JWT_SECRET-derived AES-GCM)
 *   3. Build the unsigned tx via the venue /transfer or /deposit + maker creds
 *   4. Sign the unsigned tx with the managed-wallet key (ethers.Wallet)
 *   5. Broadcast via the venue /tx/send or /transfer/send
 *   6. Return the tx hash for the leg row update
 *
 * Strict guard: any signing operation re-checks the managed wallet's
 * killed flag + caps just before signing. If killed mid-flight, abort.
 */

import { Wallet, JsonRpcProvider } from "ethers";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db";
import { managedWalletCaps, walletKeys } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";
import { decryptPrivateKey } from "../crypto";
import { getDexClient } from "./client";
import { getDecryptedDexCreds } from "./apiKey";
import { getActiveRpcUrl } from "./txVerifier";

export interface SignAndBroadcastTransferInput {
  userId: number;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  amountRaw: string;
}

export interface SignAndBroadcastDepositInput {
  userId: number;
  ownerAddress: string;
  tokenAddress: string;
  amountRaw: string;
}

export interface SignAndBroadcastWithdrawInput {
  userId: number;            // maker's user id (signs the WithdrawIntent)
  ownerAddress: string;      // maker wallet address (= signer)
  tokenAddress: string;      // token to withdraw from maker's the venue vault
  amountRaw: string;         // uint256 string
  recipient: string;         // taker wallet address (recipient of the withdraw)
  deadlineSeconds?: number;  // override default deadline (default: now + 600s)
}

export type WalletSignResult =
  | { ok: true; txHash: string }
  | { ok: false; code: WalletSignFailCode; detail: string };

export type WalletSignFailCode =
  | "NO_MANAGED_WALLET"
  | "WALLET_ADDRESS_MISMATCH"
  | "WALLET_KILLED"
  | "WALLET_DISABLED"
  | "NO_VENUE_CREDS"
  | "VENUE_BUILD_FAILED"
  | "SIGN_FAILED"
  | "BROADCAST_FAILED";

interface TxEnvelope {
  to: string;
  data: string;
  value: string;
  chainId: number;
  nonce: number;
  gas: string;
  type?: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

async function loadManagedWallet(userId: number): Promise<{
  address: string;
  signer: Wallet;
} | null> {
  const db = await getDb();
  if (!db) return null;

  const row = (await db
    .select()
    .from(walletKeys)
    .where(eq(walletKeys.userId, userId))
    .limit(1))[0];
  if (!row?.encryptedKey || !row.address) return null;

  let privateKey: string;
  try {
    privateKey = decryptPrivateKey(row.encryptedKey);
  } catch (err) {
    console.error(`[walletSigner] decryptPrivateKey failed for user ${userId}:`, err);
    return null;
  }

  const signer = new Wallet(privateKey);
  return { address: row.address.toLowerCase(), signer };
}

async function assertWalletActive(userId: number): Promise<WalletSignResult | null> {
  const db = await getDb();
  if (!db) return { ok: false, code: "NO_MANAGED_WALLET", detail: "DB unavailable" };

  const cap = (await db
    .select()
    .from(managedWalletCaps)
    .where(eq(managedWalletCaps.userId, userId))
    .limit(1))[0];
  if (!cap) return { ok: false, code: "NO_MANAGED_WALLET", detail: "No managed wallet record" };
  if (!cap.enabled) return { ok: false, code: "WALLET_DISABLED", detail: "Managed wallet disabled" };
  if (cap.killed) return { ok: false, code: "WALLET_KILLED", detail: cap.killReason ?? "killed" };
  return null;
}

async function signTxEnvelope(signer: Wallet, env: TxEnvelope): Promise<string> {
  return await signer.signTransaction({
    to: env.to,
    data: env.data,
    value: BigInt(env.value),
    chainId: BigInt(env.chainId),
    nonce: env.nonce,
    gasLimit: BigInt(env.gas),
    maxFeePerGas: env.maxFeePerGas ? BigInt(env.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: env.maxPriorityFeePerGas
      ? BigInt(env.maxPriorityFeePerGas)
      : undefined,
    type: env.type ?? 2,
  });
}

/**
 * Sign + broadcast an ERC-20 transfer using the managed wallet.
 * Used for refund leg (return payment) and any standalone transfer.
 */
export async function signAndBroadcastTransfer(
  input: SignAndBroadcastTransferInput,
): Promise<WalletSignResult> {
  const guard = await assertWalletActive(input.userId);
  if (guard) return guard;

  const wallet = await loadManagedWallet(input.userId);
  if (!wallet) {
    return { ok: false, code: "NO_MANAGED_WALLET", detail: "Cannot load managed wallet" };
  }
  if (wallet.address !== input.fromAddress.toLowerCase()) {
    return {
      ok: false,
      code: "WALLET_ADDRESS_MISMATCH",
      detail: `Managed wallet ${wallet.address} != expected ${input.fromAddress}`,
    };
  }

  const creds = await getDecryptedDexCreds(input.userId);
  if (!creds) return { ok: false, code: "NO_VENUE_CREDS", detail: "venue API key not provisioned" };

  const dexClient = getDexClient();

  let txEnvelope: TxEnvelope;
  try {
    const buildRes = await dexClient.post<{ tx: TxEnvelope }>(
      "/transfer",
      {
        token: input.tokenAddress,
        to: input.toAddress,
        amount: input.amountRaw,
        from_address: input.fromAddress,
      },
      creds,
    );
    txEnvelope = buildRes.tx;
  } catch (err) {
    return {
      ok: false,
      code: "VENUE_BUILD_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let signedRawTx: string;
  try {
    signedRawTx = await signTxEnvelope(wallet.signer, txEnvelope);
  } catch (err) {
    return { ok: false, code: "SIGN_FAILED", detail: err instanceof Error ? err.message : String(err) };
  }

  try {
    const sendRes = await dexClient.post<{ tx_hash: string }>(
      "/transfer/send",
      { raw_tx: signedRawTx },
      creds,
    );
    return { ok: true, txHash: sendRes.tx_hash };
  } catch (err) {
    return {
      ok: false,
      code: "BROADCAST_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sign + broadcast a the venue vault deposit using the managed wallet.
 * Used for recycle leg (deposit received payment back to vault).
 *
 * v1 assumption: maker has already granted the venue vault allowance for this
 * token. If not, the deposit reverts + the recycle retry worker re-attempts
 * (3 max). A managed-wallet auto-approve flow can be added in v2.
 */
export async function signAndBroadcastDeposit(
  input: SignAndBroadcastDepositInput,
): Promise<WalletSignResult> {
  const guard = await assertWalletActive(input.userId);
  if (guard) return guard;

  const wallet = await loadManagedWallet(input.userId);
  if (!wallet) return { ok: false, code: "NO_MANAGED_WALLET", detail: "Cannot load managed wallet" };
  if (wallet.address !== input.ownerAddress.toLowerCase()) {
    return {
      ok: false,
      code: "WALLET_ADDRESS_MISMATCH",
      detail: `Managed wallet ${wallet.address} != expected ${input.ownerAddress}`,
    };
  }

  const creds = await getDecryptedDexCreds(input.userId);
  if (!creds) return { ok: false, code: "NO_VENUE_CREDS", detail: "venue API key not provisioned" };

  const dexClient = getDexClient();

  // Approve the vault to pull this token BEFORE depositing. /deposit checks
  // on-chain allowance(owner, vault) and returns 400 "Invalid request" if it's
  // insufficient. The recycle deposit moves NEWLY-received payment tokens, for
  // which there's no standing allowance — so approve first, every time.
  try {
    const cfg = await dexClient.getConfig();
    const approveBuild = await dexClient.post<{ tx: TxEnvelope }>(
      "/approve",
      { token: input.tokenAddress, owner: input.ownerAddress, spender: cfg.vault_address, amount: input.amountRaw },
      creds,
    );
    const approveSigned = await signTxEnvelope(wallet.signer, approveBuild.tx);
    const approveSend = await dexClient.post<{ tx_hash: string }>("/tx/send", { raw_tx: approveSigned }, creds);
    // Wait for the approve to CONFIRM on-chain before /deposit reads the
    // allowance — a fixed delay isn't enough under variable Sepolia gas.
    if (approveSend.tx_hash) {
      const provider = new JsonRpcProvider(getActiveRpcUrl());
      await provider.waitForTransaction(approveSend.tx_hash, 1, 90000);
    }
  } catch (err) {
    return {
      ok: false,
      code: "VENUE_BUILD_FAILED",
      detail: `approve-before-deposit failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let txEnvelope: TxEnvelope;
  try {
    const buildRes = await dexClient.post<{ tx: TxEnvelope }>(
      "/deposit",
      {
        token: input.tokenAddress,
        owner: input.ownerAddress,
        amount: input.amountRaw,
      },
      creds,
    );
    txEnvelope = buildRes.tx;
  } catch (err) {
    return {
      ok: false,
      code: "VENUE_BUILD_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let signedRawTx: string;
  try {
    signedRawTx = await signTxEnvelope(wallet.signer, txEnvelope);
  } catch (err) {
    return { ok: false, code: "SIGN_FAILED", detail: err instanceof Error ? err.message : String(err) };
  }

  try {
    const sendRes = await dexClient.post<{ tx_hash: string }>(
      "/tx/send",
      { raw_tx: signedRawTx },
      creds,
    );
    return { ok: true, txHash: sendRes.tx_hash };
  } catch (err) {
    return {
      ok: false,
      code: "BROADCAST_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sign + broadcast a the venue vault withdraw using the managed wallet.
 * Used for the release leg of 3-leg burst settlement: maker.vault → taker.wallet.
 *
 * Full /withdraw flow (3 the venue calls):
 *   1. Sign WithdrawIntent EIP-712 with maker's key
 *   2. POST /withdraw {intent, user_signature} → returns executor + executor_signature
 *   3. POST /withdraw/build {intent, both_signatures} → returns tx envelope
 *   4. Sign tx envelope with maker's key (transaction signature)
 *   5. POST /tx/send {raw_tx} → returns tx_hash
 *
 * EIP-712 WithdrawIntent struct (from docs/API_REFERENCE.md):
 *   { user: address, tokens: address[], amounts: uint256[], recipient: address,
 *     deadline: uint256, uuid: uint256 }
 */
export async function signAndBroadcastWithdraw(
  input: SignAndBroadcastWithdrawInput,
): Promise<WalletSignResult> {
  const guard = await assertWalletActive(input.userId);
  if (guard) return guard;

  const wallet = await loadManagedWallet(input.userId);
  if (!wallet) {
    return { ok: false, code: "NO_MANAGED_WALLET", detail: "Cannot load managed wallet" };
  }
  if (wallet.address !== input.ownerAddress.toLowerCase()) {
    return {
      ok: false,
      code: "WALLET_ADDRESS_MISMATCH",
      detail: `Managed wallet ${wallet.address} != expected ${input.ownerAddress}`,
    };
  }

  // /tx/send requires the maker's venue API key (Bearer). /withdraw and
  // /withdraw/build are signature-only, but the final broadcast is auth'd.
  const creds = await getDecryptedDexCreds(input.userId);
  if (!creds) return { ok: false, code: "NO_VENUE_CREDS", detail: "venue API key not provisioned" };

  const dexClient = getDexClient();

  // EIP-712 domain from /config — the venue contract is verifyingContract in the domain.
  let domain: { name: string; version: string; chainId: number; verifyingContract: string };
  try {
    const configRes = await dexClient.getConfig();
    domain = configRes.eip712_domain;
  } catch (err) {
    return {
      ok: false,
      code: "VENUE_BUILD_FAILED",
      detail: `Failed to fetch /config for EIP-712 domain: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Generate a fresh uuid for this withdraw (uint256 — 256-bit random).
  const uuidBytes = randomBytes(32);
  let uuidBigInt = 0n;
  for (const b of uuidBytes) uuidBigInt = (uuidBigInt << 8n) | BigInt(b);
  const uuid = uuidBigInt.toString();

  const deadlineSec = input.deadlineSeconds ?? Math.floor(Date.now() / 1000) + 600;

  const intent = {
    user: input.ownerAddress.toLowerCase(),
    tokens: [input.tokenAddress.toLowerCase()],
    amounts: [input.amountRaw],
    recipient: input.recipient.toLowerCase(),
    deadline: deadlineSec.toString(),
    uuid,
  };

  // Step 1: Sign WithdrawIntent EIP-712 with maker's key
  const types = {
    WithdrawIntent: [
      { name: "user", type: "address" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "uuid", type: "uint256" },
    ],
  };

  let userSignature: string;
  try {
    userSignature = await wallet.signer.signTypedData(domain, types, intent);
  } catch (err) {
    return {
      ok: false,
      code: "SIGN_FAILED",
      detail: `WithdrawIntent typed-data sign failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Step 2: POST /withdraw with intent + user_signature → executor co-signs
  let executor: string;
  let executorSignature: string;
  try {
    const withdrawRes = await dexClient.post<{
      success: boolean;
      executor_address: string;
      executor_signature: string;
      error: string | null;
    }>("/withdraw", { intent, user_signature: userSignature });
    if (!withdrawRes.success) {
      return {
        ok: false,
        code: "VENUE_BUILD_FAILED",
        detail: `the venue /withdraw error: ${withdrawRes.error ?? "unknown"}`,
      };
    }
    executor = withdrawRes.executor_address;
    executorSignature = withdrawRes.executor_signature;
  } catch (err) {
    return {
      ok: false,
      code: "VENUE_BUILD_FAILED",
      detail: `the venue /withdraw failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Step 3: POST /withdraw/build with intent + both sigs → tx envelope
  let txEnvelope: TxEnvelope;
  try {
    const buildRes = await dexClient.post<{ tx: TxEnvelope }>("/withdraw/build", {
      intent,
      user_signature: userSignature,
      executor,
      executor_signature: executorSignature,
    });
    txEnvelope = buildRes.tx;
  } catch (err) {
    return {
      ok: false,
      code: "VENUE_BUILD_FAILED",
      detail: `the venue /withdraw/build failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Step 4: Sign tx envelope (maker pays gas for the withdraw broadcast)
  let signedRawTx: string;
  try {
    signedRawTx = await signTxEnvelope(wallet.signer, txEnvelope);
  } catch (err) {
    return { ok: false, code: "SIGN_FAILED", detail: err instanceof Error ? err.message : String(err) };
  }

  // Step 5: POST /withdraw/send to broadcast (NOT /tx/send — withdraw has its
  // own broadcast endpoint. Optional API key, but we pass creds anyway).
  try {
    const sendRes = await dexClient.post<{ tx_hash: string }>("/withdraw/send", { raw_tx: signedRawTx }, creds);
    return { ok: true, txHash: sendRes.tx_hash };
  } catch (err) {
    return {
      ok: false,
      code: "BROADCAST_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
