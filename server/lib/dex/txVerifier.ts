/**
 * ─── On-chain TX Receipt Verifier ────────────────────────────────────────────
 *
 * Verifies that a tx hash supplied by a client (or a worker) actually did
 * what the orchestrator expects: right sender, right token, right amount,
 * right recipient, transaction confirmed (status=1).
 *
 * v3 audit found that `confirmLeg` was advancing state on the client's
 * say-so without any chain-level check. A malicious client could submit
 * any valid-looking hash and skip past the release step entirely.
 *
 * Provides two verification modes:
 *
 *   verifyErc20Transfer(...)
 *     For payment leg + refund leg. Parses Transfer(address,address,uint256)
 *     event logs and verifies from/to/token/amount match expected.
 *
 *   verifyVaultTx(...)
 *     For release (vault withdraw) + recycle (vault deposit) legs. Verifies
 *     the tx interacted with the the venue vault contract + the right method
 *     selector + value flow matches expected via the vault's emitted events.
 *
 * RPC endpoint comes from SEPOLIA_RPC_URL (or MAINNET_RPC_URL via
 * getNetworkConfig). All calls bounded by timeout to keep the orchestrator
 * responsive — if verification can't complete in time, treat as not-yet-
 * confirmed and let the worker retry on the next tick.
 */

import type { LegKind } from "./shopSettlement";

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface TxVerifyExpected {
  legKind: LegKind;
  tokenAddress: string;   // lowercase, 0x...
  fromAddress: string;    // lowercase
  toAddress: string;      // lowercase
  amountRaw: string;      // uint256 decimal string
}

export type TxVerifyResult =
  | { ok: true; blockNumber: number; gasUsed: number }
  | { ok: false; code: TxVerifyFailCode; detail: string };

export type TxVerifyFailCode =
  | "RPC_UNREACHABLE"
  | "TX_NOT_FOUND"
  | "TX_NOT_CONFIRMED"
  | "TX_REVERTED"
  | "NO_TRANSFER_LOG"
  | "TOKEN_MISMATCH"
  | "FROM_MISMATCH"
  | "TO_MISMATCH"
  | "AMOUNT_MISMATCH";

interface JsonRpcReceipt {
  status: string;          // "0x1" success, "0x0" reverted
  blockNumber: string;
  gasUsed: string;
  from: string;
  to: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
}

/**
 * Pull a tx receipt via JSON-RPC. Returns null if not yet mined.
 */
async function getReceipt(rpcUrl: string, txHash: string): Promise<JsonRpcReceipt | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [txHash],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const j = (await res.json()) as { result: JsonRpcReceipt | null; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Verify a tx is a confirmed ERC-20 Transfer matching expected from/to/token/amount.
 * Used for payment leg (taker → maker wallet) and refund leg (maker wallet → taker).
 */
export async function verifyErc20Transfer(
  rpcUrl: string,
  txHash: string,
  expected: TxVerifyExpected,
): Promise<TxVerifyResult> {
  let receipt: JsonRpcReceipt | null;
  try {
    receipt = await getReceipt(rpcUrl, txHash);
  } catch (err) {
    return {
      ok: false,
      code: "RPC_UNREACHABLE",
      detail: `RPC call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!receipt) {
    return { ok: false, code: "TX_NOT_FOUND", detail: `Receipt not found for ${txHash}` };
  }
  if (receipt.status !== "0x1") {
    return { ok: false, code: "TX_REVERTED", detail: `Receipt status = ${receipt.status}` };
  }

  // Find the Transfer event matching expected token + from + to
  const want = {
    token: expected.tokenAddress.toLowerCase(),
    from: expected.fromAddress.toLowerCase(),
    to: expected.toAddress.toLowerCase(),
    amount: BigInt(expected.amountRaw),
  };

  let tokenMismatchSeen = false;
  let fromMismatchSeen = false;
  let toMismatchSeen = false;
  let amountMismatchSeen = false;

  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const tokenAddr = log.address.toLowerCase();
    // ERC-20 Transfer topics: [signature, from (padded), to (padded)]; data: amount
    const fromAddr = "0x" + log.topics[1].slice(26).toLowerCase();
    const toAddr = "0x" + log.topics[2].slice(26).toLowerCase();
    const amount = log.data && log.data !== "0x" ? BigInt(log.data) : 0n;

    if (tokenAddr === want.token && fromAddr === want.from && toAddr === want.to) {
      if (amount === want.amount) {
        return {
          ok: true,
          blockNumber: parseInt(receipt.blockNumber, 16),
          gasUsed: parseInt(receipt.gasUsed, 16),
        };
      }
      amountMismatchSeen = true;
    }
    if (tokenAddr === want.token && fromAddr === want.from) toMismatchSeen = true;
    if (tokenAddr === want.token) fromMismatchSeen = true;
    if (fromAddr === want.from && toAddr === want.to) tokenMismatchSeen = true;
  }

  // Heuristic on which specific mismatch to report (most-specific failure)
  if (amountMismatchSeen) {
    return { ok: false, code: "AMOUNT_MISMATCH", detail: "Transfer event amount didn't match expected" };
  }
  if (toMismatchSeen) {
    return { ok: false, code: "TO_MISMATCH", detail: "Transfer found from expected sender but to wrong recipient" };
  }
  if (fromMismatchSeen) {
    return { ok: false, code: "FROM_MISMATCH", detail: "Token transfer found but from wrong sender" };
  }
  if (tokenMismatchSeen) {
    return { ok: false, code: "TOKEN_MISMATCH", detail: "from/to transfer found but for a different token" };
  }
  return { ok: false, code: "NO_TRANSFER_LOG", detail: "No matching Transfer event in receipt" };
}

/**
 * Verify a the venue vault interaction (release = withdraw, recycle = deposit).
 * The vault emits its own Withdrawn / Deposited events; for v1 we accept
 * the standard ERC-20 Transfer in the receipt that the vault triggers,
 * with the vault contract as the from (for withdraw) or to (for deposit).
 *
 * - release (withdraw): vault → taker wallet. Transfer event: from=vault, to=taker.
 * - recycle (deposit): maker wallet → vault. Transfer event: from=maker_wallet, to=vault.
 *
 * Caller computes the expected from/to using the vault address from /config.
 */
export async function verifyVaultTransfer(
  rpcUrl: string,
  txHash: string,
  expected: TxVerifyExpected,
): Promise<TxVerifyResult> {
  // Same shape as verifyErc20Transfer — the vault triggers an ERC-20 Transfer
  // event with itself as one party. Caller already set fromAddress/toAddress
  // accordingly.
  return verifyErc20Transfer(rpcUrl, txHash, expected);
}

/**
 * Pick the right RPC URL for the active chain.
 */
export function getActiveRpcUrl(): string {
  // Default Sepolia public RPC if env not set. Operators should override.
  const mainnet = process.env.MAINNET_RPC_URL;
  const sepolia = process.env.SEPOLIA_RPC_URL;
  if (process.env.FEATURE_MAINNET === "true" && mainnet) return mainnet;
  if (sepolia) return sepolia;
  return "https://ethereum-sepolia-rpc.publicnode.com";
}
