/**
 * Auto-fund a tester's imported testnet wallet so they can trade immediately:
 *   1. W1 funder (TESTNET_FUNDER_PRIVATE_KEY) sends Sepolia ETH if the wallet is low
 *      — the tester needs gas to sign their own payment leg in the 3-leg burst.
 *   2. The tester's OWN key calls the the venue faucet `claimTo(self)` → mints all 117
 *      testnet tokens. The faucet tracks the CALLER, so it must be the tester's
 *      wallet (not W1) — mirrors the proven scripts/fund-seed-shops.mjs flow.
 *
 * Testnet only. Runs as a background job (NOT inline on the import request) and
 * writes progress to users.testnetFundStatus, which the client polls.
 * Status values: "funding" | "ready" | "skipped" | "error:<msg>".
 */
import {
  Wallet,
  Contract,
  JsonRpcProvider,
  parseEther,
  formatEther,
} from "ethers";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { users, walletKeys } from "../../../drizzle/schema";
import { decryptPrivateKey } from "../crypto";

const RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const FAUCET = "0x4FAc3BB8B77547E2Da7ed903baDBeD2f46cBe65a";
const FAUCET_ABI = ["function claimTo(address to) external"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
// USDT testnet — proxy for "has the tester already claimed?"
const USDT = "0x8365421d0e1b316fc6398d21be162992216bf2ad";

const GAS_SEND = "0.2";       // ETH to send if low (covers claimTo ~0.056 + trades)
const GAS_THRESHOLD = 0.15;   // top up if below
const KEEPER_WAIT_MS = 8000;  // faucet keeper mint latency
const TX_TIMEOUT_MS = 90_000; // per-tx confirmation ceiling

async function setStatus(userId: number, status: string): Promise<void> {
  const db = await getDb();
  if (db) await db.update(users).set({ testnetFundStatus: status }).where(eq(users.id, userId));
}

/**
 * Fund the wallet. Best-effort, idempotent (skips ETH/claim already present).
 * Never throws — records the failure in testnetFundStatus instead.
 */
export async function fundTestnetWallet(userId: number, address: string): Promise<void> {
  const funderPk = process.env.TESTNET_FUNDER_PRIVATE_KEY;
  if (!funderPk) {
    await setStatus(userId, "error:TESTNET_FUNDER_PRIVATE_KEY not set");
    return;
  }
  try {
    await setStatus(userId, "funding");
    const provider = new JsonRpcProvider(RPC);
    const funder = new Wallet(funderPk.startsWith("0x") ? funderPk : `0x${funderPk}`, provider);

    // 1. Gas — W1 tops up the tester wallet if low.
    const ethBal = await provider.getBalance(address);
    if (Number(formatEther(ethBal)) < GAS_THRESHOLD) {
      const tx = await funder.sendTransaction({ to: address, value: parseEther(GAS_SEND) });
      await provider.waitForTransaction(tx.hash, 1, TX_TIMEOUT_MS);
    }

    // 2. Faucet claim — the tester's OWN key calls claimTo(self). Skip if already
    //    holding tokens (one claim per address forever).
    const usdt = new Contract(USDT, ERC20_ABI, provider);
    const usdtBal: bigint = await usdt.balanceOf(address);
    if (usdtBal === 0n) {
      const db = await getDb();
      if (!db) { await setStatus(userId, "error:db unavailable"); return; }
      const row = await db.select().from(walletKeys).where(eq(walletKeys.userId, userId)).limit(1);
      const enc = row[0]?.encryptedKey;
      if (!enc) { await setStatus(userId, "error:no stored key"); return; }
      const testerPk = decryptPrivateKey(enc);
      const tester = new Wallet(testerPk, provider);
      const faucet = new Contract(FAUCET, FAUCET_ABI, tester);
      const tx = await faucet.claimTo(address);
      await provider.waitForTransaction(tx.hash, 1, TX_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, KEEPER_WAIT_MS)); // keeper mints
    }

    await setStatus(userId, "ready");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fund] testnet auto-fund failed for ${address}:`, msg);
    await setStatus(userId, `error:${msg.slice(0, 120)}`);
  }
}
