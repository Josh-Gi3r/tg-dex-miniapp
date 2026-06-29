/**
 * RealMoneyNotice — popup when a user taps a real-money button before it's on.
 * App DS glass (iOS centered alert).
 */
import { useEffect } from "react";

interface Props {
  open: boolean;
  onAck: () => void;
}

export default function RealMoneyNotice({ open, onAck }: Props) {
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 28 }}>
      <div className="glass-card-elevated" style={{ width: "100%", maxWidth: 320, padding: "26px 22px", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>💵</div>
        <div style={{ fontSize: 19, fontWeight: 700, color: "#1C1C1E", marginBottom: 8, letterSpacing: "-0.02em" }}>Almost ready</div>
        <div style={{ fontSize: 14, color: "#8E8E93", lineHeight: 1.5, marginBottom: 20 }}>
          Buying and selling here move <b style={{ color: "#1C1C1E" }}>real money</b>, so we're finishing the final
          safety checks. It switches on very soon — everything else works now.
        </div>
        <button className="btn-primary" onClick={onAck}>Got it</button>
      </div>
    </div>
  );
}
