/**
 * ─── Privy → tRPC Auth Bridge ────────────────────────────────────────────────
 *
 * Lives inside the React tree (so it can call usePrivy hooks) but writes the
 * current access token into a module-level cache that the tRPC fetch link
 * reads synchronously on every request.
 *
 * Also POSTs to /api/auth/privy whenever the Privy session changes, so the
 * server can attach a session cookie to the user (matching the existing
 * Telegram auto-login pattern). This means protectedProcedure works without
 * needing the client to manually send a header on every request — the cookie
 * is the durable handshake; the Authorization header is the redundant fallback.
 */

import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { setPrivyAccessToken } from "./accessTokenStore";
import { isPrivyAuthEnabled } from "./loginConfig";

export function PrivyAuthBridge() {
  const { ready, authenticated, getAccessToken, user } = usePrivy();

  useEffect(() => {
    let cancelled = false;
    if (!ready || !isPrivyAuthEnabled()) {
      setPrivyAccessToken(null);
      return;
    }
    if (!authenticated) {
      setPrivyAccessToken(null);
      return;
    }
    (async () => {
      try {
        const token = await getAccessToken();
        if (cancelled) return;
        setPrivyAccessToken(token);
        // Fire-and-forget session bootstrap. Server will upsert the user
        // row and set a session cookie keyed on Privy DID.
        if (token) {
          fetch("/api/auth/privy", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ did: user?.id }),
            credentials: "include",
          }).catch((err) => {
            console.warn("[PrivyAuthBridge] Session bootstrap failed:", err);
          });
        }
      } catch (err) {
        console.warn("[PrivyAuthBridge] Failed to fetch access token:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, user?.id, getAccessToken]);

  return null;
}
