/**
 * ProvideLiquiditySheet — the offramp/LP side (Peer createDeposit). Lock USDC,
 * list the cash app(s) you'll get paid in, set your rate. App DS glass.
 * Final "Make offer live" is the money click — gated.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { toast } from "sonner";
import FiatCurrencyPickerSheet from "./FiatCurrencyPickerSheet";
import PaymentPlatformPickerSheet from "./PaymentPlatformPickerSheet";
import { peerFiat, peerPlatform } from "@shared/peer-config";

interface Leg { platform: string; fiatCurrency: string; conversionRate: string; offchainId: string; }
interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  moneyEnabled: boolean;
  onBlocked: () => void;
}

const T1 = "#1C1C1E";
const T3 = "#8E8E93";

export default function ProvideLiquiditySheet({ open, onClose, onCreated, moneyEnabled, onBlocked }: Props) {
  const { haptic } = useTelegram();
  const [amount, setAmount] = useState("1000");
  const [min, setMin] = useState("20");
  const [max, setMax] = useState("500");
  const [legs, setLegs] = useState<Leg[]>([{ platform: "wise", fiatCurrency: "USD", conversionRate: "1.00", offchainId: "" }]);
  const [picker, setPicker] = useState<{ idx: number; kind: "fiat" | "platform" } | null>(null);

  const create = trpc.peer.createDeposit.useMutation({
    onSuccess: () => { haptic.notification("success"); toast.success("Your cash-out offer is live."); onCreated(); },
    onError: (e) => toast.error(e.message || "Could not create the offer."),
  });

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  const setLeg = (idx: number, patch: Partial<Leg>) => setLegs((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  function submit() {
    if (!Number(amount)) { toast.error("Enter how much USDC to offer."); return; }
    if (legs.some((l) => !l.offchainId.trim())) { toast.error("Add your payment ID for each app."); return; }
    haptic.impact("medium");
    if (!moneyEnabled) { onBlocked(); return; }
    create.mutate({ amount, minIntent: min, maxIntent: max, legs });
  }

  return (
    <div className="bottom-sheet-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="bottom-sheet-handle" />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 20px 14px", borderBottom: "0.5px solid rgba(60,60,67,0.12)" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: T1, margin: 0, letterSpacing: "-0.02em" }}>Offer USDC for cash</h2>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(118,118,128,0.12)", border: "none", cursor: "pointer", fontSize: 15, color: T3 }}>✕</button>
        </div>

        <div style={{ overflowY: "auto", flex: 1, padding: "16px 20px 24px" }}>
          <Field label="How much USDC to offer"><Input value={amount} onChange={setAmount} suffix="USDC" /></Field>
          <div style={{ display: "flex", gap: 10 }}>
            <Field label="Smallest order"><Input value={min} onChange={setMin} suffix="USDC" /></Field>
            <Field label="Biggest order"><Input value={max} onChange={setMax} suffix="USDC" /></Field>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: T3, margin: "12px 0 8px" }}>How you'll get paid</div>
          {legs.map((leg, idx) => (
            <div key={idx} className="glass-card" style={{ padding: 14, marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <PickBtn onClick={() => setPicker({ idx, kind: "platform" })}>{peerPlatform(leg.platform)?.displayName ?? "App"} ▾</PickBtn>
                <PickBtn onClick={() => setPicker({ idx, kind: "fiat" })}>{peerFiat(leg.fiatCurrency)?.flag} {leg.fiatCurrency} ▾</PickBtn>
              </div>
              <Field label={`Your rate (USDC per 1 ${leg.fiatCurrency})`}><Input value={leg.conversionRate} onChange={(v) => setLeg(idx, { conversionRate: v })} /></Field>
              <Field label={`Your ${peerPlatform(leg.platform)?.displayName ?? "app"} ID`}>
                <input value={leg.offchainId} onChange={(e) => setLeg(idx, { offchainId: e.target.value })} placeholder={peerPlatform(leg.platform)?.offchainIdHint ?? "your payment ID"}
                  style={inputStyle} />
              </Field>
              {legs.length > 1 && <button onClick={() => setLegs((ls) => ls.filter((_, i) => i !== idx))} style={{ marginTop: 4, background: "none", border: "none", color: "#FF3B30", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>Remove</button>}
            </div>
          ))}
          <button onClick={() => setLegs((ls) => [...ls, { platform: "revolut", fiatCurrency: legs[0]?.fiatCurrency ?? "USD", conversionRate: "1.00", offchainId: "" }])}
            style={{ width: "100%", padding: "11px 0", borderRadius: 12, border: "0.5px dashed rgba(60,60,67,0.3)", background: "transparent", fontSize: 14, fontWeight: 600, color: T1, cursor: "pointer", marginBottom: 16 }}>
            + Add another app
          </button>

          <button className="btn-primary" onClick={submit} disabled={create.isPending}>{create.isPending ? "Creating…" : "Make offer live"}</button>
          <div style={{ fontSize: 12, color: T3, marginTop: 10, lineHeight: 1.5 }}>
            Your USDC stays safe. When someone buys, they pay you cash in your app, then your USDC is sent to them.
          </div>
        </div>
      </div>

      {picker?.kind === "fiat" && <FiatCurrencyPickerSheet open onClose={() => setPicker(null)} selected={legs[picker.idx]?.fiatCurrency ?? "USD"} onSelect={(c) => { setLeg(picker.idx, { fiatCurrency: c }); setPicker(null); }} />}
      {picker?.kind === "platform" && <PaymentPlatformPickerSheet open onClose={() => setPicker(null)} selected={legs[picker.idx]?.platform ?? ""} forCurrency={legs[picker.idx]?.fiatCurrency} onSelect={(k) => { setLeg(picker.idx, { platform: k }); setPicker(null); }} />}
    </div>
  );
}

const inputStyle: React.CSSProperties = { width: "100%", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.18)", padding: "11px 12px", fontSize: 15, outline: "none", background: "rgba(255,255,255,0.6)", boxSizing: "border-box", color: "#1C1C1E" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ flex: 1, marginBottom: 10 }}><div style={{ fontSize: 12, fontWeight: 600, color: T3, marginBottom: 5 }}>{label}</div>{children}</div>;
}
function Input({ value, onChange, suffix }: { value: string; onChange: (v: string) => void; suffix?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.18)", background: "rgba(255,255,255,0.6)" }}>
      <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" style={{ flex: 1, border: "none", padding: "11px 12px", fontSize: 16, fontWeight: 600, outline: "none", background: "transparent", minWidth: 0, color: "#1C1C1E" }} />
      {suffix && <span style={{ padding: "0 12px", color: T3, fontSize: 13, fontWeight: 600 }}>{suffix}</span>}
    </div>
  );
}
function PickBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} style={{ flex: 1, padding: "10px 12px", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.18)", background: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "#1C1C1E", textAlign: "left" }}>{children}</button>;
}
