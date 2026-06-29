import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { verifyPrivyToken } from "../lib/auth/privy";
import { authenticateRequest } from "./session";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

/**
 * Resolves the request's user. Tries Privy bearer auth first (matches the web app
 * pattern), then falls back to the legacy session cookie. The two paths are
 * non-exclusive during the cutover — once FEATURE_PRIVY_AUTH is fully on, the
 * cookie path can be retired.
 */
export async function createContext(
  opts: CreateExpressContextOptions,
): Promise<TrpcContext> {
  let user: User | null = null;

  // 1. Privy bearer auth (preferred when present)
  const auth = opts.req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (bearer) {
    try {
      const verified = await verifyPrivyToken(bearer);
      if (verified) {
        const openId = `privy_${verified.userId}`;
        let row = await db.getUserByOpenId(openId);
        if (!row) {
          await db.upsertUser({
            openId,
            privyDid: verified.userId,
            walletAddress: verified.wallet,
            email: verified.email,
            loginMethod: verified.loginMethod ?? "privy",
            lastSignedIn: new Date(),
          });
          row = await db.getUserByOpenId(openId);
        }
        if (row) user = row;
      }
    } catch (err) {
      console.warn("[Context] Privy verification failed:", err);
    }
  }

  // 2. Legacy cookie session — fallback while FEATURE_PRIVY_AUTH is off
  if (!user) {
    try {
      user = await authenticateRequest(opts.req);
    } catch {
      user = null;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
