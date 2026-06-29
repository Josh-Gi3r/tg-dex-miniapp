/**
 * ─── Privy Login Configuration ───────────────────────────────────────────────
 *
 * Mirrors the desktop site so wallets sync across surfaces
 * via shared Privy identity (same appId, same DID, same embedded wallet).
 *
 * Login order (top → bottom in the modal):
 *   1. Telegram one-tap   — primary in the TG mini app, where initData is present
 *   2. Google             — most-used desktop method
 *   3. X / Twitter        — second-most-used social
 *   4. Email              — recovery / no-social fallback
 *   5. External wallet    — collapsed list: WalletConnect + 4 deep-link shortcuts
 *
 * Spec ref: https://docs.privy.io/guide/react/configuration/login-methods
 */

import type { PrivyClientConfig } from "@privy-io/react-auth";

export const APP_PRIVY_CONFIG: PrivyClientConfig = {
  // Login method order shown in the modal
  loginMethods: ["telegram", "google", "twitter", "email", "wallet"],

  // Embedded-wallet auto-creation. Matches the web app: every signed-in user
  // who doesn't already have an external wallet gets a Privy-managed one.
  embeddedWallets: {
    ethereum: {
      createOnLogin: "users-without-wallets",
    },
    showWalletUIs: false,
  },

  appearance: {
    theme: "light",
    accentColor: "#00C896",
    showWalletLoginFirst: false,
    logo: undefined,
  },

  // Reuse session across page reloads and TG mini-app restarts.
  // Privy stores the refresh token in a SameSite=Lax cookie when on web;
  // in TG WebView it falls back to localStorage.
  legal: {
    termsAndConditionsUrl: import.meta.env.VITE_TERMS_URL ?? "",
    privacyPolicyUrl: import.meta.env.VITE_PRIVACY_URL ?? "",
  },

  // External wallet support — WalletConnect plus deep-link
  // shortcuts (MetaMask / Coinbase / Trust / OKX) come from Privy's defaults
  // when "wallet" is in loginMethods. No extra config needed here.
};

/**
 * Reads the Privy app ID from Vite env. Returns null when unset, so the
 * provider can render a no-op fallback rather than crashing.
 *
 * Once the venue shares the canonical appId, set:
 *   VITE_PRIVY_APP_ID=<their-app-id>
 *   VITE_FEATURE_PRIVY_AUTH=true
 *
 * If either is missing the legacy Telegram-cookie auth path stays active.
 */
export function getPrivyAppId(): string | null {
  const id = import.meta.env.VITE_PRIVY_APP_ID;
  if (!id || typeof id !== "string" || id.startsWith("tbd_") || id.length < 8) {
    return null;
  }
  return id;
}

export function isPrivyAuthEnabled(): boolean {
  return getPrivyAppId() !== null && import.meta.env.VITE_FEATURE_PRIVY_AUTH === "true";
}
