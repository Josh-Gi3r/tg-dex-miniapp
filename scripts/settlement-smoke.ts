/**
 * ─── the venue End-to-End Smoke Test ──────────────────────────────────────────────
 *
 * Standalone Node script that drives a full market-maker trade flow on
 * the venue's live API using a raw private key. Runs from any machine with
 * unrestricted internet (your laptop) — no Privy, no TG app
 * sandbox in the way. Useful for:
 *
 *   - Verifying the integration works on Sepolia today
 *   - Smoke-testing mainnet before flipping the prod env var
 *   - Showing a market maker how to trade via the venue before they touch the UI
 *
 * What it does (each step is independently runnable):
 *
 *   bootstrap     — pulls /health, /config, /tokens, /markets
 *   provisionKey  — signs ManageApiKey, calls POST /api-keys, prints creds
 *   approve       — builds + signs + broadcasts an ERC-20 approve to Vault
 *   deposit       — builds + signs + broadcasts a deposit into the Vault
 *   placeOrder    — places a real limit order on Sepolia
 *   listOrders    — fetches your open orders + their settlement state
 *   cancelOrder   — cancels by order_id (respects 5-min cooldown)
 *   swap          — runs /swap/quote → sign Intent → POST /swap, prints trade_id
 *   balances      — prints your wallet + vault balances
 *
 * Quick start:
 *   1. Generate a fresh Sepolia wallet (or use an existing one):
 *        node -e "const w = require('ethers').Wallet.createRandom(); \
 *                 console.log('addr=', w.address, '\\nkey=', w.privateKey)"
 *   2. Fund it: get Sepolia ETH from a faucet, get test USDC from the venue (ask
 *      their team for a Sepolia test-USDC mint or use a known faucet token).
 *   3. Set env:
 *        export SEPOLIA_TEST_PRIVATE_KEY=0x...
 *        export DEX_API_BASE=https://api.example.com/api/v1
 *   4. Run a step:
 *        pnpm tsx scripts/settlement-smoke.ts bootstrap
 *        pnpm tsx scripts/settlement-smoke.ts provisionKey --label "smoke test"
 *        pnpm tsx scripts/settlement-smoke.ts balances
 *        pnpm tsx scripts/settlement-smoke.ts approve --token USDC --amount 100
 *        pnpm tsx scripts/settlement-smoke.ts deposit --token USDC --amount 100
 *        pnpm tsx scripts/settlement-smoke.ts placeOrder --base USDC --quote EURC \
 *                                       --side ask --amount 50 --price 0.92
 *        pnpm tsx scripts/settlement-smoke.ts listOrders
 *        pnpm tsx scripts/settlement-smoke.ts cancelOrder --orderId <UUID> --uuidInt <decimal>
 *        pnpm tsx scripts/settlement-smoke.ts swap --from USDC --to EURC --fromAmount 10
 *
 * After provisionKey, the api_key + api_secret print to stdout; copy them
 * into env so subsequent commands authenticate:
 *        export DEX_API_KEY=your_api_key_here
 *        export DEX_API_SECRET=...
 *
 * The script reuses the production EIP-712 type definitions from
 * shared/dex-api-config.ts and the uuid_int encoder from
 * client/src/lib/dex/uuidInt.ts — same code paths the TG app uses, just
 * driven from a CLI instead of a UI.
 */

import { ethers } from "ethers";
import {
  DEX_EIP712_TYPES,
  getDexApiBase,
} from "../shared/dex-api-config";
import {
  encodeStandalone,
  generateUuid4,
  uuidStringToBigInt,
} from "../client/src/lib/dex/uuidInt";

// ─── Configuration ──────────────────────────────────────────────────────────

const VENUE_BASE = getDexApiBase(process.env.DEX_API_BASE);
const PRIVATE_KEY = process.env.SEPOLIA_TEST_PRIVATE_KEY ?? "";
const API_KEY = process.env.DEX_API_KEY ?? "";
const API_SECRET = process.env.DEX_API_SECRET ?? "";

if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith("0x")) {
  console.error(
    "Set SEPOLIA_TEST_PRIVATE_KEY to a 0x-prefixed private key with Sepolia ETH + test USDC.",
  );
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY);

// ─── HTTP helpers ───────────────────────────────────────────────────────────

interface FetchOpts {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number>;
  auth?: boolean; // attach Bearer creds
}

async function call<T = unknown>(opts: FetchOpts): Promise<T> {
  const url = new URL(`${VENUE_BASE}${opts.path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth) {
    if (!API_KEY || !API_SECRET) {
      throw new Error(
        "This step needs DEX_API_KEY + DEX_API_SECRET — run 'provisionKey' first.",
      );
    }
    headers.Authorization = `Bearer ${API_KEY}:${API_SECRET}`;
  }
  const res = await fetch(url.toString(), {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${opts.method} ${opts.path} → ${res.status}: ${text}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

interface VenueConfig {
  chain_id: number;
  venue_address: string;
  vault_address: string;
  sor_address: string;
  eip712_domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
}

interface VenueToken {
  symbol: string;
  address: string;
  decimals: number;
  currency: string;
  min_trade_amount_raw: string;
}

interface VenueMarket {
  symbol: string;
  base_symbol: string;
  quote_symbol: string;
  base_address: string;
  quote_address: string;
  base_decimals: number;
  quote_decimals: number;
}

let cachedConfig: VenueConfig | null = null;
let cachedTokens: VenueToken[] | null = null;
let cachedMarkets: VenueMarket[] | null = null;
let cachedExecutorId: number | null = null;

async function getConfig(): Promise<VenueConfig> {
  if (cachedConfig) return cachedConfig;
  cachedConfig = await call<VenueConfig>({ method: "GET", path: "/config" });
  return cachedConfig;
}
async function getTokens(): Promise<VenueToken[]> {
  if (cachedTokens) return cachedTokens;
  const r = await call<{ tokens: VenueToken[] }>({ method: "GET", path: "/tokens" });
  cachedTokens = r.tokens;
  return cachedTokens;
}
async function getMarkets(): Promise<VenueMarket[]> {
  if (cachedMarkets) return cachedMarkets;
  const r = await call<{ markets: VenueMarket[] }>({ method: "GET", path: "/markets" });
  cachedMarkets = r.markets;
  return cachedMarkets;
}
async function getExecutorId(): Promise<number> {
  if (cachedExecutorId !== null) return cachedExecutorId;
  const h = await call<{ executor_id: number }>({ method: "GET", path: "/health" });
  cachedExecutorId = h.executor_id;
  return cachedExecutorId;
}
async function getServerTime(): Promise<number> {
  const r = await call<{ timestamp: number }>({ method: "GET", path: "/system/time" });
  return r.timestamp;
}
async function findToken(symbol: string): Promise<VenueToken> {
  const tokens = await getTokens();
  const t = tokens.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!t) throw new Error(`Token ${symbol} not in /tokens registry`);
  return t;
}
async function findMarket(base: string, quote: string): Promise<VenueMarket> {
  const markets = await getMarkets();
  const m = markets.find(
    (x) =>
      x.base_symbol.toUpperCase() === base.toUpperCase() &&
      x.quote_symbol.toUpperCase() === quote.toUpperCase(),
  );
  if (!m) throw new Error(`Market ${base}/${quote} not found`);
  return m;
}

// ─── CLI arg parsing ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdBootstrap() {
  console.log("=== Bootstrap ===");
  const health = await call<{
    status: string;
    executor_id: number;
    signature_ready: boolean;
  }>({ method: "GET", path: "/health" });
  const config = await getConfig();
  const tokens = await getTokens();
  const markets = await getMarkets();
  const time = await getServerTime();

  console.log({
    health,
    config: {
      chain_id: config.chain_id,
      venue: config.venue_address,
      vault: config.vault_address,
      sor: config.sor_address,
    },
    serverTime: new Date(time * 1000).toISOString(),
    tokenCount: tokens.length,
    marketCount: markets.length,
    wallet: wallet.address,
  });
}

async function cmdBalances() {
  console.log("=== Balances ===");
  const r = await call<{ balances: unknown[] }>({
    method: "GET",
    path: "/balances",
    query: { owner_address: wallet.address },
    auth: true,
  });
  console.log(r);
}

async function cmdProvisionKey(args: Record<string, string>) {
  console.log("=== Provision API Key ===");
  const config = await getConfig();
  const timestamp = await getServerTime();
  const signature = await wallet.signTypedData(
    config.eip712_domain,
    { ManageApiKey: DEX_EIP712_TYPES.ManageApiKey as unknown as Array<{ name: string; type: string }> },
    { owner: wallet.address, action: "create", timestamp },
  );
  const result = await call<{ api_key: string; api_secret: string }>({
    method: "POST",
    path: "/api-keys",
    body: {
      owner_address: wallet.address,
      action: "create",
      timestamp,
      signature,
      label: args.label ?? "settlement-smoke",
    },
  });
  console.log("\n----- COPY THESE INTO ENV -----");
  console.log(`export DEX_API_KEY=${result.api_key}`);
  console.log(`export DEX_API_SECRET=${result.api_secret}`);
  console.log("--------------------------------\n");
  console.log("(api_secret is shown only once. Store it.)");
}

async function cmdApprove(args: Record<string, string>) {
  console.log("=== Approve (build → sign → broadcast) ===");
  const symbol = args.token ?? "USDC";
  const amount = args.amount ?? "1000";
  const token = await findToken(symbol);
  const config = await getConfig();
  const rawAmount = ethers.parseUnits(amount, token.decimals).toString();
  const built = await call<{
    tx: { to: string; data: string; value: string; chainId: string; nonce: string };
  }>({
    method: "POST",
    path: "/approve",
    body: {
      token: token.address,
      owner: wallet.address,
      spender: config.vault_address,
      amount: rawAmount,
    },
    auth: true,
  });
  const signed = await wallet.signTransaction({
    to: built.tx.to,
    data: built.tx.data,
    value: built.tx.value,
    chainId: parseInt(built.tx.chainId, 16),
    nonce: parseInt(built.tx.nonce, 16),
    gasLimit: parseInt((built.tx as { gas: string }).gas, 16),
    maxFeePerGas: BigInt((built.tx as { maxFeePerGas: string }).maxFeePerGas),
    maxPriorityFeePerGas: BigInt(
      (built.tx as { maxPriorityFeePerGas: string }).maxPriorityFeePerGas,
    ),
    type: 2,
  });
  const r = await call<{ tx_hash: string }>({
    method: "POST",
    path: "/tx/send",
    body: { raw_tx: signed },
    auth: true,
  });
  console.log(`Approve tx: ${r.tx_hash}`);
  console.log(`Etherscan: https://sepolia.etherscan.io/tx/${r.tx_hash}`);
}

async function cmdDeposit(args: Record<string, string>) {
  console.log("=== Deposit (build → sign → broadcast) ===");
  const symbol = args.token ?? "USDC";
  const amount = args.amount ?? "100";
  const token = await findToken(symbol);
  const rawAmount = ethers.parseUnits(amount, token.decimals).toString();
  const built = await call<{ tx: Record<string, string> }>({
    method: "POST",
    path: "/deposit",
    body: {
      token: token.address,
      owner: wallet.address,
      amount: rawAmount,
    },
    auth: true,
  });
  const signed = await wallet.signTransaction({
    to: built.tx.to!,
    data: built.tx.data!,
    value: built.tx.value ?? "0x0",
    chainId: parseInt(built.tx.chainId!, 16),
    nonce: parseInt(built.tx.nonce!, 16),
    gasLimit: parseInt(built.tx.gas!, 16),
    maxFeePerGas: BigInt(built.tx.maxFeePerGas!),
    maxPriorityFeePerGas: BigInt(built.tx.maxPriorityFeePerGas!),
    type: 2,
  });
  const r = await call<{ tx_hash: string }>({
    method: "POST",
    path: "/tx/send",
    body: { raw_tx: signed },
    auth: true,
  });
  console.log(`Deposit tx: ${r.tx_hash}`);
  console.log(`Etherscan: https://sepolia.etherscan.io/tx/${r.tx_hash}`);
}

async function cmdPlaceOrder(args: Record<string, string>) {
  console.log("=== Place Limit Order ===");
  const baseSym = args.base ?? "USDC";
  const quoteSym = args.quote ?? "EURC";
  const side = (args.side ?? "ask") as "bid" | "ask";
  const amount = args.amount ?? "10";
  const price = args.price ?? "0.92";

  const market = await findMarket(baseSym, quoteSym);
  const config = await getConfig();
  const executorId = await getExecutorId();
  const serverTime = await getServerTime();
  const expiration = serverTime + 24 * 60 * 60; // 1 day

  const orderId = generateUuid4();
  const uuidInt = encodeStandalone(uuidStringToBigInt(orderId), executorId);

  // Compute the signed Order's fromToken/toToken/fromAmount/toAmount based
  // on side. ASK: spend base for quote. BID: spend quote for base.
  const fromToken = side === "ask" ? market.base_address : market.quote_address;
  const toToken = side === "ask" ? market.quote_address : market.base_address;
  const fromDecimals = side === "ask" ? market.base_decimals : market.quote_decimals;
  const toDecimals = side === "ask" ? market.quote_decimals : market.base_decimals;
  const fromAmountHuman = side === "ask" ? amount : (parseFloat(amount) * parseFloat(price)).toString();
  const toAmountHuman = side === "ask" ? (parseFloat(amount) * parseFloat(price)).toString() : amount;
  const fromAmount = ethers.parseUnits(fromAmountHuman, fromDecimals).toString();
  const toAmount = ethers.parseUnits(toAmountHuman, toDecimals).toString();

  const orderMessage = {
    user: wallet.address,
    expiration,
    feeBps: 0,
    recipient: wallet.address,
    fromToken,
    toToken,
    fromAmount,
    toAmount,
    initialDepositAmount: "0",
    uuid: uuidInt.toString(),
  };
  const signature = await wallet.signTypedData(
    config.eip712_domain,
    { Order: DEX_EIP712_TYPES.Order as unknown as Array<{ name: string; type: string }> },
    orderMessage,
  );

  const r = await call<{ order_id: string }>({
    method: "POST",
    path: "/orders",
    body: {
      owner_address: wallet.address,
      side,
      amount,
      price,
      order_type: "limit",
      from_address: market.base_address,
      to_address: market.quote_address,
      order_id: orderId,
      uuid_int: uuidInt.toString(),
      signature,
      expiration,
    },
  });
  console.log(`Order placed:`);
  console.log(`  order_id: ${r.order_id}`);
  console.log(`  uuid_int: ${uuidInt.toString()}`);
  console.log(`(save these for cancelOrder)`);
}

async function cmdListOrders() {
  console.log("=== List My Orders ===");
  const r = await call<{ trades: unknown[]; total: number }>({
    method: "GET",
    path: "/orders",
    query: { owner_address: wallet.address, limit: 20 },
    auth: true,
  });
  console.log(JSON.stringify(r, null, 2));
}

async function cmdCancelOrder(args: Record<string, string>) {
  console.log("=== Cancel Order ===");
  const orderId = args.orderId;
  const uuidIntStr = args.uuidInt;
  if (!orderId || !uuidIntStr) {
    throw new Error("--orderId and --uuidInt required");
  }
  const config = await getConfig();
  const signature = await wallet.signTypedData(
    config.eip712_domain,
    { CancelOrder: DEX_EIP712_TYPES.CancelOrder as unknown as Array<{ name: string; type: string }> },
    { owner: wallet.address, orderId: uuidIntStr },
  );
  const r = await call<{ status: string }>({
    method: "POST",
    path: "/orders/cancel",
    body: {
      owner_address: wallet.address,
      order_id: orderId,
      uuid_int: uuidIntStr,
      signature,
    },
  });
  console.log(r);
}

async function cmdSwap(args: Record<string, string>) {
  console.log("=== Take a Swap ===");
  const fromSym = args.from ?? "USDC";
  const toSym = args.to ?? "EURC";
  const amount = args.fromAmount ?? "1";
  const fromTok = await findToken(fromSym);
  const toTok = await findToken(toSym);
  const fromAmountRaw = ethers.parseUnits(amount, fromTok.decimals).toString();
  const config = await getConfig();
  const serverTime = await getServerTime();

  // 1. Quote
  const quote = await call<{
    uuid: string;
    route_params: Record<string, string | number>;
    permit?: {
      permit_supported: boolean;
      permit_required: boolean;
      eip712: {
        domain: { name: string; version: string; chainId: number; verifyingContract: string };
        primaryType: string;
        types: Record<string, Array<{ name: string; type: string }>>;
        message: Record<string, unknown>;
      };
    } | null;
  }>({
    method: "POST",
    path: "/swap/quote",
    body: {
      from_token: fromTok.address,
      to_token: toTok.address,
      from_amount: fromAmountRaw,
      owner_address: wallet.address,
      recipient: wallet.address,
      expiration: serverTime + 600,
      gas_mode: "receive_less",
    },
  });
  console.log(`Quote uuid: ${quote.uuid}`);
  console.log(
    `Min output: ${quote.route_params.minOutputAmount} (raw)`,
  );

  // 2. Sign Intent (route_params verbatim)
  const intentSignature = await wallet.signTypedData(
    config.eip712_domain,
    { Intent: DEX_EIP712_TYPES.Intent as unknown as Array<{ name: string; type: string }> },
    quote.route_params as Record<string, unknown>,
  );

  // 3. Sign Permit if quote ships one
  let permitSignature: string | undefined;
  let permitDeadline: number | undefined;
  if (quote.permit) {
    if (!quote.permit.permit_supported) {
      throw new Error(
        `${fromSym} doesn't support EIP-2612 permit — run approve first`,
      );
    }
    permitDeadline = Number(
      (quote.permit.eip712.message as { deadline: number | string }).deadline,
    );
    permitSignature = await wallet.signTypedData(
      quote.permit.eip712.domain,
      quote.permit.eip712.types,
      quote.permit.eip712.message,
    );
  }

  // 4. Execute
  const exec = await call<{ trade_id: string; status: string }>({
    method: "POST",
    path: "/swap",
    body: {
      uuid: quote.uuid,
      signature: intentSignature,
      permit_signature: permitSignature,
      permit_deadline: permitDeadline,
    },
  });
  console.log(`Swap submitted: trade_id=${exec.trade_id}, status=${exec.status}`);

  // 5. Poll for tx hash
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const status = await call<{
        status: string;
        settlement_summary?: { latest_tx_hash: string | null };
      }>({
        method: "GET",
        path: `/orders/${encodeURIComponent(exec.trade_id)}`,
        auth: true,
      });
      const txHash = status.settlement_summary?.latest_tx_hash;
      console.log(
        `  poll ${i + 1}: status=${status.status}, tx=${txHash ?? "(pending)"}`,
      );
      if (txHash) {
        console.log(
          `Settled on Sepolia: https://sepolia.etherscan.io/tx/${txHash}`,
        );
        break;
      }
      if (status.status === "failed" || status.status === "cancelled") break;
    } catch (err) {
      console.warn(`  poll ${i + 1}: ${(err as Error).message}`);
    }
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  console.log(`the venue base: ${VENUE_BASE}`);
  console.log(`Wallet: ${wallet.address}\n`);

  switch (cmd) {
    case "bootstrap":
      await cmdBootstrap();
      break;
    case "provisionKey":
      await cmdProvisionKey(args);
      break;
    case "balances":
      await cmdBalances();
      break;
    case "approve":
      await cmdApprove(args);
      break;
    case "deposit":
      await cmdDeposit(args);
      break;
    case "placeOrder":
      await cmdPlaceOrder(args);
      break;
    case "listOrders":
      await cmdListOrders();
      break;
    case "cancelOrder":
      await cmdCancelOrder(args);
      break;
    case "swap":
      await cmdSwap(args);
      break;
    default:
      console.error(
        "Usage: pnpm tsx scripts/settlement-smoke.ts <bootstrap|provisionKey|balances|approve|deposit|placeOrder|listOrders|cancelOrder|swap> [--key value]",
      );
      console.error(
        "See the file header for examples and required env vars.",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
