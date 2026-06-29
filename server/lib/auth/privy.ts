/**
 * ─── Privy Server Auth (JWK-based) ───────────────────────────────────────────
 *
 * Verifies Privy access tokens against the public JWK Set published at
 *   https://auth.privy.io/api/v1/apps/{appId}/jwks.json
 *
 * No PRIVY_APP_SECRET required — only the public PRIVY_APP_ID. The trade-off
 * versus the official `@privy-io/server-auth` SDK is that we lose the
 * convenience `getUser()` enrichment call. Wallet address / email / linked
 * accounts come from the JWT claims directly when present, otherwise from
 * trust-but-verified client-supplied fields on `/api/auth/privy`.
 *
 * Spec ref: https://docs.privy.io/guide/server/authorization/jwt-validation
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const APP_ID = process.env.PRIVY_APP_ID ?? "";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!APP_ID) return null;
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${APP_ID}/jwks.json`),
      {
        cooldownDuration: 30_000, // 30s before re-fetching JWKs after a miss
        cacheMaxAge: 600_000,     // 10min in-memory cache
      },
    );
  }
  return jwks;
}

export interface PrivyVerifiedSession {
  userId: string;
  /** Lower-cased wallet address from JWT custom claim, or null. */
  wallet: string | null;
  /** Best-effort login method derived from JWT claim if present. */
  loginMethod: string | null;
  /** Email from JWT custom claim, or null. */
  email: string | null;
  /** Token expiry (unix seconds). */
  expiresAt: number;
}

/** True when Privy is configured (we have an appId set). */
export function isPrivyConfigured(): boolean {
  return Boolean(APP_ID);
}

/**
 * Verifies a Privy access token. Returns null on missing config, expired
 * token, signature mismatch, or audience/issuer mismatch — all expected
 * cases. Throws only on unexpected exceptions (network, etc.).
 */
export async function verifyPrivyToken(
  token: string,
): Promise<PrivyVerifiedSession | null> {
  const set = getJwks();
  if (!set) return null;

  try {
    const { payload } = await jwtVerify(token, set, {
      issuer: "privy.io",
      audience: APP_ID,
    });
    return extractSession(payload);
  } catch (err: any) {
    const msg = err?.code ?? err?.message ?? "";
    // jose throws JWT_EXPIRED / JWT_INVALID / JWS_SIGNATURE_VERIFICATION_FAILED
    // for the expected "bad token" cases — return null silently.
    if (
      typeof msg === "string" &&
      (msg.includes("JWT") || msg.includes("JWS") || msg.includes("expired"))
    ) {
      return null;
    }
    throw err;
  }
}

function extractSession(payload: JWTPayload): PrivyVerifiedSession | null {
  const userId = typeof payload.sub === "string" ? payload.sub : null;
  if (!userId) return null;
  const expiresAt = Number(payload.exp ?? 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

  // Privy access tokens carry custom claims in a few possible shapes —
  // we read them defensively. None are required; missing fields just
  // get filled in by the client side via /api/auth/privy body fields.
  const claims = payload as Record<string, unknown>;
  const walletAddress =
    pickString(claims.wallet_address) ??
    pickString((claims.wallet as Record<string, unknown> | undefined)?.address) ??
    null;
  const email =
    pickString(claims.email) ??
    pickString((claims.email as Record<string, unknown> | undefined)?.address) ??
    null;
  const loginMethod = pickString(claims.login_method) ?? null;

  return {
    userId,
    wallet: walletAddress ? walletAddress.toLowerCase() : null,
    loginMethod,
    email,
    expiresAt,
  };
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
