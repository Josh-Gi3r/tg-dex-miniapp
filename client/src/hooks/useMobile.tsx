/**
 * ─── useMobile ────────────────────────────────────────────────────────────────
 *
 * Returns true when the viewport width is below the mobile breakpoint (768px).
 * Used by the shadcn/ui Sidebar component. This is a UI infrastructure hook.
 *
 * Note: The Sidebar component is not used in the Mini App UI (which is always
 * mobile), but it is part of the shadcn/ui component library installed in this
 * project and must compile without errors.
 */

import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(
    () => window.innerWidth < MOBILE_BREAKPOINT
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
