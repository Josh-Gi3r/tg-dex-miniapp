/**
 * ─── the venue REST API Client ────────────────────────────────────────────────────
 *
 * Thin wrapper over fetch with:
 *   - Bootstrap: lazy-loads /health (executor_id) and /config (contracts)
 *     on first authenticated call, caches for the process lifetime
 *   - Retries: exponential backoff on transient failures and 503s
 *   - Typed error envelopes: parses the venue's { detail, error_code } shape
 *   - Auth header support: Authorization: Bearer {api_key}:{api_secret}
 *
 * Spec: https://docs.example.com/api-reference/overview/
 *
 * NEVER import this from the client side.
 */
import { getDexApiBase } from "@shared/dex-api-config";
import type {
  VenueConfig,
  VenueErrorCode,
  VenueErrorEnvelope,
  VenueFxRate,
  VenueHealth,
  VenueMarketsResponse,
  VenueSystemTime,
  VenueTokensResponse,
} from "./types";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class DexApiError extends Error {
  readonly status: number;
  readonly errorCode: VenueErrorCode | string | undefined;
  readonly detail: string;

  constructor(status: number, detail: string, errorCode?: string) {
    super(`[DEX ${status}${errorCode ? ` ${errorCode}` : ""}] ${detail}`);
    this.name = "DexApiError";
    this.status = status;
    this.errorCode = errorCode;
    this.detail = detail;
  }
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

export interface VenueAuthCreds {
  apiKey: string;
  apiSecret: string;
}

function authHeader(auth?: VenueAuthCreds): Record<string, string> {
  if (!auth) return {};
  return { Authorization: `Bearer ${auth.apiKey}:${auth.apiSecret}` };
}

// ─── Retry helper ────────────────────────────────────────────────────────────

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface FetchOpts {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  auth?: VenueAuthCreds;
  query?: Record<string, string | number | undefined>;
  /** Max retry attempts on transient failures (default 3). */
  retries?: number;
}

// ─── Client ──────────────────────────────────────────────────────────────────

let cachedHealth: VenueHealth | null = null;
let cachedConfig: VenueConfig | null = null;
let bootstrapPromise: Promise<void> | null = null;

export class VenueClient {
  readonly base: string;

  constructor(baseUrl?: string) {
    this.base = getDexApiBase(baseUrl ?? process.env.DEX_API_BASE);
  }

  // ── Generic request method ────────────────────────────────────────────────

  /**
   * Public entry point used by router procedures that need the
   * retry/backoff/error-envelope parsing the private endpoint helpers
   * already get for free. Same shape as the internal request method.
   */
  async call<T>(path: string, opts: FetchOpts): Promise<T> {
    return this.request<T>(path, opts);
  }

  private async request<T>(path: string, opts: FetchOpts): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...authHeader(opts.auth),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const maxRetries = opts.retries ?? 3;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          method: opts.method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });

        if (res.status >= 200 && res.status < 300) {
          // Some 200s have empty body (rare); guard JSON parse
          const text = await res.text();
          return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
        }

        // Transient — retry with backoff
        if (TRANSIENT_STATUSES.has(res.status) && attempt < maxRetries) {
          const retryAfter = Number(res.headers.get("retry-after") ?? "1");
          await sleep(Math.min(retryAfter * 1000, 4000) * (attempt + 1));
          continue;
        }

        // 429 — respect Retry-After
        if (res.status === 429 && attempt < maxRetries) {
          const retryAfter = Number(res.headers.get("retry-after") ?? "2");
          await sleep(Math.max(retryAfter, 1) * 1000);
          continue;
        }

        // Parse the venue's typed error envelope.
        // Shape varies: {detail: "..."} OR {detail: {detail, error_code}}
        const text = await res.text();
        let detail = text;
        let errorCode: string | undefined;
        try {
          const parsed = JSON.parse(text) as { detail?: unknown };
          if (typeof parsed.detail === "string") {
            detail = parsed.detail;
          } else if (parsed.detail && typeof parsed.detail === "object") {
            const inner = parsed.detail as VenueErrorEnvelope;
            detail = inner.detail ?? text;
            errorCode = inner.error_code;
          }
        } catch {
          // not JSON; keep raw text as detail
        }
        throw new DexApiError(res.status, detail, errorCode);
      } catch (err) {
        if (err instanceof DexApiError) throw err;
        lastErr = err;
        if (attempt < maxRetries) {
          // Network/parse error — exponential backoff with jitter
          await sleep(500 * Math.pow(2, attempt) + Math.random() * 250);
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("Unknown DEX client failure");
  }

  // ── Bootstrap (lazy, cached) ──────────────────────────────────────────────

  /**
   * Loads /health and /config once and caches. Idempotent.
   * Multiple concurrent callers share the same in-flight promise.
   */
  async bootstrap(): Promise<{ health: VenueHealth; config: VenueConfig }> {
    if (cachedHealth && cachedConfig) {
      return { health: cachedHealth, config: cachedConfig };
    }
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        const [health, config] = await Promise.all([
          this.request<VenueHealth>("/health", { method: "GET" }),
          this.request<VenueConfig>("/config", { method: "GET" }),
        ]);
        cachedHealth = health;
        cachedConfig = config;
      })();
    }
    await bootstrapPromise;
    return { health: cachedHealth!, config: cachedConfig! };
  }

  /** Force a re-fetch of /health and /config (e.g. after a config rotation). */
  async refreshBootstrap(): Promise<void> {
    cachedHealth = null;
    cachedConfig = null;
    bootstrapPromise = null;
    await this.bootstrap();
  }

  /** Returns the cached executor_id, bootstrapping if needed. */
  async getExecutorId(): Promise<number> {
    const { health } = await this.bootstrap();
    return health.executor_id;
  }

  /** Returns the cached on-chain config, bootstrapping if needed. */
  async getConfig(): Promise<VenueConfig> {
    const { config } = await this.bootstrap();
    return config;
  }

  // ── Public read endpoints (no auth) ───────────────────────────────────────

  async getHealth(): Promise<VenueHealth> {
    return this.request<VenueHealth>("/health", { method: "GET" });
  }

  async getServerTime(): Promise<number> {
    const r = await this.request<VenueSystemTime>("/system/time", { method: "GET" });
    return r.timestamp;
  }

  async getTokens(): Promise<VenueTokensResponse> {
    return cachedReadthrough(
      "tokens",
      TOKEN_CACHE_TTL_MS,
      async () => this.request<VenueTokensResponse>("/tokens", { method: "GET" }),
    );
  }

  async getMarkets(): Promise<VenueMarketsResponse> {
    return cachedReadthrough(
      "markets",
      MARKET_CACHE_TTL_MS,
      async () => this.request<VenueMarketsResponse>("/markets", { method: "GET" }),
    );
  }

  /**
   * Fetches the aggregated FX rate. Returns null when both base+quote have
   * no provider data within the recency window — caller should fall back.
   * Throws on actual transport / 4xx errors.
   */
  async getFxRate(base: string, quote: string): Promise<VenueFxRate | null> {
    try {
      return await this.request<VenueFxRate>("/fx/rate", {
        method: "GET",
        query: { base, quote },
      });
    } catch (err) {
      if (err instanceof DexApiError && err.status === 503) {
        // Documented: 503 means "no provider data within window" — soft null
        return null;
      }
      throw err;
    }
  }

  /**
   * Generic typed POST for endpoints the higher-level service modules need
   * (transfer build, deposit build, tx broadcast). Exposed publicly because
   * the wallet-signing service in walletSigner.ts needs them.
   */
  async post<T>(
    path: string,
    body: unknown,
    creds?: VenueAuthCreds,
  ): Promise<T> {
    return await this.request<T>(path, {
      method: "POST",
      body,
      auth: creds,
    });
  }

  /**
   * Fetches wallet + vault balances for the given owner. Requires API key
   * credentials (the user's own key — the venue enforces owner_address must
   * match the authenticated owner).
   */
  async getBalances(
    ownerAddress: string,
    creds: VenueAuthCreds,
  ): Promise<{
    owner_address: string;
    balances: Array<{
      token: string;
      symbol: string;
      decimals: number;
      wallet_balance: string;
      vault_available: string;
      vault_frozen: string;
      vault_total: string;
      total: string;
    }>;
    updated_at?: string;
    wallet_balance_available?: boolean;
  }> {
    return await this.request("/balances", {
      method: "GET",
      query: { owner_address: ownerAddress },
      auth: creds,
    });
  }

  /** Settled trades (fills) for an owner — authed. Powers the track record. */
  async getFills(
    ownerAddress: string,
    creds: VenueAuthCreds,
    limit = 50,
  ): Promise<{
    fills?: Array<{
      trade_id?: string;
      order_id?: string;
      side?: string;
      base_symbol?: string;
      quote_symbol?: string;
      price?: string;
      base_amount?: string;
      quote_amount?: string;
      tx_hash?: string;
      created_at?: string | number;
    }>;
  }> {
    return await this.request("/fills", {
      method: "GET",
      query: { owner_address: ownerAddress, limit: String(limit) },
      auth: creds,
    });
  }

  /**
   * An owner's resting orders — authed. NOTE: the response key is `trades`, not
   * `orders` (the venue quirk). Returns every order incl. off-market ones a swap
   * quote-probe can't see. There is NO global "all orders" endpoint — you can
   * only read makers whose key you hold (on testnet = our seed shops).
   */
  async getOrders(
    ownerAddress: string,
    creds: VenueAuthCreds,
  ): Promise<{
    trades?: Array<{
      trade_id?: string;
      status?: string; // pending | settled | cancelled | failed
      order_type?: string;
      symbol?: string;
      side?: string; // bid | ask
      base_symbol?: string;
      quote_symbol?: string;
      base_token?: string;
      quote_token?: string;
      price?: string;
      amount?: string;
      remaining_amount?: string;
      filled_base_amount?: string;
    }>;
  }> {
    return await this.request("/orders", {
      method: "GET",
      query: { owner_address: ownerAddress.toLowerCase() },
      auth: creds,
    });
  }
}

// ─── In-process read-through cache ──────────────────────────────────────────
//
// /tokens and /markets are quasi-static — the registry barely changes hour
// to hour but every browser tab calls them on first render. Caching at the
// server saves ~10 outbound calls per page load when many users hit at once.
// TTLs intentionally short so a token addition propagates within minutes.

const TOKEN_CACHE_TTL_MS = 60_000;   // 1 minute
const MARKET_CACHE_TTL_MS = 60_000;  // 1 minute

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

async function cachedReadthrough<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  // Coalesce concurrent misses so we don't stampede the upstream
  const inFlight = inflight.get(key) as Promise<T> | undefined;
  if (inFlight) return inFlight;

  const p = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: now + ttlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Clears the cache. Useful in tests or after a config rotation. */
export function clearVenueReadCache() {
  cache.clear();
  inflight.clear();
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let singleton: VenueClient | null = null;

/** Returns a process-wide singleton. */
export function getDexClient(): VenueClient {
  if (!singleton) singleton = new VenueClient();
  return singleton;
}
