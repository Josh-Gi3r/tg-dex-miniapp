/**
 * ─── Walkthrough ────────────────────────────────────────────────────────────
 *
 * Dependency-free spotlight coach-tour for first-timers. Highlights an element
 * (data-tour="<key>") with a dimmed cutout + a plain-language tooltip; Next /
 * Back / Skip. Auto-runs once per tab (gated by useOnboardingState coach flags)
 * and is re-summonable anytime via the header "?" button.
 *
 * TG-webview-safe: position:fixed over the app shell, scrolls the target into
 * view before measuring, recomputes on scroll/resize, and gracefully renders a
 * centered card when a step's target isn't on screen (conditional UI) instead
 * of pointing at nothing.
 */
import { useLayoutEffect, useState, type CSSProperties } from "react";

export interface TourStep {
  /** data-tour attribute value to spotlight. Omitted/not-found → centered card. */
  target?: string;
  title: string;
  body: string;
}

const btnGhost: CSSProperties = {
  background: "none", border: "none", color: "#8E8E93", fontSize: 13,
  fontWeight: 600, cursor: "pointer", padding: "8px 10px",
};
const btnPrimary: CSSProperties = {
  background: "linear-gradient(135deg,#00C896,#00A87A)", color: "#fff",
  border: "none", borderRadius: 12, fontSize: 14, fontWeight: 700,
  padding: "9px 18px", cursor: "pointer",
};

export function Walkthrough({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step: TourStep | undefined = steps[i];

  useLayoutEffect(() => {
    if (!step) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      if (!step.target) { setRect(null); return; }
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (!el) { setRect(null); return; }
      el.scrollIntoView({ block: "center", behavior: "auto" });
      requestAnimationFrame(() => { if (!cancelled) setRect(el.getBoundingClientRect()); });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [i, step]);

  if (!step) { onClose(); return null; }

  const isLast = i >= steps.length - 1;
  const next = () => (isLast ? onClose() : setI((n) => n + 1));
  const back = () => setI((n) => Math.max(0, n - 1));

  const pad = 8;
  const hole = rect
    ? {
        top: Math.max(rect.top - pad, 4),
        left: Math.max(rect.left - pad, 4),
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      }
    : null;

  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  // Put the tooltip above the spotlight when the target sits low (so it never
  // hides under the fixed bottom nav); otherwise below.
  const placeAbove = hole ? hole.top + hole.height > vh * 0.55 : false;
  const tooltipStyle: CSSProperties = hole
    ? placeAbove
      ? { left: 16, right: 16, bottom: vh - hole.top + 12 }
      : { left: 16, right: 16, top: hole.top + hole.height + 12 }
    : { left: 16, right: 16, top: "50%", transform: "translateY(-50%)" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 5000 }}>
      {/* Spotlight: dim everything except the cutout via a huge box-shadow. */}
      {hole ? (
        <div
          style={{
            position: "fixed", top: hole.top, left: hole.left, width: hole.width, height: hole.height,
            borderRadius: 12, boxShadow: "0 0 0 9999px rgba(0,0,0,0.62)",
            transition: "top .2s ease,left .2s ease,width .2s ease,height .2s ease", pointerEvents: "none",
          }}
        />
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.62)", pointerEvents: "none" }} />
      )}
      {/* Click-catcher: tap anywhere to advance + block underlying interaction. */}
      <div onClick={next} style={{ position: "fixed", inset: 0, background: "transparent" }} />
      {/* Tooltip card. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed", ...tooltipStyle, maxWidth: 360, margin: "0 auto",
          background: "#FFFFFF", borderRadius: 16, padding: 16,
          boxShadow: "0 12px 44px rgba(0,0,0,0.32)", zIndex: 5001,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "#00A07A", marginBottom: 6 }}>
          {i + 1} / {steps.length}
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#1C1C1E", marginBottom: 6 }}>{step.title}</div>
        <div style={{ fontSize: 13.5, color: "#3C3C43", lineHeight: 1.5, marginBottom: 14 }}>{step.body}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={onClose} style={btnGhost}>Skip</button>
          <div style={{ flex: 1 }} />
          {i > 0 && (
            <button onClick={back} style={btnGhost}>Back</button>
          )}
          <button onClick={next} style={btnPrimary}>{isLast ? "Got it" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
