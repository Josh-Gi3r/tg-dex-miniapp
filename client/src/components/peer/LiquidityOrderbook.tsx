/**
 * LiquidityOrderbook — the live book of makers (Phase 1 of the cash platform).
 * App DS: iOS-18 light glass, teal #00C896, hairline borders, SF Pro. NOT the
 * old brutalist style. Reads the real production book via peer.orderbook.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { PEER_FIAT_CURRENCIES, peerPlatform, peerFiat } from "@shared/peer-config";

const TEAL = "#00C896";
const GREEN = "#30D158"; // below-market (cheaper to buy)
const RED = "#FF3B30"; // above-market
const T1 = "#1C1C1E";
const T3 = "#8E8E93";
const HAIR = "rgba(60,60,67,0.12)";

export interface PickedLevel {
  depositId: string;
  depositIdOnContract: string;
  payeeDetails: string;
  platform: string;
  price: string;
  maxOrder: string;
  usdcAvailable: string;
  fiat: string;
}

interface Props {
  /** Called when a maker/price level is tapped (to start a buy). */
  onPick?: (level: PickedLevel) => void;
}

export default function LiquidityOrderbook({ onPick }: Props) {
  const { haptic } = useTelegram();
  const [fiat, setFiat] = useState("USD");
  const [fiatOpen, setFiatOpen] = useState(false);

  const ob = trpc.peer.orderbook.useQuery(
    { fiatCurrency: fiat, limit: 60 },
    { staleTime: 15_000, refetchInterval: 30_000, retry: false },
  );

  const levels = ob.data?.levels ?? [];
  const market = ob.data?.market ?? 1;
  const fiatMeta = peerFiat(fiat);

  return (
    <div>
      {/* Filter row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: T1, letterSpacing: "-0.02em", flex: 1 }}>
          Live rates
        </div>
        <button
          onClick={() => { haptic.impact("light"); setFiatOpen((v) => !v); }}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "8px 14px",
            background: "var(--surface-input, rgba(118,118,128,0.12))", border: "none",
            borderRadius: 20, cursor: "pointer", fontSize: 15, fontWeight: 600, color: T1,
          }}
        >
          <span style={{ fontSize: 18 }}>{fiatMeta?.flag}</span> {fiat} ▾
        </button>
      </div>

      {fiatOpen && (
        <div className="glass-card" style={{ marginBottom: 12, padding: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {PEER_FIAT_CURRENCIES.map((c) => (
            <button
              key={c.code}
              onClick={() => { haptic.impact("light"); setFiat(c.code); setFiatOpen(false); }}
              style={{
                padding: "8px 12px", borderRadius: 12, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
                background: c.code === fiat ? "var(--teal-dim, rgba(0,200,150,0.12))" : "transparent",
                color: c.code === fiat ? TEAL : T1,
              }}
            >
              {c.flag} {c.code}
            </button>
          ))}
        </div>
      )}

      {/* Book */}
      <div className="glass-card" style={{ padding: 0 }}>
        {/* Header */}
        <div style={{ display: "flex", padding: "12px 16px", borderBottom: `0.5px solid ${HAIR}`, fontSize: 12, fontWeight: 600, color: T3, letterSpacing: "0.02em" }}>
          <div style={{ flex: 1 }}>RATE</div>
          <div style={{ width: 72, textAlign: "right" }}>SPREAD</div>
          <div style={{ flex: 1, textAlign: "right" }}>AVAILABLE</div>
          <div style={{ width: 88, textAlign: "right" }}>APP</div>
        </div>

        {ob.isLoading && (
          <div style={{ padding: "28px 16px", textAlign: "center", color: T3, fontSize: 14 }}>Loading the book…</div>
        )}
        {!ob.isLoading && levels.length === 0 && (
          <div style={{ padding: "28px 16px", textAlign: "center", color: T3, fontSize: 14 }}>
            No live offers for {fiat} right now.
          </div>
        )}

        {levels.map((l, i) => {
          const below = Number(l.price) < market;
          const plat = peerPlatform(l.platform);
          // market separator
          const prev = levels[i - 1];
          const showMarket = prev && Number(prev.price) < market && Number(l.price) >= market;
          return (
            <div key={`${l.depositId}-${i}`}>
              {showMarket && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 16px", background: "rgba(0,0,0,0.02)" }}>
                  <div style={{ flex: 1, height: 1, background: HAIR }} />
                  <div style={{ fontSize: 11, fontWeight: 700, color: T3 }}>MARKET {market.toFixed(2)} {fiat}</div>
                  <div style={{ flex: 1, height: 1, background: HAIR }} />
                </div>
              )}
              <button
                onClick={() => { haptic.impact("light"); onPick?.({ depositId: l.depositId, depositIdOnContract: l.depositIdOnContract, payeeDetails: l.payeeDetails, platform: l.platform, price: l.price, maxOrder: l.maxOrder, usdcAvailable: l.usdcAvailable, fiat }); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", padding: "12px 16px",
                  background: "transparent", border: "none", borderBottom: i < levels.length - 1 ? `0.5px solid ${HAIR}` : "none",
                  cursor: "pointer", textAlign: "left",
                }}
              >
                <div style={{ flex: 1, fontSize: 16, fontWeight: 600, color: T1, fontVariantNumeric: "tabular-nums" }}>
                  {Number(l.price).toFixed(4)}
                </div>
                <div style={{ width: 72, textAlign: "right", fontSize: 13, fontWeight: 600, color: below ? GREEN : RED, fontVariantNumeric: "tabular-nums" }}>
                  {l.spreadPct >= 0 ? "+" : ""}{l.spreadPct.toFixed(2)}%
                </div>
                <div style={{ flex: 1, textAlign: "right", fontSize: 15, color: T1, fontVariantNumeric: "tabular-nums" }}>
                  {Number(l.usdcAvailable).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
                <div style={{ width: 88, textAlign: "right", fontSize: 13, fontWeight: 600, color: T3 }}>
                  {plat?.displayName ?? l.platform}
                </div>
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: T3, marginTop: 10, textAlign: "center", lineHeight: 1.4 }}>
        {levels.length} live offers · prices are {fiat} per USDC · tap one to buy
      </div>
    </div>
  );
}
