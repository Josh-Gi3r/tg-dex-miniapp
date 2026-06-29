/**
 * Heat Index Opportunities — replicates the your-venue.example Heat Index signal calculator using the
 * REAL published tier matrix + session windows (extracted to lib/heat-index-config.ts,
 * not fabricated). Pure client-side calc: current sessions from UTC, multiplier
 * math, and concrete "do this for Nx" opportunities. Shown on top of Quests.
 */
import { HEAT_INDEX } from "@/lib/heat-index-config";
import { trpc } from "@/lib/trpc";

const TIER_LABEL: Record<string, string> = { S: "Tier S", A: "Tier A", B: "Tier B", C: "Tier C" };
const TIER_COLOR: Record<string, string> = { S: "#00C896", A: "#4A90D9", B: "#FF9500", C: "#8E8E93" };

function hhmmToMin(s: string): number { const [h, m] = s.split(":").map(Number); return h * 60 + m; }

/** Is `now` (UTC minutes) within [start,end), handling overnight wrap. */
function sessionActive(startUtc: string, endUtc: string, nowMin: number): boolean {
  const s = hhmmToMin(startUtc), e = hhmmToMin(endUtc);
  return s <= e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e;
}

export default function HeatOpportunities() {
  const opps = trpc.dex.opportunities.useQuery(undefined, { staleTime: 60_000, refetchInterval: 60_000, retry: false });
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const matrix = HEAT_INDEX.matrix as Record<string, string>;
  const tierMult = HEAT_INDEX.tierMult as Record<string, number>;

  const sTier = Object.entries(matrix).filter(([, t]) => t === "S").map(([p]) => p);
  const aTier = Object.entries(matrix).filter(([, t]) => t === "A").map(([p]) => p);

  const active = HEAT_INDEX.sessions.filter((s) => sessionActive(s.start_utc, s.end_utc, nowMin));
  const maxCompound = tierMult.S * HEAT_INDEX.volumePeak * HEAT_INDEX.streakMax * HEAT_INDEX.powerHour;

  // Best Tier-S pair touching a currency in any active session.
  const activeCcys = new Set(active.flatMap((s) => s.currencies as string[]));
  const liveSPair = sTier.find((p) => p.split("/").some((c) => activeCcys.has(c)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Live the venue edges — real deals + depegs from the order book vs FX mid */}
      {(() => {
        const live = (opps.data?.opportunities ?? []).filter((o: any) => o.deal || o.depeg).slice(0, 6);
        if (live.length === 0) return null;
        return (
          <div style={{ background: "#fff", borderRadius: 16, border: "0.5px solid rgba(60,60,67,0.12)", padding: "14px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#1C1C1E", marginBottom: 8 }}>Live the venue edges</div>
            {live.map((o: any) => (
              <div key={`${o.from}-${o.to}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "0.5px solid rgba(60,60,67,0.08)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E" }}>
                    {o.from} → {o.to}{" "}
                    {o.depeg && <span style={{ color: "#FF9500", fontSize: 10, fontWeight: 800 }}>DEPEG</span>}
                    {o.deal && <span style={{ color: "#00C896", fontSize: 10, fontWeight: 800 }}>DEAL</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "#8E8E93" }}>{o.note}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: (o.edgeBps ?? 0) >= 0 ? "#00A07A" : "#C0392B" }}>
                  {(o.edgeBps ?? 0) >= 0 ? "+" : ""}{o.edgeBps} bps
                </div>
              </div>
            ))}
            <div style={{ fontSize: 10, color: "#AEAEB2", marginTop: 6 }}>the venue's live rate vs the real-world FX mid. Updates every minute.</div>
          </div>
        );
      })()}

      {/* Max compound hero */}
      <div style={{ background: "linear-gradient(135deg,#00C896,#00A87A)", borderRadius: 16, padding: "16px 18px", color: "#fff" }}>
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.9 }}>Max compound multiplier</div>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>{maxCompound.toFixed(2)}×</div>
        <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2 }}>
          Tier S {tierMult.S}× · Volume {HEAT_INDEX.volumePeak}× · Streak {HEAT_INDEX.streakMax}× (wk {HEAT_INDEX.streakMaxWeeks}) · Power Hour {HEAT_INDEX.powerHour}×
        </div>
      </div>

      {/* Live Power Hours */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#1C1C1E", marginBottom: 8 }}>
          Power Hour {active.length > 0 ? `· ${active.length} LIVE` : "· none live"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {HEAT_INDEX.sessions.map((s) => {
            const live = active.some((a) => a.id === s.id);
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 12, background: live ? "rgba(0,200,150,0.08)" : "rgba(118,118,128,0.06)", border: `0.5px solid ${live ? "rgba(0,200,150,0.3)" : "rgba(60,60,67,0.1)"}` }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E" }}>{s.name} {live && <span style={{ color: "#00C896", fontSize: 10 }}>● LIVE +{Math.round((HEAT_INDEX.powerHour - 1) * 100)}%</span>}</div>
                  <div style={{ fontSize: 11, color: "#8E8E93" }}>{s.start_utc}–{s.end_utc} UTC · {(s.currencies as string[]).join(", ")}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top opportunity */}
      {liveSPair && (
        <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(0,200,150,0.06)", border: "0.5px solid rgba(0,200,150,0.25)" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#00A07A" }}>OPPORTUNITY · ACTIVE NOW</div>
          <div style={{ fontSize: 13, color: "#1C1C1E", marginTop: 3 }}>
            Trade <b>{liveSPair}</b> (Tier S, {tierMult.S}×) during the live session for up to {(tierMult.S * HEAT_INDEX.powerHour).toFixed(1)}× before volume/streak.
          </div>
        </div>
      )}

      {/* Tier matrix summary */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#1C1C1E", marginBottom: 8 }}>Heat Index · {Object.keys(matrix).length} pairs</div>
        {(["S", "A"] as const).map((tier) => {
          const pairs = tier === "S" ? sTier : aTier;
          return (
            <div key={tier} style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: TIER_COLOR[tier] }}>{TIER_LABEL[tier]} · {tierMult[tier]}× · {pairs.length} pairs</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
                {pairs.slice(0, 10).map((p) => (
                  <span key={p} style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 8, background: "rgba(118,118,128,0.08)", color: "#3C3C43" }}>{p}</span>
                ))}
              </div>
            </div>
          );
        })}
        <div style={{ fontSize: 10, color: "#AEAEB2", marginTop: 4 }}>Heat Index republishes monthly at your-app.example/heat.</div>
      </div>
    </div>
  );
}
