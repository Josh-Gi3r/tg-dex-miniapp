/**
 * ─── useCronStatus ──────────────────────────────────────────────────────────
 *
 * Polls `system.cronStatus` every 20s and ticks an internal 1s clock so the
 * derived "secondsAgo / secondsIn" strings stay accurate between refetches.
 *
 * `serverNow` from the response anchors the time math to the server clock —
 * the client's local clock can be off by minutes (Telegram WebView on a
 * jet-lagged phone) without breaking the pill.
 *
 * Returns null fields when no cycle has run yet so the consumer can render
 * "Initializing…" instead of crashing on `lastRunAt`.
 */

import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

interface CycleStatus {
  /** Seconds since the cycle finished, server-anchored. */
  secondsAgo: number;
  /** Seconds until the next scheduled cycle (clamped >= 0). */
  secondsIn: number;
  /** Cycle is overdue (>2x interval since last run). */
  isStale: boolean;
}

export function useCronStatus() {
  const query = trpc.system.cronStatus.useQuery(undefined, {
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const data = query.data;
    if (!data) {
      return {
        loading: query.isLoading,
        signals: null,
        yield: null,
      };
    }

    /** Offset between client clock and server clock at fetch time. */
    const clockSkew = now - data.serverNow;

    const derive = (
      cycle: { lastRunAt: number; intervalMs: number } | null,
    ): CycleStatus | null => {
      if (!cycle) return null;
      const elapsedMs = Math.max(0, now - cycle.lastRunAt - clockSkew);
      const secondsAgo = Math.floor(elapsedMs / 1000);
      const secondsIn = Math.max(
        0,
        Math.ceil((cycle.intervalMs - elapsedMs) / 1000),
      );
      const isStale = elapsedMs > cycle.intervalMs * 2;
      return { secondsAgo, secondsIn, isStale };
    };

    return {
      loading: false,
      signals: data.signals
        ? {
            ...derive(data.signals)!,
            activeAds: data.signals.activeAds,
            candidatesEmitted: data.signals.candidatesEmitted,
            notificationsSent: data.signals.notificationsSent,
            hasErrors: data.signals.errors.length > 0,
          }
        : null,
      yield: data.yield ? derive(data.yield) : null,
    };
  }, [query.data, query.isLoading, now]);
}
