/**
 * Earn — pooled yield-bot deposit UI.
 *
 * Mounted as a sub-section inside MeTab (Profile / Wallet / Shop / History
 * / Earn). Three states:
 *   1. Bot not configured (no YIELD_BOT_PRIVATE_KEY) — read-only "coming
 *      soon" copy with NAV chart, deposit blocked.
 *   2. Bot configured + user has no position — deposit form with risk
 *      disclosures + caps.
 *   3. User has a position — show value, PnL, NAV chart, withdraw +
 *      pause toggles.
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function fmtUsdc(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtBps(bps: number): { label: string; color: string } {
  const sign = bps > 0 ? "+" : "";
  const color = bps > 0 ? "#00C896" : bps < 0 ? "#E55050" : "#8E8E93";
  return { label: `${sign}${bps.toFixed(2)} bps`, color };
}

export function EarnSection() {
  const stats = trpc.yield.stats.useQuery(undefined, { refetchInterval: 30_000 });
  const me = trpc.yield.me.useQuery(undefined, { refetchInterval: 30_000 });
  const cycles = trpc.yield.cycles.useQuery(
    { limit: 30 },
    { refetchInterval: 60_000 },
  );
  const utils = trpc.useUtils();

  const [amount, setAmount] = useState("");
  const [showDisclosure, setShowDisclosure] = useState(false);

  const depositMut = trpc.yield.deposit.useMutation({
    onSuccess: () => {
      toast.success("Deposit recorded — you'll earn from the next cycle.");
      setAmount("");
      utils.yield.me.invalidate();
      utils.yield.stats.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const withdrawMut = trpc.yield.withdraw.useMutation({
    onSuccess: () => {
      toast.success("Withdraw queued — paid out next cycle.");
      utils.yield.me.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pauseMut = trpc.yield.pause.useMutation({
    onSuccess: () => {
      utils.yield.me.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const summary = me.data?.summary;
  const positions = me.data?.positions ?? [];
  const isConfigured = stats.data?.configured ?? false;
  const isKilled = stats.data?.killed ?? false;
  const lastPnl = stats.data?.lastCyclePnlBps ?? 0;
  const pnlChip = fmtBps(lastPnl);

  const handleDeposit = () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a valid USDC amount");
      return;
    }
    // The real vault deposit from the imported wallet isn't wired yet. Do NOT
    // credit pool shares for a zero-address/no-op deposit — be honest instead.
    void depositMut;
    toast.info("Earn deposits aren't available on testnet yet — coming soon.");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Sepolia preview banner */}
      <div style={{
        padding: "12px 14px",
        background: "rgba(0,122,255,0.06)",
        borderRadius: 12,
        border: "0.5px solid rgba(0,122,255,0.20)",
        fontSize: 12,
        color: "#1C1C1E",
        lineHeight: 1.55,
      }}>
        <div style={{ fontWeight: 700, color: "#007AFF", marginBottom: 4 }}>
          Sepolia Testnet preview
        </div>
        <div style={{ color: "#3C3C43" }}>
          Earn is a pooled market-making strategy that runs on the venue's matching engine across stablecoin FX pairs. Deposits and yield go live the moment we cut over to mainnet.
        </div>
      </div>

      {/* How it works — mirrors the the venue Create Position page */}
      <div style={{
        background: "#FFFFFF",
        borderRadius: 14,
        padding: 16,
        boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#007AFF", letterSpacing: "0.02em", marginBottom: 10 }}>
          HOW IT WORKS
        </div>
        {[
          "Deposit USDC into the pooled vault. Your share of the pool tracks your contribution.",
          "The bot allocates capital across stablecoin FX pairs (EUR, SGD, MYR, IDR…) using the venue limit orders and Virtual Liquidity batches.",
          "NAV updates every cycle. Withdraw any time — settlement lands on the next cycle at the cycle's NAV.",
        ].map((step, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 8 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 11, flexShrink: 0,
              background: "rgba(0,122,255,0.10)",
              color: "#007AFF", fontWeight: 700, fontSize: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{i + 1}</div>
            <div style={{ fontSize: 13, color: "#1C1C1E", lineHeight: 1.55 }}>{step}</div>
          </div>
        ))}
      </div>

      {/* Market Making Order — the venue-style info card */}
      <div style={{
        background: "rgba(0,122,255,0.05)",
        borderRadius: 14,
        padding: 16,
        border: "0.5px solid rgba(0,122,255,0.25)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>ⓘ</span>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#003F88" }}>Market Making Order</div>
        </div>
        <div style={{ fontSize: 12, color: "#1C1C1E", lineHeight: 1.6 }}>
          When the bot posts an order, your share of the pool is pledged for settlement. Cancellation lands on the next cycle. Orders can sit on the book for up to 24 hours before being matched by swappers, arbitrageurs and FX brokers using the venue.
        </div>
      </div>

      {/* What's in Liquidity */}
      <div style={{
        background: "rgba(255,149,0,0.05)",
        borderRadius: 14,
        padding: 16,
        border: "0.5px solid rgba(255,149,0,0.30)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>🛡</span>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#A85A00" }}>What's in Liquidity?</div>
        </div>
        <div style={{ fontSize: 12, color: "#1C1C1E", lineHeight: 1.6 }}>
          Your funds remain under your control via the venue's non-custodial vault. You can pause or withdraw at any time before an order matches, minus network gas. Matching and settlement are fully decentralised.
        </div>
      </div>

      {/* Virtual Liquidity */}
      <div style={{
        background: "rgba(125,75,200,0.05)",
        borderRadius: 14,
        padding: 16,
        border: "0.5px solid rgba(125,75,200,0.30)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>📣</span>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#5B2EAA" }}>Virtual Liquidity</div>
        </div>
        <div style={{ fontSize: 12, color: "#1C1C1E", lineHeight: 1.6 }}>
          The bot uses the venue's Virtual Liquidity batches — a single USDC pool quotes against multiple FX pairs simultaneously. When one leg fills, sibling legs auto-resize. This is the same capital working harder, exactly how professional market makers run their books.
        </div>
      </div>

      {/* Hero — TVL + last-cycle PnL */}
      <div
        style={{
          background: "#FFFFFF",
          borderRadius: 14,
          padding: 16,
          boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 11, color: "#8E8E93", marginBottom: 2 }}>POOL TVL</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#1C1C1E", letterSpacing: "-0.02em" }}>
              ${fmtUsdc(stats.data?.tvlUsdc ?? 0)}
            </div>
            <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 4 }}>
              NAV/share {(stats.data?.navPerShare ?? 1).toFixed(6)}
            </div>
          </div>
          <div
            style={{
              background: pnlChip.color === "#8E8E93" ? "rgba(0,0,0,0.04)" : `${pnlChip.color}1A`,
              color: pnlChip.color,
              fontSize: 12,
              fontWeight: 700,
              padding: "5px 10px",
              borderRadius: 20,
            }}
          >
            {pnlChip.label} last cycle
          </div>
        </div>
        {!isConfigured && (
          <div
            style={{
              marginTop: 10,
              fontSize: 11,
              color: "#8E8E93",
              padding: "6px 10px",
              background: "rgba(60,60,67,0.06)",
              borderRadius: 8,
            }}
          >
            Bot not configured yet. Deposits open once the wallet is provisioned.
          </div>
        )}
        {isKilled && (
          <div
            style={{
              marginTop: 10,
              fontSize: 11,
              color: "#E55050",
              padding: "6px 10px",
              background: "rgba(229,80,80,0.10)",
              borderRadius: 8,
            }}
          >
            Bot is paused — deposits and new orders disabled. Withdrawals still work.
          </div>
        )}
      </div>

      {/* My position */}
      {summary && summary.totalDepositedUsdc > 0 ? (
        <div
          style={{
            background: "#FFFFFF",
            borderRadius: 14,
            padding: 16,
            boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 11, color: "#8E8E93", marginBottom: 6 }}>YOUR POSITION</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#1C1C1E" }}>
                ${fmtUsdc(summary.currentValueUsdc)}
              </div>
              <div style={{ fontSize: 11, color: "#8E8E93" }}>
                Deposited ${fmtUsdc(summary.totalDepositedUsdc)}
              </div>
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: summary.pnlUsdc >= 0 ? "#00C896" : "#E55050",
              }}
            >
              {summary.pnlUsdc >= 0 ? "+" : ""}${fmtUsdc(summary.pnlUsdc)}{" "}
              ({summary.pnlBps >= 0 ? "+" : ""}{summary.pnlBps.toFixed(1)} bps)
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {positions
              .filter((p) => p.status !== "withdrawn")
              .map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 10px",
                    background: "rgba(60,60,67,0.04)",
                    borderRadius: 10,
                  }}
                >
                  <div style={{ fontSize: 12 }}>
                    <div style={{ fontWeight: 600, color: "#1C1C1E" }}>
                      ${fmtUsdc(Number(p.depositedAmount))}
                    </div>
                    <div style={{ fontSize: 10, color: "#8E8E93" }}>
                      {p.status === "active"
                        ? "Earning"
                        : p.status === "paused"
                          ? "Paused"
                          : "Pending withdraw"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {p.status === "active" && (
                      <button
                        onClick={() => pauseMut.mutate({ positionId: p.id, paused: true })}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "5px 10px",
                          borderRadius: 14,
                          border: "0.5px solid rgba(60,60,67,0.20)",
                          background: "transparent",
                          color: "#1C1C1E",
                          cursor: "pointer",
                        }}
                      >
                        Pause
                      </button>
                    )}
                    {p.status === "paused" && (
                      <button
                        onClick={() => pauseMut.mutate({ positionId: p.id, paused: false })}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "5px 10px",
                          borderRadius: 14,
                          border: "0.5px solid rgba(0,200,150,0.30)",
                          background: "rgba(0,200,150,0.10)",
                          color: "#00A07A",
                          cursor: "pointer",
                        }}
                      >
                        Resume
                      </button>
                    )}
                    {p.status !== "pending_withdraw" && (
                      <button
                        onClick={() => withdrawMut.mutate({ positionId: p.id })}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "5px 10px",
                          borderRadius: 14,
                          border: "0.5px solid rgba(229,80,80,0.30)",
                          background: "rgba(229,80,80,0.08)",
                          color: "#C04040",
                          cursor: "pointer",
                        }}
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <div
          style={{
            background: "#FFFFFF",
            borderRadius: 14,
            padding: 16,
            boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E", marginBottom: 4 }}>
            Earn yield by depositing USDC
          </div>
          <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 12 }}>
            The bot runs market-making across stablecoin FX pairs. Caps:{" "}
            ${fmtUsdc(stats.data?.maxPerUserUsdc ?? 0)} per user, $
            {fmtUsdc(stats.data?.maxPoolUsdc ?? 0)} pool. Performance fee{" "}
            {(stats.data?.performanceFeeBps ?? 0) / 100}% (charged only on
            positive cycles).
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="USDC amount"
              inputMode="decimal"
              style={{
                flex: 1,
                height: 40,
                padding: "0 12px",
                fontSize: 14,
                borderRadius: 10,
                border: "0.5px solid rgba(60,60,67,0.20)",
                background: "rgba(60,60,67,0.04)",
                outline: "none",
              }}
            />
            <button
              onClick={handleDeposit}
              disabled={depositMut.isPending || isKilled || !isConfigured}
              style={{
                height: 40,
                padding: "0 16px",
                fontSize: 13,
                fontWeight: 700,
                borderRadius: 10,
                border: "none",
                background:
                  depositMut.isPending || isKilled || !isConfigured
                    ? "rgba(60,60,67,0.15)"
                    : "linear-gradient(135deg, #00C896, #00A87A)",
                color: "#FFFFFF",
                cursor:
                  depositMut.isPending || isKilled || !isConfigured ? "not-allowed" : "pointer",
              }}
            >
              {depositMut.isPending ? "…" : "Deposit"}
            </button>
          </div>
          <button
            onClick={() => setShowDisclosure((v) => !v)}
            style={{
              marginTop: 10,
              fontSize: 11,
              color: "#8E8E93",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {showDisclosure ? "Hide risks" : "Show risks"} ↘
          </button>
          {showDisclosure && (
            <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 8, lineHeight: 1.5 }}>
              Yield is not guaranteed. The bot may realize losses; deposits
              are not principal-protected. Withdrawals settle on the next
              cycle (≤ 60s) at the cycle's NAV. The owner can flip the
              kill switch at any time, which halts new orders but never
              blocks withdrawals.
            </div>
          )}
        </div>
      )}

      {/* Recent cycles — sparkline-ish list */}
      <div
        style={{
          background: "#FFFFFF",
          borderRadius: 14,
          padding: 16,
          boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ fontSize: 11, color: "#8E8E93", marginBottom: 8 }}>RECENT CYCLES</div>
        {(cycles.data ?? []).length === 0 ? (
          <div style={{ fontSize: 12, color: "#8E8E93", padding: 12, textAlign: "center" }}>
            No cycles yet — bot ticks every minute.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(cycles.data ?? []).map((c) => {
              const chip = fmtBps(Number(c.pnlBps));
              return (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 11,
                    padding: "6px 0",
                    borderBottom: "0.5px solid rgba(60,60,67,0.06)",
                  }}
                >
                  <span style={{ color: "#8E8E93" }}>
                    {new Date(c.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span style={{ color: "#1C1C1E", fontWeight: 600 }}>
                    NAV {Number(c.totalShares) > 0
                      ? (Number(c.totalAssets) / Number(c.totalShares)).toFixed(6)
                      : "1.000000"}
                  </span>
                  <span style={{ color: chip.color, fontWeight: 700 }}>{chip.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
