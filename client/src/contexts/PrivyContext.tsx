/**
 * ─── PrivyContext ────────────────────────────────────────────────────────────
 *
 * Wraps the app in <PrivyProvider> when an appId is configured. When
 * VITE_PRIVY_APP_ID is missing or set to a `tbd_…` placeholder, this
 * component renders children directly so the legacy Telegram-cookie auth
 * path keeps working.
 *
 * Mirrors the web app — same Privy app, same DID, same wallet across desktop
 * and TG mini app.
 */

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { APP_PRIVY_CONFIG, getPrivyAppId } from "@/lib/privy/loginConfig";

export function AppPrivyProvider({ children }: { children: ReactNode }) {
  const appId = getPrivyAppId();

  if (!appId) {
    // Pre-cutover — render children without a Privy provider.
    // useVenueWallet() will return isReady=false, isAuthenticated=false.
    return <>{children}</>;
  }

  return (
    <PrivyProvider appId={appId} config={APP_PRIVY_CONFIG}>
      {children}
    </PrivyProvider>
  );
}
