/**
 * VaultsView — delegate rate-management. Browse vaults by volume/fee, delegate
 * your deposits' pricing (non-custodial). App DS glass. Delegate is money-gated.
 */
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";

const TEAL = "#00C896";
const T1 = "#1C1C1E";
const T3 = "#8E8E93";

export default function VaultsView({ moneyEnabled, onBlocked }: { moneyEnabled: boolean; onBlocked: () => void }) {
  const { haptic } = useTelegram();
  const vaults = trpc.peer.vaults.useQuery({ limit: 30 }, { staleTime: 60_000, retry: false });

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: T1, letterSpacing: "-0.02em", marginBottom: 4 }}>Vaults</div>
      <div style={{ fontSize: 14, color: T3, marginBottom: 16, lineHeight: 1.4 }}>
        Let a pro manage your sell rates and earn — your USDC never leaves your wallet.
      </div>

      {vaults.isLoading && <div className="glass-card" style={{ padding: 24, textAlign: "center", color: T3 }}>Loading vaults…</div>}
      {!vaults.isLoading && (vaults.data ?? []).length === 0 && (
        <div className="glass-card" style={{ padding: 24, textAlign: "center", color: T3 }}>No vaults available.</div>
      )}

      {(vaults.data ?? []).map((v) => (
        <div key={v.rateManagerId} className="glass-card" style={{ padding: 16, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: T1 }}>{v.name}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: T3 }}>{v.feePct.toFixed(2)}% fee</span>
          </div>
          <div style={{ display: "flex", gap: 18, marginBottom: 14 }}>
            <Stat label="Volume" value={`$${fmt(v.volume)}`} />
            <Stat label="Delegated" value={`$${fmt(v.delegated)}`} />
            <Stat label="Fills" value={`${v.fulfilledIntents}`} />
          </div>
          <button
            className="btn-primary"
            style={{ height: 44, fontSize: 15 }}
            onClick={() => { haptic.impact("medium"); if (!moneyEnabled) onBlocked(); }}
          >
            Delegate to this vault
          </button>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: T3, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: T1, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}
