interface ConfirmSheetProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  subtitle?: string;
  details?: { label: string; value: string; highlight?: boolean }[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  emoji?: string;
}

export function ConfirmSheet({
  open,
  onClose,
  onConfirm,
  title,
  subtitle,
  details,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  loading = false,
  emoji,
}: ConfirmSheetProps) {
  if (!open) return null;

  return (
    <>
      {/* Backdrop - covers full screen but sits below the sheet */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 9000,
          background: "rgba(0,0,0,0.50)",
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
          zIndex: 9001,
          maxWidth: 480,
          margin: "0 auto",
          background: "#FFFFFF",
          borderRadius: "24px 24px 0 0",
          maxHeight: "calc(85vh - var(--nav-height, 64px))",
          display: "flex",
          flexDirection: "column",
          animation: "slideUp 0.22s cubic-bezier(0.34,1.56,0.64,1)",
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
          padding: "16px 20px 0",
          WebkitOverflowScrolling: "touch" as any,
        }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: subtitle ? 8 : 16 }}>
            {emoji && (
              <div style={{
                width: 44, height: 44, borderRadius: 12,
                background: danger ? "rgba(224,82,82,0.10)" : "rgba(0,200,150,0.10)",
                border: `0.5px solid ${danger ? "rgba(224,82,82,0.25)" : "rgba(0,200,150,0.25)"}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 22, flexShrink: 0,
              }}>
                {emoji}
              </div>
            )}
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1C1C1E", letterSpacing: "-0.01em" }}>
              {title}
            </div>
          </div>

          {subtitle && (
            <div style={{ fontSize: 13, color: "#8E8E93", lineHeight: 1.55, marginBottom: 16 }}>
              {subtitle}
            </div>
          )}

          {/* Details */}
          {details && details.length > 0 && (
            <div style={{
              background: "rgba(118,118,128,0.05)",
              border: "0.5px solid rgba(60,60,67,0.10)",
              borderRadius: 14, padding: "4px 0", marginBottom: 8,
            }}>
              {details.map((d, i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: i < details.length - 1 ? "0.5px solid rgba(60,60,67,0.08)" : "none",
                }}>
                  <span style={{ fontSize: 13, color: "#8E8E93" }}>{d.label}</span>
                  <span style={{
                    fontSize: 14, fontWeight: 700,
                    color: d.highlight ? "#00C896" : "#1C1C1E",
                  }}>
                    {d.value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

         {/* Sticky button row - always visible (sheet is above nav) */}
        <div style={{
          flexShrink: 0,
          padding: "12px 20px 24px",
          borderTop: "0.5px solid rgba(60,60,67,0.08)",
          background: "#FFFFFF",
          display: "flex", gap: 10,
        }}>
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              flex: 1, padding: "14px 0", borderRadius: 14,
              border: "0.5px solid rgba(60,60,67,0.20)",
              background: "transparent",
              fontSize: 15, fontWeight: 600, color: "#8E8E93",
              cursor: "pointer",
              opacity: loading ? 0.5 : 1,
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            style={{
              flex: 2, padding: "14px 0", borderRadius: 14,
              border: "none",
              background: loading
                ? "rgba(118,118,128,0.20)"
                : danger
                  ? "linear-gradient(135deg, #E05252, #C0392B)"
                  : "linear-gradient(135deg, #00C896, #00A87A)",
              fontSize: 15, fontWeight: 700,
              color: loading ? "#AEAEB2" : "#FFFFFF",
              cursor: loading ? "default" : "pointer",
              boxShadow: loading ? "none" : danger
                ? "0 4px 16px rgba(224,82,82,0.25)"
                : "0 4px 16px rgba(0,200,150,0.30)",
              transition: "all 0.15s ease",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            {loading ? (
              <>
                <span style={{
                  width: 16, height: 16, borderRadius: "50%",
                  border: "2px solid rgba(60,60,67,0.20)",
                  borderTopColor: "#8E8E93",
                  animation: "spin 0.6s linear infinite",
                  display: "inline-block",
                }} />
                Processing...
              </>
            ) : confirmLabel}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }
        @keyframes spin { to { transform: rotate(360deg) } }
      `}</style>
    </>
  );
}
