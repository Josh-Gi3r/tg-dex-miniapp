import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { createSessionToken } from "./session";
import { validateTelegramInitData, isTelegramInitDataFresh } from "../telegramAuth";
import { verifyPrivyToken } from "../lib/auth/privy";

export function registerOAuthRoutes(app: Express) {
  /**
   * POST /api/auth/telegram
   * Body: { initData: string }  — the raw Telegram.WebApp.initData string
   *
   * Validates the HMAC signature, upserts the user by telegramId,
   * and issues a JWT session cookie. This is the primary auth path
   * for the Telegram Mini App — no redirect, no OAuth dance.
   */
  app.post("/api/auth/telegram", async (req: Request, res: Response) => {
    const { initData } = req.body as { initData?: string };

    if (!initData) {
      res.status(400).json({ error: "initData is required" });
      return;
    }

    try {
      // Validate freshness (reject if older than 24h)
      if (!isTelegramInitDataFresh(initData)) {
        res.status(401).json({ error: "initData has expired" });
        return;
      }

      // Validate HMAC signature — throws if invalid
      const tgUser = validateTelegramInitData(initData) as {
        id: number;
        username?: string;
        first_name?: string;
        last_name?: string;
        language_code?: string;
        is_premium?: boolean;
      };

      if (!tgUser?.id) {
        res.status(400).json({ error: "No user in initData" });
        return;
      }

      const telegramId = String(tgUser.id);
      const displayName = [
        tgUser.first_name,
        tgUser.last_name,
      ].filter(Boolean).join(" ") || tgUser.username || `User ${telegramId}`;

      // Use telegramId as the stable openId for Telegram users
      const openId = `tg_${telegramId}`;

      await db.upsertUser({
        openId,
        telegramId,
        telegramUsername: tgUser.username ?? null,
        telegramChatId: tgUser.id,
        name: displayName,
        loginMethod: "telegram",
        lastSignedIn: new Date(),
      });

      const sessionToken = await createSessionToken(openId, {
        name: displayName,
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.json({ success: true, name: displayName });
    } catch (error: any) {
      console.error("[TelegramAuth] Failed:", error?.message);
      res.status(401).json({ error: "Invalid Telegram initData" });
    }
  });

  /**
   * POST /api/auth/privy
   * Header: Authorization: Bearer <privy-access-token>
   * Body:   { did?: string }  — informational; we trust the verified token only.
   *
   * Bootstraps the server session for a Privy-authenticated user. This is
   * the canonical auth path once FEATURE_PRIVY_AUTH is on, matching how
   * the desktop web app authenticates against the same Privy app.
   */
  app.post("/api/auth/privy", async (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Missing Privy access token" });
      return;
    }

    try {
      const verified = await verifyPrivyToken(token);
      if (!verified) {
        res.status(401).json({ error: "Invalid Privy token" });
        return;
      }

      const did = verified.userId;
      const openId = `privy_${did}`;
      const wallet = verified.wallet?.toLowerCase() ?? null;

      await db.upsertUser({
        openId,
        privyDid: did,
        walletAddress: wallet,
        email: verified.email,
        loginMethod: verified.loginMethod ?? "privy",
        lastSignedIn: new Date(),
      });

      const sessionToken = await createSessionToken(openId, {
        name: did,
        expiresInMs: ONE_YEAR_MS,
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.json({ success: true, did, wallet });
    } catch (error: any) {
      console.error("[PrivyAuth] Failed:", error?.message);
      res.status(401).json({ error: "Privy auth failed" });
    }
  });

}
