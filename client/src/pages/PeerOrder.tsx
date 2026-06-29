/**
 * PeerOrder — lifecycle for a Cash-In order: signaled → pay → verify → done.
 * App DS glass. (Proof capture is the Path-A spike — isolated in verify().)
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { toast } from "sonner";
import { peerFiat, peerPlatform } from "@shared/peer-config";

interface Props { rowId: number; onBack: () => void; }

const TEAL = "#00C896";
const T1 = "#1C1C1E";
const T3 = "#8E8E93";
const BASE_EXPLORER = "https://basescan.org/tx/";
const STEPS = ["Send cash", "Check", "Done"];
const stepIndex = (s: string) => (s === "fulfilled" || s === "bridged" ? 3 : s === "proving" || s === "paid" ? 2 : 1);

export default function PeerOrder({ rowId, onBack }: Props) {
  const { haptic } = useTelegram();
  const utils = trpc.useUtils();
  const [reference, setReference] = useState("");
  const q = trpc.peer.intent.useQuery({ rowId }, { refetchInterval: 5000, retry: false });
  const row = q.data?.row;

  const markPaid = trpc.peer.markPaid.useMutation({ onSuccess: () => { haptic.notification("success"); utils.peer.intent.invalidate({ rowId }); }, onError: (e) => toast.error(e.message) });
  const fulfill = trpc.peer.fulfillIntent.useMutation({ onSuccess: () => { haptic.notification("success"); toast.success("Payment confirmed — your USDC is on the way."); utils.peer.intent.invalidate({ rowId }); }, onError: (e) => toast.error(e.message || "Couldn't confirm that yet.") });
  const cancel = trpc.peer.cancelIntent.useMutation({ onSuccess: () => { utils.peer.intent.invalidate({ rowId }); onBack(); }, onError: (e) => toast.error(e.message) });

  if (q.isLoading) return <Center>Loading…</Center>;
  if (!row) return <Center>Order not found.</Center>;

  const plat = peerPlatform(row.paymentPlatform);
  const fiat = peerFiat(row.fiatCurrency);
  const status = row.status;
  const si = stepIndex(status);
  const done = status === "fulfilled" || status === "bridged";

  function openApp() {
    haptic.impact("medium");
    const urls: Record<string, string> = { wise: "https://wise.com", venmo: "https://venmo.com", revolut: "https://revolut.com", cashapp: "https://cash.app", paypal: "https://paypal.com", zelle: "https://www.zellepay.com", monzo: "https://monzo.com", n26: "https://n26.com", chime: "https://chime.com", mercadopago: "https://mercadopago.com" };
    const url = urls[row!.paymentPlatform];
    if (url) window.open(url, "_blank");
  }
  function verify() {
    if (!row?.intentHash) { toast.error("Not ready to verify yet."); return; }
    haptic.impact("medium");
    fulfill.mutate({ intentHash: row.intentHash as `0x${string}`, proof: { proofType: "reference", paymentReference: reference, platform: row.paymentPlatform } });
  }

  return (
    <div style={{ minHeight: "100%", background: "#F2F2F7" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 24, color: TEAL, lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 18, fontWeight: 700, color: T1, letterSpacing: "-0.02em" }}>Buy</span>
      </div>

      <div style={{ padding: "4px 16px 40px", maxWidth: 520, margin: "0 auto" }}>
        <div className="glass-card" style={{ padding: 16, marginBottom: 16 }}>
          <Row k="You pay" v={`${row.fiatAmount ?? "—"} ${row.fiatCurrency} ${fiat?.flag ?? ""}`} />
          <Row k="You get" v={row.usdcAmount ? `${Number(row.usdcAmount).toFixed(2)} USDC` : "—"} />
          <Row k="With" v={plat?.displayName ?? row.paymentPlatform} />
        </div>

        <div style={{ display: "flex", marginBottom: 18 }}>
          {STEPS.map((label, i) => {
            const active = si >= i + 1;
            return (
              <div key={label} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ width: 30, height: 30, borderRadius: 15, margin: "0 auto", background: active ? TEAL : "rgba(118,118,128,0.12)", color: active ? "#fff" : T3, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13 }}>{active ? "✓" : i + 1}</div>
                <div style={{ fontSize: 12, marginTop: 5, fontWeight: 600, color: active ? T1 : T3 }}>{label}</div>
              </div>
            );
          })}
        </div>

        {done ? (
          <div className="glass-card-teal" style={{ padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T1, marginBottom: 6 }}>{status === "bridged" ? "Sent — on its way" : "Done! USDC delivered"}</div>
            {row.fulfillTxHash && <a href={`${BASE_EXPLORER}${row.fulfillTxHash}`} target="_blank" rel="noreferrer" style={{ color: TEAL, fontSize: 13, fontWeight: 600 }}>View on Base ↗</a>}
          </div>
        ) : status === "failed" ? (
          <div className="glass-card" style={{ padding: 16, border: "0.5px solid rgba(255,59,48,0.4)" }}>
            <div style={{ fontWeight: 700, color: "#FF3B30", marginBottom: 6 }}>Something went wrong</div>
            <div style={{ fontSize: 13, color: T3 }}>{row.error ?? "Please try again or cancel."}</div>
          </div>
        ) : status === "proving" ? (
          <div className="glass-card" style={{ padding: 18, textAlign: "center" }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>⏳</div>
            <div style={{ fontWeight: 700, color: T1 }}>Checking your payment…</div>
            <div style={{ fontSize: 13, color: T3, marginTop: 4 }}>You can leave — we'll keep working.</div>
          </div>
        ) : status === "paid" ? (
          <div className="glass-card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, color: T1, marginBottom: 8 }}>Confirm your payment</div>
            <div style={{ fontSize: 13, color: T3, marginBottom: 12, lineHeight: 1.5 }}>Paste the reference from your {plat?.displayName ?? "app"} so we can check it.</div>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Payment reference" style={{ width: "100%", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.18)", padding: 12, fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12, background: "rgba(255,255,255,0.6)" }} />
            <button className="btn-primary" onClick={verify} disabled={fulfill.isPending}>{fulfill.isPending ? "Checking…" : "Verify payment"}</button>
          </div>
        ) : (
          <div className="glass-card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, color: T1, marginBottom: 8 }}>Send the cash</div>
            <div style={{ fontSize: 13, color: T3, marginBottom: 12, lineHeight: 1.5 }}>Pay <b style={{ color: T1 }}>{row.fiatAmount} {row.fiatCurrency}</b> with {plat?.displayName ?? "your app"}, then come back.</div>
            <button onClick={openApp} style={{ width: "100%", height: 48, borderRadius: 14, border: "0.5px solid rgba(60,60,67,0.18)", background: "rgba(255,255,255,0.6)", fontSize: 15, fontWeight: 600, color: T1, cursor: "pointer", marginBottom: 10 }}>Open {plat?.displayName ?? "app"} ↗</button>
            <button className="btn-primary" onClick={() => markPaid.mutate({ rowId })} disabled={markPaid.isPending}>{markPaid.isPending ? "…" : "I've sent the cash"}</button>
          </div>
        )}

        {!done && status !== "proving" && (
          <button onClick={() => { if (row.intentHash) cancel.mutate({ intentHash: row.intentHash as `0x${string}` }); else onBack(); }}
            style={{ width: "100%", marginTop: 14, background: "none", border: "none", color: T3, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Cancel order</button>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 15 }}><span style={{ color: T3 }}>{k}</span><span style={{ fontWeight: 600, color: T1 }}>{v}</span></div>;
}
function Center({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200, color: T3, fontSize: 14 }}>{children}</div>;
}
