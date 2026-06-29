import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { timingSafeEqual } from "node:crypto";

/**
 * Auth for the /internal/* cron+ops endpoints. Prefers a dedicated
 * INTERNAL_CRON_SECRET; falls back to JWT_SECRET so existing deploys keep
 * working (audit medium #15 — JWT_SECRET signs all user sessions, so a separate
 * secret is safer; set INTERNAL_CRON_SECRET on Railway to split them). Compare
 * is constant-time to avoid leaking the secret via response timing.
 */
function internalAuthOk(req: { header(n: string): string | undefined }): boolean {
  const expected = process.env.INTERNAL_CRON_SECRET || process.env.JWT_SECRET;
  const got = req.header("x-internal-secret");
  if (!expected || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { handleWebhookUpdate, verifyWebhookSecret } from "../lib/telegram";
import { runSignalCycle } from "../lib/signals/worker";
import { runYieldCycle } from "../lib/yield/worker";
import { runFillCycle } from "../lib/dex/fillPoller";
import { runShopSettlementCycleTracked } from "../lib/dex/shopSettlementWorkers";
import { runOpenBookCycle } from "../lib/dex/openBookBot";
import { runSeed } from "../lib/seed";
import { ENV } from "./env";
import { runBootMigrations } from "./bootMigrations";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Apply any pending schema changes before the server starts taking
  // traffic. Idempotent — running twice has no extra effect.
  await runBootMigrations();

  // Auto-seed testnet data. Skipped on mainnet. Re-runs whenever the live DB
  // count of seed-id-range users doesn't match SEED_CHANGERS.length — expanding
  // the seed definition triggers a refresh on the next deploy automatically.
  // runSeed() is idempotent (deletes prior seed users in range + their ads,
  // re-inserts). The earlier "if zero → run, else skip" version trapped stale
  // data across deploys; this trigger tracks the canonical source.
  if (!ENV.featureMainnet) {
    try {
      const { getDb } = await import("../db");
      const { users, p2pAds } = await import("../../drizzle/schema");
      const { and, gte, lte, inArray, sql } = await import("drizzle-orm");
      const { SEED_CHANGERS } = await import("../lib/seed");
      // Cold-start DB race: getDb() can return null before the pool is ready on
      // a fresh container, which silently skipped the auto-seed (had to trigger
      // /internal/seed/run by hand). Retry a few times so deploys self-seed.
      let db = await getDb();
      for (let attempt = 0; !db && attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        db = await getDb();
      }
      if (!db) {
        console.warn("[seed] DB not ready after retries — skipping auto-seed (use /internal/seed/run)");
      }
      if (db) {
        const existing = await db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              gte(users.telegramId, "90000000"),
              lte(users.telegramId, "99999999"),
            ),
          );
        const expected = SEED_CHANGERS.length;

        // Re-seed when the seed definition GREW (count mismatch) OR when the live
        // seed ads are STALE/over-advertised. The original gate only checked count,
        // so the cosmetic-liquidity fix (cap ads to the ~150K vault backing) never
        // applied to already-seeded shops (22==22 → skipped) — leaving 500K ads
        // live against a 200K vault. runSeed() now caps liquidity; detect the stale
        // rows (any seed-shop ad still advertising > 150K) and refresh on deploy,
        // so the honest liquidity lands WITHOUT a manual /internal/seed/run.
        let stale = false;
        const seedUserIds = existing.map((u) => u.id);
        if (existing.length === expected && seedUserIds.length > 0) {
          // NOTE: this DB is MySQL (drizzle-orm/mysql2) — Postgres `DOUBLE
          // PRECISION` is NOT a valid CAST target here and silently threw,
          // swallowed by the outer catch, so the re-seed never fired. `liquidity`
          // is a decimal(18,6) column → compare it numerically with no cast.
          const over = await db
            .select({ n: sql<number>`count(*)` })
            .from(p2pAds)
            .where(
              and(
                inArray(p2pAds.posterId, seedUserIds),
                sql`${p2pAds.liquidity} > 150000`,
              ),
            );
          stale = Number(over[0]?.n ?? 0) > 0;
        }

        if (existing.length !== expected || stale) {
          console.log(
            `[seed] ${existing.length !== expected ? `Count mismatch (have ${existing.length}, want ${expected})` : `Stale over-advertised ads detected`} — running auto-seed for testnet...`,
          );
          const result = await runSeed();
          console.log(
            `[seed] Created ${result.changersCreated} changers, ${result.adsCreated} ads, ${result.errors.length} errors`,
          );
          if (result.errors.length > 0) {
            console.warn("[seed] errors:", result.errors);
          }
        } else {
          console.log(`[seed] Skipping auto-seed — ${existing.length} seed users match, ad liquidity within vault backing`);
        }
      }
    } catch (err) {
      // Auto-seed failure is non-fatal — the manual /internal/seed/run endpoint
      // is still available for recovery.
      console.error("[seed] auto-seed failed (non-fatal):", err);
    }
  }

  const app = express();
  const server = createServer(app);
  // Body size cap. This is a JSON tRPC API (no large server-side file uploads),
  // so a 1mb cap is generous for any payload while removing the 50mb DoS surface
  // on the auth/money routes (audit medium #16).
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // Telegram bot webhook — gated by Telegram's secret_token header.
  // Spoofable without this check; set TELEGRAM_WEBHOOK_SECRET env to enforce.
  app.post("/api/telegram/webhook", async (req, res) => {
    const header = req.header("x-telegram-bot-api-secret-token");
    if (!verifyWebhookSecret(header)) {
      console.warn("[Webhook] Rejected — invalid or missing secret token");
      res.sendStatus(401);
      return;
    }
    try {
      await handleWebhookUpdate(req.body);
    } catch (err) {
      console.error("[Webhook] Error handling Telegram update:", err);
    }
    // Always return 200 to Telegram to prevent retries
    res.sendStatus(200);
  });

  // Liveness — wired to Railway's health check.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Internal cron endpoint for the signal engine. Auth is the JWT secret
  // re-used as a shared internal token — keeps the deploy down to one
  // secret to manage. Returns the cycle metrics so the cron's logs are
  // useful when something stops producing signals.
  app.post("/internal/signals/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const result = await runSignalCycle();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[signals] cycle failed:", err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Internal cron endpoint for the yield bot. Same auth scheme as the
  // signal cron. Tick every minute alongside it.
  // Cross-channel fill poller — reconciles each live the venue order against
  // what's in our DB so shop stats stay honest when fills happen via
  // the web app or any other venue-integrated client. Tick every minute
  // alongside the signal + yield jobs.
  app.post("/internal/fills/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const result = await runFillCycle();
      if (result.errors.length > 0) {
        console.warn("[fills] cycle completed with errors:", result.errors);
      }
      res.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      console.error("[fills] cycle failed:", err);
      res.json({ ok: false, error: (err as Error).message ?? String(err) });
    }
  });

  app.post("/internal/yield/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const result = await runYieldCycle();
      // Always 200 so cron-job.org doesn't disable the schedule on a
      // recoverable per-cycle error. result.errors carries diagnostics.
      if (result.errors.length > 0) {
        console.warn("[yield] cycle completed with errors:", result.errors);
      }
      res.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      // Reached only if runYieldCycle's own try/catch fails to capture —
      // log loudly but still return 200 so cron keeps polling.
      console.error("[yield] cycle failed:", err);
      res.json({ ok: false, error: (err as Error).message ?? String(err) });
    }
  });

  // Test-data seed endpoint. TESTNET ONLY. Idempotent — re-running deletes
  // prior seed users (telegramId in 90000000–99999999 range) + their ads,
  // then re-inserts. Gated by JWT_SECRET (same auth pattern as the crons).
  app.post("/internal/seed/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    if (ENV.featureMainnet) {
      res.status(403).json({
        ok: false,
        error: "Seed endpoint is disabled when FEATURE_MAINNET=true",
      });
      return;
    }
    try {
      const result = await runSeed();
      res.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      console.error("[seed] failed:", err);
      res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
    }
  });

  // Shop settlement workers — TTL expiry + refund + recycle retry. Same auth +
  // cadence as the other cron endpoints. Runs every minute. (from v2-settlement)
  app.post("/internal/shop-settlement/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const result = await runShopSettlementCycleTracked();
      const anyErrors =
        result.ttl.errors > 0 ||
        result.refund.errors > 0 ||
        result.recycleRetry.errors > 0;
      if (anyErrors) {
        console.warn("[shop-settlement] cycle completed with errors:", result);
      }
      res.json({ ok: !anyErrors, ...result });
    } catch (err) {
      console.error("[shop-settlement] cycle failed:", err);
      res.json({ ok: false, error: (err as Error).message ?? String(err) });
    }
  });

  // Open Book Bot — posts real CLOB orders from seed shops so the book +
  // Swap board + Assistant have live liquidity. Same auth + cadence pattern.
  app.post("/internal/openbook/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const result = await runOpenBookCycle();
      res.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      console.error("[openbook] cycle failed:", err);
      res.json({ ok: false, error: (err as Error).message ?? String(err) });
    }
  });

  // Rate logger — snapshots the venue rate + FX oracle mid per direction so we have
  // "the rate at that hour" (the live API can't answer historical). Same cron auth.
  app.post("/internal/rate-log/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const { runRateLogCycle } = await import("../lib/dex/rateLog");
      const r = await runRateLogCycle();
      res.json({ ok: true, logged: r.logged });
    } catch (err) {
      console.error("[rate-log] cycle failed:", err);
      res.json({ ok: false, error: (err as Error).message ?? String(err) });
    }
  });

  // Live book scan — reconstructs the CLOB (individual orders, rate+size) via
  // vault read + per-direction quote fine-walk. Heavy (hundreds of quotes), so
  // it runs here off the request path and caches; tRPC serves the snapshot.
  app.post("/internal/book-scan/run", async (req, res) => {
    if (!internalAuthOk(req)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      const { scanLiveBook } = await import("../lib/dex/bookScanner");
      const snap = await scanLiveBook();
      res.json({ ok: true, directions: snap?.directions.length ?? 0, candidates: snap?.candidates ?? 0, funded: snap?.fundedTokens.length ?? 0 });
    } catch (err) {
      console.error("[book-scan] cycle failed:", err);
      res.json({ ok: false, error: (err as Error).message ?? String(err) });
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    startBackgroundSchedulers();
  });
}

/**
 * In-process background scheduler — keeps the CLOB book fresh, the reconstructed
 * book + rate history cached, and the settlement/fill workers ticking. Replaces
 * the 3rd-party cron-job.org dependency entirely (so JWT_SECRET never leaves the
 * server). Each loop has a re-entrancy guard and its own try/catch; first runs
 * are staggered so a cold boot isn't hammered. Testnet only.
 */
let SCHEDULERS_STARTED = false;
function startBackgroundSchedulers(): void {
  if (SCHEDULERS_STARTED) return;
  SCHEDULERS_STARTED = true;
  if (ENV.featureMainnet) {
    console.log("[scheduler] mainnet — background loops disabled");
    return;
  }
  const inflight = new Set<string>();
  const every = (label: string, ms: number, firstDelayMs: number, fn: () => Promise<unknown>) => {
    const run = async () => {
      if (inflight.has(label)) return; // don't overlap a still-running tick
      inflight.add(label);
      try { await fn(); } catch (e) { console.error(`[scheduler:${label}]`, e instanceof Error ? e.message : e); }
      finally { inflight.delete(label); }
    };
    setTimeout(() => { void run(); setInterval(() => void run(), ms); }, firstDelayMs);
  };

  every("openbook", 90_000, 15_000, async () => {
    const r = await runOpenBookCycle();
    console.log(`[scheduler:openbook] posted=${r.posted} refilled=${r.refilled} live=${r.stillLive} err=${r.errors.length}`);
  });
  every("book-scan", 180_000, 45_000, async () => {
    const { scanLiveBook } = await import("../lib/dex/bookScanner");
    const s = await scanLiveBook();
    console.log(`[scheduler:book-scan] directions=${s?.directions.length ?? 0} candidates=${s?.candidates ?? 0}`);
  });
  every("rate-log", 300_000, 90_000, async () => {
    const { runRateLogCycle } = await import("../lib/dex/rateLog");
    const r = await runRateLogCycle();
    console.log(`[scheduler:rate-log] logged=${r.logged}`);
  });
  every("fills", 30_000, 20_000, async () => { await runFillCycle(); });
  every("settlement", 60_000, 30_000, async () => { await runShopSettlementCycleTracked(); });
  every("yield", 600_000, 120_000, async () => { await runYieldCycle(); });
  console.log("[scheduler] background loops started (testnet)");
}

startServer().catch(console.error);
