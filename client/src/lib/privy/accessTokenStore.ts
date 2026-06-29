/**
 * Module-level Privy access token cache.
 *
 * Lives in its own file so the tRPC fetch link (in main.tsx) and the
 * AuthBridge component (in AuthBridge.tsx) can both touch it without
 * creating a main.tsx ⇄ AuthBridge import cycle. Cycles caused a real
 * "Cannot access 'App' before initialization" runtime error caught by
 * the headless smoke test.
 */

let cachedToken: string | null = null;

export function setPrivyAccessToken(token: string | null) {
  cachedToken = token;
}

export function getPrivyAccessToken(): string | null {
  return cachedToken;
}
