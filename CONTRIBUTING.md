# Contributing

Thanks for your interest in improving tg-dex-miniapp. This is a template — fork it,
adapt it, and send fixes back if you find something broken.

## Getting started

```bash
git clone <your-fork-url>
cd tg-dex-miniapp
pnpm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, TELEGRAM_BOT_TOKEN
pnpm dev
```

See `README.md` for the full quickstart and `DEPLOY.md` for deployment.

## Ground rules

- **Branch off `main`** and open a PR. Keep PRs focused on one change.
- **Match the existing style.** Prettier config lives in `.prettierrc`; run `pnpm format` before committing.
- **Type-check and test** before pushing:
  ```bash
  pnpm check     # tsc
  pnpm test      # vitest
  ```
- **Keep it brand-free.** This is a public template — no personal names, API keys,
  private endpoints, or company-specific config. Use the adapter seams (see the
  README adapter table) instead of hardcoding a provider.
- **Never commit secrets.** `.env` is gitignored; keep it that way.
- **New env vars** go in `.env.example` with a one-line comment.

## Reporting issues

Open an issue with repro steps, the env (`FEATURE_MODE`, Node/pnpm version), and
any relevant logs. For security-sensitive reports, contact the maintainer privately
rather than filing a public issue.
