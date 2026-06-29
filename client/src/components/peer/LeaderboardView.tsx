/**
 * LeaderboardView — top liquidity providers, aggregated from the live book.
 * App DS glass.
 */
import { trpc } from "@/lib/trpc";
import { peerPlatform } from "@shared/peer-config";

const T1 = "#1C1C1E";
const T3 = "#8E8E93";
const GOLD = "#D4A017";
const TEAL = "#00C896";

export default function LeaderboardView() {
  const lb = trpc.peer.leaderboard.useQuery({ limit: 30 }, { staleTime: 60_000, retry: false });

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: T1, letterSpacing: "-0.02em", marginBottom: 4 }}>Top providers</div>
      <div style={{ fontSize: 14, color: T3, marginBottom: 16, lineHeight: 1.4 }}>
        The makers with the most cash liquidity live right now.
      </div>

      {lb.isLoading && <div className="glass-card" style={{ padding: 24, textAlign: "center", color: T3 }}>Loading…</div>}
      {!lb.isLoading && (lb.data ?? []).length === 0 && (
        <div className="glass-card" style={{ padding: 24, textAlign: "center", color: T3 }}>No providers right now.</div>
      )}

      {(lb.data ?? []).length > 0 && (
        <div className="glass-card" style={{ padding: 0 }}>
          {(lb.data ?? []).map((m, i) => (
            <div key={m.depositor} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: i < (lb.data!.length - 1) ? "0.5px solid rgba(60,60,67,0.12)" : "none" }}>
              <div style={{ width: 26, textAlign: "center", fontSize: 15, fontWeight: 700, color: i === 0 ? GOLD : T3 }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: T1, fontVariantNumeric: "tabular-nums" }}>
                  {m.depositor.slice(0, 6)}…{m.depositor.slice(-4)}
                </div>
                <div style={{ fontSize: 12, color: T3, marginTop: 2 }}>
                  {m.deposits} offers · {m.platforms.slice(0, 3).map((p) => peerPlatform(p)?.displayName ?? p).join(", ")}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: T1, fontVariantNumeric: "tabular-nums" }}>${m.totalUsdc.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                <div style={{ fontSize: 12, color: TEAL, marginTop: 2 }}>{m.avgSuccessPct.toFixed(0)}% success</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
