/**
 * ─── Session ────────────────────────────────────────────────────────────────
 *
 * Cookie-based JWT sessions, signed with JWT_SECRET. Replaces the previous
 * Session management. Two callers:
 *
 *   - oauth.ts       → mints a session after Telegram or Privy auth
 *   - context.ts     → verifies the cookie on every tRPC request
 *
 * No external service, no OAuth portal. The Telegram + Privy bootstrap
 * routes are in oauth.ts (kept for backwards-compat with the old name).
 */

import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

function getSecretKey(): Uint8Array {
  if (!ENV.jwtSecret) {
    throw new Error("JWT_SECRET is required");
  }
  return new TextEncoder().encode(ENV.jwtSecret);
}

export async function createSessionToken(
  openId: string,
  options: { expiresInMs?: number; name?: string } = {},
): Promise<string> {
  const issuedAt = Date.now();
  const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
  const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
  return new SignJWT({
    openId,
    appId: ENV.appId,
    name: options.name ?? "",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(getSecretKey());
}

export async function verifySession(
  cookieValue: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!cookieValue) return null;
  try {
    const { payload } = await jwtVerify(cookieValue, getSecretKey(), {
      algorithms: ["HS256"],
    });
    const { openId, appId, name } = payload as Record<string, unknown>;
    if (typeof openId !== "string" || openId.length === 0) return null;
    return {
      openId,
      appId: typeof appId === "string" ? appId : ENV.appId,
      name: typeof name === "string" ? name : "",
    };
  } catch (error) {
    console.warn("[session] verify failed:", String(error));
    return null;
  }
}

function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  return parseCookieHeader(header)[COOKIE_NAME];
}

/**
 * Resolves the current user from the session cookie. The user row must
 * already exist — bootstrap (Telegram initData / Privy token) creates
 * it via the routes in oauth.ts before any protected procedure fires.
 */
export async function authenticateRequest(req: Request): Promise<User> {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (!session) throw ForbiddenError("Invalid session cookie");

  const user = await db.getUserByOpenId(session.openId);
  if (!user) throw ForbiddenError("User not found");

  await db.upsertUser({ openId: user.openId, lastSignedIn: new Date() });
  return user;
}

// Backwards-compat: the legacy code imported `sdk.createSessionToken`,
// `sdk.verifySession`, `sdk.authenticateRequest`. Re-expose under the
// same surface so downstream callers don't need to change.
export const sdk = {
  createSessionToken,
  verifySession,
  authenticateRequest,
};
