/**
 * ─── InfoChip ───────────────────────────────────────────────────────────────
 *
 * Small pill button placed near a page header that opens an ExplainerDrawer
 * for the given topic. Used on every tab — Signals/P2P/Swap/etc. — to give
 * users a one-tap "what is this?" affordance.
 *
 * Shows a subtle "•" dot until the user has opened it once; the dot fades on
 * first open (app:onboarding:explainer:<topic>:v1).
 */

import { useState } from "react";
import { ExplainerDrawer } from "./ExplainerDrawer";
import { EXPLAINERS, type TopicKey } from "./copy";
import { useOnboardingState } from "@/hooks/useOnboardingState";

interface InfoChipProps {
  topic: TopicKey;
  /** Override the default chipLabel from copy.ts. */
  label?: string;
  /** Optional compact mode — icon only. */
  compact?: boolean;
}

export function InfoChip({ topic, label, compact }: InfoChipProps) {
  const [open, setOpen] = useState(false);
  const { isExplainerSeen, markExplainerSeen } = useOnboardingState();
  const seen = isExplainerSeen(topic);
  const content = EXPLAINERS[topic];
  const displayLabel = label ?? content?.chipLabel ?? "How this works";

  const handleOpen = () => {
    setOpen(true);
    if (!seen) markExplainerSeen(topic);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label={displayLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: compact ? "4px 8px" : "6px 10px",
          height: compact ? 26 : 30,
          borderRadius: 999,
          border: "1px solid rgba(0, 200, 150, 0.28)",
          background: "rgba(0, 200, 150, 0.08)",
          color: "#00805E",
          fontSize: compact ? 11 : 12,
          fontWeight: 600,
          lineHeight: 1,
          cursor: "pointer",
          whiteSpace: "nowrap",
          position: "relative",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            borderRadius: 999,
            background: "#00C896",
            color: "white",
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          i
        </span>
        {!compact && <span>{displayLabel}</span>}
        {!seen && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              width: 8,
              height: 8,
              borderRadius: 999,
              background: "#FF9500",
              boxShadow: "0 0 0 2px #F2F2F7",
            }}
          />
        )}
      </button>

      <ExplainerDrawer topic={topic} open={open} onOpenChange={setOpen} />
    </>
  );
}
