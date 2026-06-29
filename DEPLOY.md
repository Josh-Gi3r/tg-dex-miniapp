# Deploy — the settlement venue FX Telegram Mini-App

This is the practical deploy guide. Target: Railway (works the same on
Render/Fly with minor tweaks). The app is one Node process that serves
both the tRPC API and the built client bundle.

## TL;DR

1. Provision a MySQL/MariaDB.
2. Push this branch to GitHub, point Railway at it, set the env vars below.
3. Build command: `pnpm install --frozen-lockfile && pnpm build`.
4. Start command: `pnpm start`.
5. Run migrations once: `pnpm db:push` from a one-off shell.
6. (No external cron needed — the background scheduler runs in-process; see `startBackgroundSchedulers`. The `/internal/*` endpoints exist for manual/ops triggers, auth `INTERNAL_CRON_SECRET` → falls back to `JWT_SECRET`.)
7. Point `@<your_bot>` at `https://<railway-domain>` in BotFather.

That's the whole thing. The rest of this file is the boring details.

## Prereqs

- Node 22+ (Railway picks this up from `package.json` engines / volta if
  added; otherwise default Nixpacks works).
- pnpm 10+ (Railway autodetects from `packageManager` in `package.json`).
- A MySQL 8 / MariaDB 10.6+ instance reachable from the app.
- A Telegram bot token from `@BotFather`.

Phase-gated features (Privy auth, mainnet, promotions) are off by default,
so you can ship without them. This does **not** stub the app: it runs against
the **live the settlement venue testnet** (`api.testnet.example.com`) with real on-chain signing.
"Demo" here means Privy off + Telegram-cookie auth on — **not** fake data.

## Required env vars

These are non-negotiable; the server refuses to boot otherwise.

| Var | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `mysql://user:pass@host:3306/dex_miniapp` | MySQL/MariaDB connection string. |
| `JWT_SECRET` | 32+ random bytes (`openssl rand -hex 32`) | Signs the legacy `app_session_id` cookie. |
| `TELEGRAM_BOT_TOKEN` | `123:ABC…` | From BotFather. Used both for initData verification and outbound DMs. |
| `TELEGRAM_BOT_USERNAME` | `your_bot` | Without the `@`. Used in deeplink generation. |
| `OWNER_OPEN_ID` | `tg_user_id_of_admin` | Bypasses some checks; receives ops alerts. |
| `OWNER_NAME` | `Admin` | Display only. |
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | Railway sets this automatically; respect it. |

## Optional / phase-gated env vars

| Var | Default | What it unlocks |
|---|---|---|
| `FEATURE_MODE` | `demo` | Largely inert — does **not** switch data to stubs. Leave as `demo`. The load-bearing gate is `FEATURE_MAINNET`. |
| `FEATURE_MAINNET` | `false` | The real testnet↔mainnet switch. Flip to `true` only after the Sepolia rehearsal passes; wires `MAINNET_RPC_URL` and disables auto-seed + background bots. |
| `SEPOLIA_RPC_URL` | — | Required for on-chain reads/verification on Sepolia (used by the signal engine + tx verifier). |
| `MAINNET_RPC_URL` | — | Required when `FEATURE_MAINNET=true`. |
| `DEX_API_BASE` | `https://api.testnet.example.com/api/v1` | Defaults to **testnet**. Override only for staging/mainnet the DEX. |
| `INTERNAL_CRON_SECRET` | falls back to `JWT_SECRET` | Auth for the `/internal/*` ops endpoints. Set a dedicated value if you ever expose them. |
| `APP_TREASURY_WALLET` | — | Recipient for Phase 7 promotion payments. |
| `PRIVY_APP_ID` (server) | — | Used by `server/_core/context.ts` to verify Privy JWTs. |
| `VITE_PRIVY_APP_ID` (client) | — | Mounts `<PrivyProvider>`. Without it, the app falls back to the legacy Telegram cookie path — useful for the demo. |
| `VITE_FEATURE_PRIVY_AUTH` | `false` | Hard kill-switch for the Privy login UI even when `VITE_PRIVY_APP_ID` is set. |
| `VITE_APP_ID` | `demo-app-id` | Client identifier; cosmetic in this app. |
| `VITE_OAUTH_PORTAL_URL` | — | Legacy OAuth-portal flow. Leave unset; the codebase is safe with it absent. |
| `BOT_WEBHOOK_URL` | — | Public URL of `/api/telegram/webhook`. If unset, the server falls back to long-polling, which works on Railway but eats a slot. |

### Feature flags cheat sheet

The only env flag that changes runtime data behavior is **`FEATURE_MAINNET`**.
The `shared/features.ts` registry and `FEATURE_MODE` are effectively inert
(not wired to the data path) — don't rely on them to stub anything.

- **Testnet (default)** — `FEATURE_MAINNET=false`. The app runs against the
  **live** the settlement venue testnet: real `/markets`, `/tokens`, `/fx`, real EIP-712
  signing and on-chain broadcast on Sepolia. No stubs, no `0xsim_` hashes.
  Privy is off; auth is the Telegram cookie. **This is what's shippable today.**
- **Mainnet** — flip `FEATURE_MAINNET=true` and set `MAINNET_RPC_URL`. Only
  after the Sepolia rehearsal passes. Disables auto-seed + background bots.
- **Privy auth (optional, orthogonal)** — set `VITE_PRIVY_APP_ID` +
  `VITE_FEATURE_PRIVY_AUTH=true` once the settlement venue issues the appId. Independent of
  the testnet/mainnet switch.

## Database

Migrations are managed by drizzle-kit. To apply on a fresh DB:

```bash
pnpm db:push
```

That command (a) generates SQL from `drizzle/schema.ts` and (b) runs the
migrations. On Railway: shell in via `railway shell`, run it once, then
disconnect. The script is idempotent — safe to re-run after deploys.

The seed data — the 5 tradeable testnet tokens (USDT, USDC, XSGD, JPYC,
EURT) funded across 22 changer shops — is applied automatically at boot,
or manually via `POST /internal/seed/run`. Schema lives in
`drizzle/schema.ts`; the signal and yield-bot tables are part of it, so no
separate migration step is needed.

## Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

Outputs:
- `dist/` — bundled server entry (`dist/index.js`).
- `dist/public/` — built client (Vite static output).

`pnpm start` runs `node dist/index.js`, which serves the API at
`/api/*` and the client from `dist/public/`. There's no separate
frontend deploy.

## Telegram wiring

1. Create the bot in `@BotFather`. Save the token.
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in Railway.
3. After first deploy, set the webhook:
   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<railway-domain>/api/telegram/webhook"
   ```
   Verify with `getWebhookInfo`.
4. In BotFather, set the Mini-App URL to `https://<railway-domain>` and
   enable the menu-button shortcut.

For the `@BotFather` "Test Mode" the same domain works — you don't need
a separate deploy.

## Background scheduler (no external cron)

The signal engine and other periodic jobs run **in-process** via
`startBackgroundSchedulers()` (`server/_core/index.ts`). You do **not** need
to wire an external cron — a single Railway service is enough. (Background
bots are disabled automatically when `FEATURE_MAINNET=true`.)

The `/internal/*` endpoints exist only as **manual ops triggers**:

- `POST /internal/signals/run` — force a signal refresh.
- `POST /internal/seed/run` — (re)apply seed shops/liquidity.

Auth: header `x-internal-secret`, compared against `INTERNAL_CRON_SECRET`
(falls back to `JWT_SECRET` if that var is unset). If you ever expose these
externally, set a dedicated `INTERNAL_CRON_SECRET` — **don't** put
`JWT_SECRET` into an outside scheduler (INV-9).

```
curl -fsS -X POST -H "x-internal-secret: $INTERNAL_CRON_SECRET" \
  https://$RAILWAY_PUBLIC_DOMAIN/internal/signals/run
```

After deploy, watch the app logs for one `[signals] cycle complete` per
tick. Auth errors or repeated 500s mean the secret or env is off.

## Health checks

- `GET /api/health` → `{ ok: true }` once the DB pool is up.
- `GET /api/dex/health` → proxies the the settlement venue `/health` and returns the
  `executor_id` the settlement venue provisioned. 200 here means the host allowlist is
  good. 403 means the settlement venue hasn't allowlisted this deployment's egress IP.

Wire the first one to Railway's health check.

## Smoke test against the live deploy

```bash
PORT=443 \
SESSION="$(node -e 'import(\"jose\").then(async ({SignJWT}) => { console.log(await new SignJWT({userId:\"1\",telegramId:\"smoke\"}).setProtectedHeader({alg:\"HS256\"}).setIssuedAt().setExpirationTime(\"1h\").sign(new TextEncoder().encode(process.env.JWT_SECRET))); })')" \
pnpm tsx scripts/ui-smoke.ts
```

The script (added in this batch) walks every tab in headless Chrome,
captures screenshots to `/tmp/ui-*.png`, and dumps a findings JSON.
Useful as a post-deploy sanity check.

## Rollback

This app has no destructive migrations as-is — every Drizzle change in
the current branch is additive. To roll back:

1. Redeploy the previous Railway image.
2. Optional: leave the new columns in place. They're nullable / unused
   on the old code.

If a future migration drops a column, snapshot the DB *before* the
deploy. Railway's "Backups" tab does this in one click.

## Things that will bite you

- **`api.example.com` 403 on the deployed host.** the settlement venue enforces an edge
  allowlist. The host (egress IP for Railway, or the configured
  `https://<your-domain>` for some checks) must be added by the the DEX
  team. From your laptop everything works; from Railway it 403s. Once
  the allowlist is set, no code change is needed.
- **`@<bot>` resolves but the Mini-App button is missing.** BotFather
  caches the menu-button URL. Re-set it via `/setmenubutton` and
  restart the Telegram client.
- **Cookies dropped in Telegram WebView.** Telegram's iOS WebView
  occasionally drops third-party cookies. The legacy auth path uses a
  same-site cookie on the app's own domain, so this is fine, but
  Privy's modal must be configured to use the same parent domain.
- **The signal engine is silent.** First check the app logs for the
  in-process scheduler (`[signals] cycle complete`). Second check
  `SEPOLIA_RPC_URL` — without it the engine has no real on-chain quotes and
  produces no signals. Third check `TELEGRAM_BOT_TOKEN` — DMs fail open, so
  the cycle still finishes, but no user gets pinged.
