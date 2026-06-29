/**
 * ─── CronStatusPill ─────────────────────────────────────────────────────────
 *
 * "Last scan 23s ago · next in 37s" pill. Lives on the Signals tab to make
 * the otherwise-invisible 60s signal cron visible — users see the bot is
 * alive even when no candidates are emitted.
 *
 * Auto-ticks every second; the underlying tRPC query refetches every 20s.
 */

import { useCronStatus } from "@/hooks/useCronStatus";

function formatAgo(secs: number): string {
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

export function CronStatusPill() {
  const status = useCronStatus();

  if (status.loading) {
    return <Pill tone="neutral">Connecting…</Pill>;
  }

  if (!status.signals) {
    return <Pill tone="neutral">Bot warming up</Pill>;
  }

  const { secondsAgo, secondsIn, isStale, hasErrors } = status.signals;
  const tone: PillTone = isStale ? "warn" : hasErrors ? "warn" : "ok";

  return (
    <Pill tone={tone}>
      <span style={{ opacity: 0.85 }}>Last scan </span>
      <strong>{formatAgo(secondsAgo)}</strong>
      <span style={{ opacity: 0.55, margin: "0 4px" }}>·</span>
      <span style={{ opacity: 0.85 }}>next in </span>
      <strong>{secondsIn}s</strong>
    </Pill>
  );
}

type PillTone = "ok" | "warn" | "neutral";

function Pill({
  tone,
  children,
}: {
  tone: PillTone;
  children: React.ReactNode;
}) {
  const palette: Record<PillTone, { bg: string; fg: string; dot: string }> = {
    ok: {
      bg: "rgba(0, 200, 150, 0.10)",
      fg: "#00805E",
      dot: "#00C896",
    },
    warn: {
      bg: "rgba(255, 149, 0, 0.10)",
      fg: "#8A4B00",
      dot: "#FF9500",
    },
    neutral: {
      bg: "rgba(60, 60, 67, 0.08)",
      fg: "#3C3C43",
      dot: "#8E8E93",
    },
  };
  const { bg, fg, dot } = palette[tone];

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 9px",
        height: 24,
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 500,
        whiteSpace: "nowrap",
        lineHeight: 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: dot,
          boxShadow: tone === "ok" ? `0 0 0 3px ${dot}33` : "none",
          flexShrink: 0,
        }}
      />
      {children}
    </span>
  );
}
