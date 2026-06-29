import { useEffect } from "react";
import { PEER_PAYMENT_PLATFORMS, platformsForCurrency } from "@shared/peer-config";
import { useTelegram } from "@/contexts/TelegramContext";

interface Props {
  open: boolean;
  onClose: () => void;
  selected: string;
  onSelect: (key: string) => void;
  forCurrency?: string;
}

/** Pick the payment app — App DS glass bottom sheet. */
export default function PaymentPlatformPickerSheet({ open, onClose, selected, onSelect, forCurrency }: Props) {
  const { haptic } = useTelegram();
  const list = forCurrency ? platformsForCurrency(forCurrency) : PEER_PAYMENT_PLATFORMS;

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="bottom-sheet-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="bottom-sheet-handle" />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 20px 14px", borderBottom: "0.5px solid rgba(60,60,67,0.12)" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#1C1C1E", margin: 0, letterSpacing: "-0.02em" }}>Choose app</h2>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(118,118,128,0.12)", border: "none", cursor: "pointer", fontSize: 15, color: "#8E8E93" }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {list.length === 0 && <div style={{ padding: "26px 20px", textAlign: "center", color: "#8E8E93", fontSize: 14 }}>No apps for this currency yet.</div>}
          {list.map((p) => {
            const sel = p.key === selected;
            return (
              <button key={p.key} onClick={() => { haptic.impact("light"); onSelect(p.key); }}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "13px 20px", borderBottom: "0.5px solid rgba(60,60,67,0.08)", background: sel ? "rgba(0,200,150,0.06)" : "transparent", border: "none", cursor: "pointer", textAlign: "left" }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(118,118,128,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>{p.displayName.slice(0, 2)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "#1C1C1E" }}>{p.displayName}</div>
                  <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 1 }}>{p.currencies.slice(0, 4).join(" · ")}{p.needsTakerRegistration ? "  ·  one-time check" : ""}</div>
                </div>
                {sel && <span style={{ color: "#00C896", fontSize: 18, fontWeight: 700 }}>✓</span>}
              </button>
            );
          })}
          <div style={{ height: 24 }} />
        </div>
      </div>
    </div>
  );
}
