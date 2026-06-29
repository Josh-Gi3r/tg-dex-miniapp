/**
 * Demo gate — for the testnet demo, the ONLY working function is importing a
 * wallet. Every other action (Swap, Send, P2P trade, Promotion, Earn, Withdraw,
 * Assistant…) is switched off and shows a clear "switched off for the demo"
 * popup when tapped. The real implementations stay in the code behind this flag;
 * flip DEMO_MODE to false (or wire it to an env flag) to turn them on.
 */
import { createContext, useContext, useState, type ReactNode } from "react";

// Single switch for the demo. true = everything but wallet import is off.
export const DEMO_MODE = false;

interface DemoGateValue {
  /** If demo mode is on, opens the "switched off" popup and returns true (caller
   *  should `return` early). Returns false when actions are allowed. */
  blockIfDemo: (label?: string) => boolean;
}

const Ctx = createContext<DemoGateValue>({ blockIfDemo: () => false });

export function useDemoGate(): DemoGateValue {
  return useContext(Ctx);
}

export function DemoGateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<string | undefined>(undefined);

  const blockIfDemo = (l?: string): boolean => {
    if (!DEMO_MODE) return false;
    setLabel(l);
    setOpen(true);
    return true;
  };

  return (
    <Ctx.Provider value={{ blockIfDemo }}>
      {children}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 340, background: "#FFFFFF", borderRadius: 20, padding: "24px 20px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}
          >
            <div style={{ fontSize: 38, marginBottom: 10 }}>🚧</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1C1C1E", marginBottom: 6 }}>
              {label ? `${label} is off for the demo` : "Switched off for the demo"}
            </div>
            <div style={{ fontSize: 13.5, color: "#8E8E93", lineHeight: 1.5, marginBottom: 18 }}>
              This is a testnet demo — only importing your wallet is turned on. Swap, Send,
              P2P trading and the rest are switched off here and go live after the demo.
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{ width: "100%", padding: "13px 0", borderRadius: 14, border: "none", background: "linear-gradient(135deg,#00C896,#00A87A)", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
