import { useEffect } from "react";
import { useConfetti } from "@/hooks/useConfetti";

interface SuccessModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  xpAwarded?: number;
  details?: { label: string; value: string }[];
  emoji?: string;
  ctaLabel?: string;
  onCta?: () => void;
  autoClose?: number; // ms, 0 = no auto close
}

export function SuccessModal({
  open,
  onClose,
  title,
  subtitle,
  xpAwarded,
  details,
  emoji = "✅",
  ctaLabel,
  onCta,
  autoClose = 0,
}: SuccessModalProps) {
  const { fireSwapConfetti } = useConfetti();

  useEffect(() => {
    if (open) {
      fireSwapConfetti();
      if (autoClose && autoClose > 0) {
        const t = setTimeout(onClose, autoClose);
        return () => clearTimeout(t);
      }
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          animation: "fadeIn 0.15s ease",
        }}
      />

      {/* Sheet - anchored above the nav bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          bottom: "var(--nav-height, 64px)",
          left: 0, right: 0,
          zIndex: 10000,
          maxWidth: 480,
          margin: "0 auto",
          background: "#FFFFFF",
          borderRadius: "24px 24px 0 0",
          maxHeight: "calc(85vh - var(--nav-height, 64px))",
          display: "flex",
          flexDirection: "column",
          animation: "slideUp 0.25s cubic-bezier(0.34,1.56,0.64,1)",
        }}
      >
        {/* Drag handle */}
        <div style={{
          width: 36, height: 4, borderRadius: 2,
          background: "rgba(60,60,67,0.18)",
          margin: "16px auto 0",
          flexShrink: 0,
        }} />

        {/* Scrollable content */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 24px 0",
          WebkitOverflowScrolling: "touch" as any,
        }}>
          {/* Icon */}
          <div style={{
            width: 72, height: 72, borderRadius: 20,
            background: "rgba(0,200,150,0.10)",
            border: "0.5px solid rgba(0,200,150,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 36, margin: "0 auto 16px",
            animation: "popIn 0.3s cubic-bezier(0.34,1.56,0.64,1) 0.1s both",
          }}>
            {emoji}
          </div>

          {/* Title */}
          <div style={{
            fontSize: 22, fontWeight: 800, color: "#1C1C1E",
            textAlign: "center", letterSpacing: "-0.02em", marginBottom: 8,
          }}>
            {title}
          </div>

          {/* Subtitle */}
          {subtitle && (
            <div style={{
              fontSize: 14, color: "#8E8E93", textAlign: "center",
              lineHeight: 1.55, marginBottom: 20,
            }}>
              {subtitle}
            </div>
          )}

          {/* XP Badge */}
          {xpAwarded && xpAwarded > 0 && (
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
              <div style={{
                background: "linear-gradient(135deg, rgba(0,200,150,0.12), rgba(0,200,150,0.06))",
                border: "0.5px solid rgba(0,200,150,0.30)",
                borderRadius: 20, padding: "8px 20px",
                display: "flex", alignItems: "center", gap: 8,
                animation: "popIn 0.3s cubic-bezier(0.34,1.56,0.64,1) 0.2s both",
              }}>
                <span style={{ fontSize: 18 }}>⚡</span>
                <span style={{ fontSize: 18, fontWeight: 800, color: "#00C896" }}>+{xpAwarded} XP</span>
              </div>
            </div>
          )}

          {/* Details */}
          {details && details.length > 0 && (
            <div style={{
              background: "rgba(118,118,128,0.06)",
              border: "0.5px solid rgba(60,60,67,0.10)",
              borderRadius: 14, padding: "4px 0",
              marginBottom: 8,
            }}>
              {details.map((d, i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: i < details.length - 1 ? "0.5px solid rgba(60,60,67,0.08)" : "none",
                }}>
                  <span style={{ fontSize: 13, color: "#8E8E93" }}>{d.label}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E" }}>{d.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sticky button row - always visible (sheet is above nav) */}
        <div style={{
          flexShrink: 0,
          padding: "12px 24px 24px",
          borderTop: "0.5px solid rgba(60,60,67,0.08)",
          background: "#FFFFFF",
        }}>
          {ctaLabel && onCta ? (
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={onClose}
                style={{
                  flex: 1, padding: "14px 0", borderRadius: 14,
                  border: "0.5px solid rgba(60,60,67,0.20)",
                  background: "transparent",
                  fontSize: 15, fontWeight: 600, color: "#8E8E93",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
              <button
                onClick={() => { onCta(); onClose(); }}
                style={{
                  flex: 2, padding: "14px 0", borderRadius: 14,
                  border: "none",
                  background: "linear-gradient(135deg, #00C896, #00A87A)",
                  fontSize: 15, fontWeight: 700, color: "#FFFFFF",
                  cursor: "pointer",
                  boxShadow: "0 4px 16px rgba(0,200,150,0.30)",
                }}
              >
                {ctaLabel}
              </button>
            </div>
          ) : (
            <button
              onClick={onClose}
              style={{
                width: "100%", padding: "14px 0", borderRadius: 14,
                border: "none",
                background: "linear-gradient(135deg, #00C896, #00A87A)",
                fontSize: 15, fontWeight: 700, color: "#FFFFFF",
                cursor: "pointer",
                boxShadow: "0 4px 16px rgba(0,200,150,0.30)",
              }}
            >
              Done
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }
        @keyframes popIn { from { transform: scale(0.5); opacity: 0 } to { transform: scale(1); opacity: 1 } }
      `}</style>
    </>
  );
}
