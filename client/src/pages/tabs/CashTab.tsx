/**
 * Cash Tab — buy/sell crypto for cash against the live Peer orderbook.
 * App DS: iOS-18 light glass, teal #00C896, hairline borders, SF Pro.
 * Money actions gated behind the popup until FEATURE_PEER is on.
 * (Phase 1: orderbook-driven buy + sell entry. Deposits/Vaults/Leaderboard next.)
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { toast } from "sonner";
import LiquidityOrderbook, { type PickedLevel } from "@/components/peer/LiquidityOrderbook";
import ProvideLiquiditySheet from "@/components/peer/ProvideLiquiditySheet";
import RealMoneyNotice from "@/components/peer/RealMoneyNotice";
import VaultsView from "@/components/peer/VaultsView";
import LeaderboardView from "@/components/peer/LeaderboardView";
import { peerPlatform } from "@shared/peer-config";

type Section = "buy" | "sell" | "vaults" | "top";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
  { id: "vaults", label: "Vaults" },
  { id: "top", label: "Top" },
];
const TEAL = "#00C896";
const T1 = "#1C1C1E";
const T3 = "#8E8E93";

interface Props {
  onOrderCreated: (rowId: number) => void;
}

export default function CashTab({ onOrderCreated }: Props) {
  const { haptic } = useTelegram();
  const utils = trpc.useUtils();
  const cfg = trpc.peer.config.useQuery(undefined, { staleTime: 60_000 });
  const moneyEnabled = cfg.data?.moneyEnabled ?? false;

  const [section, setSection] = useState<Section>("buy");
  const [gateOpen, setGateOpen] = useState(false);
  function requireMoney(): boolean {
    if (!moneyEnabled) { haptic.notification("warning"); setGateOpen(true); return false; }
    return true;
  }

  // Buy
  const [picked, setPicked] = useState<PickedLevel | null>(null);
  const [spend, setSpend] = useState("100");
  // Sell
  const [provideOpen, setProvideOpen] = useState(false);
  const myDeposits = trpc.peer.myDeposits.useQuery(undefined, { enabled: section === "sell" });

  const signalMut = trpc.peer.signalIntent.useMutation({
    onSuccess: (res) => { haptic.notification("success"); utils.peer.myIntents.invalidate(); setPicked(null); onOrderCreated(res.rowId); },
    onError: (e) => toast.error(e.message || "Could not start the order."),
  });
  const setAccepting = trpc.peer.setAcceptingIntents.useMutation({
    onSuccess: () => utils.peer.myDeposits.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const youReceive = picked && Number(picked.price) > 0 ? (Number(spend) / Number(picked.price)) : 0;

  function confirmBuy() {
    if (!picked) return;
    if (!Number(spend)) { toast.error("Enter how much cash."); return; }
    if (!requireMoney()) { setPicked(null); return; }
    signalMut.mutate({
      side: "onramp",
      depositId: picked.depositIdOnContract || picked.depositId,
      processorName: picked.platform,
      payeeDetails: picked.payeeDetails,
      fiatCurrency: picked.fiat,
      usdcAmount: youReceive.toFixed(6),
      fiatAmount: spend,
      conversionRate: picked.price,
    });
  }

  return (
    <div style={{ padding: "12px 16px 40px", maxWidth: 520, margin: "0 auto" }}>
      {/* iOS segmented hub nav */}
      <div style={{ display: "flex", background: "rgba(118,118,128,0.12)", borderRadius: 12, padding: 3, marginBottom: 16 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => { haptic.impact("light"); setSection(s.id); setPicked(null); }}
            style={{
              flex: 1, padding: "9px 0", borderRadius: 9, border: "none", cursor: "pointer",
              fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em",
              background: section === s.id ? "#FFFFFF" : "transparent",
              color: section === s.id ? T1 : T3,
              boxShadow: section === s.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              transition: "all .15s ease",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {!moneyEnabled && (
        <div className="glass-card-teal" style={{ padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#1C6B52", lineHeight: 1.45 }}>
          Browse the live market now. Buying and selling switches on soon.
        </div>
      )}

      {section === "buy" && (
        <>
          <LiquidityOrderbook onPick={(lvl) => { haptic.impact("light"); setPicked(lvl); setSpend("100"); }} />

          {picked && (
            <div className="glass-card-elevated" style={{ position: "fixed", left: 16, right: 16, bottom: "calc(var(--nav-height, 64px) + 12px)", maxWidth: 520, margin: "0 auto", padding: 18, zIndex: 100 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: T1, letterSpacing: "-0.02em" }}>Buy</div>
                <button onClick={() => setPicked(null)} style={{ background: "none", border: "none", color: T3, fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
              <div className="input-panel" style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                <input
                  value={spend} onChange={(e) => setSpend(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal"
                  style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 26, fontWeight: 700, color: T1 }}
                />
                <span style={{ fontSize: 16, fontWeight: 600, color: T3 }}>{picked.fiat}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: T3, marginBottom: 4 }}>
                <span>You receive</span>
                <span style={{ color: T1, fontWeight: 600 }}>{youReceive.toFixed(2)} USDC</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: T3, marginBottom: 14 }}>
                <span>Pay with</span>
                <span style={{ color: T1, fontWeight: 600 }}>{peerPlatform(picked.platform)?.displayName ?? picked.platform} · rate {Number(picked.price).toFixed(4)}</span>
              </div>
              <button className="btn-primary" onClick={confirmBuy} disabled={signalMut.isPending}>
                {signalMut.isPending ? "Starting…" : `Buy ${youReceive.toFixed(2)} USDC`}
              </button>
            </div>
          )}
        </>
      )}

      {section === "vaults" && <VaultsView moneyEnabled={moneyEnabled} onBlocked={() => setGateOpen(true)} />}
      {section === "top" && <LeaderboardView />}

      {section === "sell" && (
        <>
          <div className="glass-card" style={{ padding: 18, marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: T1, letterSpacing: "-0.02em", marginBottom: 6 }}>Turn your USDC into cash</div>
            <div style={{ fontSize: 14, color: T3, lineHeight: 1.5, marginBottom: 16 }}>
              Offer your USDC at your own rate. People buy it and pay you cash in your app. Your USDC stays safe until they pay.
            </div>
            <button className="btn-primary" onClick={() => { haptic.impact("medium"); setProvideOpen(true); }}>
              Offer USDC for cash
            </button>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: T3, margin: "4px 4px 8px" }}>Your offers</div>
          {(myDeposits.data ?? []).length === 0 && (
            <div className="glass-card" style={{ padding: "22px 16px", textAlign: "center", color: T3, fontSize: 14 }}>You have no offers yet.</div>
          )}
          {(myDeposits.data ?? []).map((d) => {
            const legs = safeLegs(d.paymentConfig);
            return (
              <div key={d.id} className="glass-card" style={{ padding: "14px 16px", marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: T1 }}>{Number(d.amount).toFixed(2)} USDC</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: d.status === "active" ? TEAL : T3 }}>{d.status}</span>
                </div>
                <div style={{ fontSize: 13, color: T3, marginTop: 4 }}>
                  {legs.map((l) => `${peerPlatform(l.platform)?.displayName ?? l.platform} ${l.fiatCurrency}`).join("  ·  ") || "—"}
                </div>
                <button
                  onClick={() => { haptic.impact("light"); if (!requireMoney()) return; setAccepting.mutate({ rowId: d.id, accepting: !d.acceptingIntents }); }}
                  style={{ marginTop: 10, padding: "7px 16px", borderRadius: 10, border: "none", background: "rgba(118,118,128,0.12)", fontSize: 13, fontWeight: 600, color: T1, cursor: "pointer" }}
                >
                  {d.acceptingIntents ? "Pause offer" : "Resume offer"}
                </button>
              </div>
            );
          })}
        </>
      )}

      <ProvideLiquiditySheet
        open={provideOpen}
        onClose={() => setProvideOpen(false)}
        onCreated={() => { setProvideOpen(false); utils.peer.myDeposits.invalidate(); }}
        moneyEnabled={moneyEnabled}
        onBlocked={() => setGateOpen(true)}
      />
      <RealMoneyNotice open={gateOpen} onAck={() => setGateOpen(false)} />
    </div>
  );
}

function safeLegs(json: string | null): Array<{ platform: string; fiatCurrency: string }> {
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}
