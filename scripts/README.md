# the venue Smoke Test Script

Standalone CLI that drives the full market-maker / swap flow against the venue's
live API using a raw private key. **No Privy, no TG app, no auth ceremony.**
Runs from any machine with internet.

This is the fastest path to verifying that the integration actually works on
Sepolia (and later mainnet). If the script can sign + post + cancel an order,
the production app can too — same code paths.

## Prerequisites

1. **A Sepolia wallet with funds**

   Generate a fresh one:

   ```bash
   node -e "const w = require('ethers').Wallet.createRandom(); \
            console.log('addr=', w.address, '\\nkey=', w.privateKey)"
   ```

   Fund it:
   - **Sepolia ETH** for gas — any Sepolia faucet (e.g. https://sepoliafaucet.com)
   - **Test USDC / EURC / etc.** — ask the venue for the test-token mint on Sepolia,
     or check `GET /tokens` for the live registry and mint accordingly.

2. **Env vars**

   ```bash
   export SEPOLIA_TEST_PRIVATE_KEY=0x<your-funded-wallet-key>
   export DEX_API_BASE=https://api.example.com/api/v1   # or a staging URL
   ```

## Walkthrough — one trade end to end

```bash
# 1. Verify connectivity + see live config / tokens / markets
pnpm smoke bootstrap

# 2. Provision a the venue API key (signs ManageApiKey with your wallet)
pnpm smoke provisionKey --label "smoke test"
#    → prints DEX_API_KEY + DEX_API_SECRET. Copy them into env:
export DEX_API_KEY=your_api_key_here
export DEX_API_SECRET=...

# 3. Check your balances (wallet + vault)
pnpm smoke balances

# 4. Approve USDC for the Vault (skip if you'll use a permit-supporting token)
pnpm smoke approve --token USDC --amount 100

# 5. Deposit USDC into the Vault
pnpm smoke deposit --token USDC --amount 100

# 6. Place a limit order on the USDC/EURC market (selling USDC)
pnpm smoke placeOrder --base USDC --quote EURC --side ask --amount 50 --price 0.92
#    → prints order_id (UUID) and uuid_int (decimal). Save them.

# 7. List your orders + check fill state
pnpm smoke listOrders

# 8. Cancel the order (subject to the documented 5-min cancel cooldown)
pnpm smoke cancelOrder --orderId <UUID> --uuidInt <decimal>

# Alternative path: take a swap (instead of placing a limit order)
pnpm smoke swap --from USDC --to EURC --fromAmount 10
#    → quotes, signs the Intent, submits, polls for the on-chain tx hash
```

## Why this matters

The script reuses the **exact same code paths** as the production TG app:
- EIP-712 type definitions: `shared/dex-api-config.ts`
- uuid_int composite encoder: `client/src/lib/dex/uuidInt.ts`
- Spec-conformant request bodies for every endpoint

If it works here, the orchestrators in the TG app work too. If it 4xxs,
the bug is in our integration code — same fix, both places.

## Mainnet

Same script, just point at mainnet's `api.example.com/api/v1` (the base URL is
deployment-aware via `GET /config`). Use a mainnet-funded wallet. Be careful
with sizes — these are real trades.

## Common errors

- `403 Host not in allowlist` — you're running this from a sandboxed
  environment (e.g. CI environment). Run from a real machine with unrestricted
  outbound. Anyone's laptop works.
- `422 ALLOWANCE_INSUFFICIENT` — run `approve` before `deposit` (or before
  `swap` if the source token doesn't support EIP-2612 permit).
- `429 cooldown` on cancel — the venue enforces a 5-minute minimum between place
  and cancel. Wait it out.
- `410 quote stale` — `/swap/quote` snapshots are short-lived (~30s). Re-quote.
