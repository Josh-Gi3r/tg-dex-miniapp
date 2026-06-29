import { useEffect } from "react";
import { PEER_FIAT_CURRENCIES } from "@shared/peer-config";
import { useTelegram } from "@/contexts/TelegramContext";

interface Props {
  open: boolean;
  onClose: () => void;
  selected: string;
  onSelect: (code: string) => void;
  only?: string[];
}

/** Pick the cash currency — App DS glass bottom sheet. */
export default function FiatCurrencyPickerSheet({ open, onClose, selected, onSelect, only }: Props) {
  const { haptic } = useTelegram();
  const list = only?.length ? PEER_FIAT_CURRENCIES.filter((c) => only.includes(c.code)) : PEER_FIAT_CURRENCIES;

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
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#1C1C1E", margin: 0, letterSpacing: "-0.02em" }}>Choose currency</h2>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(118,118,128,0.12)", border: "none", cursor: "pointer", fontSize: 15, color: "#8E8E93" }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {list.map((c) => {
            const sel = c.code === selected;
            return (
              <button key={c.code} onClick={() => { haptic.impact("light"); onSelect(c.code); }}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "13px 20px", borderBottom: "0.5px solid rgba(60,60,67,0.08)", background: sel ? "rgba(0,200,150,0.06)" : "transparent", border: "none", cursor: "pointer", textAlign: "left" }}>
                <span style={{ fontSize: 26 }}>{c.flag}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "#1C1C1E" }}>{c.code} <span style={{ color: "#8E8E93", fontWeight: 500 }}>{c.symbol}</span></div>
                  <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 1 }}>{c.name}</div>
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
