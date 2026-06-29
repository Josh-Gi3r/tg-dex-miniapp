/**
 * P2P Marketplace Tab
 *
 * Modes:
 *   Swap  - stablecoin-to-stablecoin (MAIN FOCUS, instant on-chain settlement)
 *   Buy   - on-ramp fiat->stablecoin
 *   Sell  - off-ramp stablecoin->fiat
 *
 * Sections:
 *   Browse Ads   - ranked ad list with filters
 *   Post Ad      - create a new liquidity position
 *   My Ads       - manage own active ads
 *   Trader Profile - tap any poster to see full profile + feedback
 */

import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { useDemoGate } from "@/contexts/DemoGate";
import { useAuth } from "@/_core/hooks/useAuth";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { SuccessModal } from "@/components/SuccessModal";
import { toast } from "sonner";
import { getAllTokens, getExplorerUrl } from "@/../../shared/dex-api-config";
import { useVenueWallet } from "@/lib/privy/useEmbeddedWallet";
import { InfoChip } from "@/components/onboarding/InfoChip";
import { runSwapOrchestrator } from "@/lib/dex/swap";
import { runMarketMakerCancel, runRetryOrderPlacement } from "@/lib/dex/marketMaker";
import { resolveToken, toRawAmount } from "@/lib/dex/tokens";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AdMode = "swap" | "buy" | "sell";
type TabSection = "browse" | "post" | "myads";

interface AdPoster {
  id?: number;
  displayName: string;
  telegramHandle: string | null;
  completionRate: number;
  completionRate30d: number;
  totalOrdersFilled: number;
  totalOrders30d: number;
  avgSettlementMinutes: number;
  avgRating: number;
  location: string | null;
}

interface Ad {
  id: string;
  posterId: number;
  adType: AdMode;
  fromToken: string;
  toToken: string;
  rate: number;
  liquidity: number;
  liquidityRemaining: number;
  minOrder: number;
  maxOrder: number;
  terms: string | null;
  status: string;
  totalFills: number;
  promotionTier: string;
  paymentMethods?: string[];
  poster: AdPoster;
  isDemo?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function fmtRate(rate: number, from: string, to: string): string {
  if (rate < 0.001) return `1 ${from} = ${rate.toFixed(6)} ${to}`;
  if (rate < 1) return `1 ${from} = ${rate.toFixed(4)} ${to}`;
  if (rate >= 10000) return `1 ${from} = ${rate.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${to}`;
  return `1 ${from} = ${rate.toFixed(4)} ${to}`;
}

function completionColor(rate: number): string {
  if (rate >= 99) return "#34C759";
  if (rate >= 95) return "#FF9500";
  return "#FF3B30";
}

function promotionBadge(tier: string): { label: string; color: string } | null {
  if (tier === "pinned") return { label: "Pinned", color: "#FF9500" };
  if (tier === "highlighted") return { label: "Featured", color: "#5856D6" };
  if (tier === "boosted") return { label: "Boosted", color: "#007AFF" };
  return null;
}

const ALL_TOKENS = getAllTokens().map((t) => t.symbol);

// ---------------------------------------------------------------------------
// Ad Card
// ---------------------------------------------------------------------------

function AdCard({ ad, onSelect }: { ad: Ad; onSelect: (a: Ad) => void }) {
  const badge = promotionBadge(ad.promotionTier);
  const isSwap = ad.adType === "swap";

  return (
    <div
      onClick={() => onSelect(ad)}
      style={{
        background: "#FFFFFF",
        borderRadius: 16,
        border: badge ? `1px solid ${badge.color}30` : "0.5px solid rgba(60,60,67,0.12)",
        boxShadow: badge
          ? `0 2px 12px ${badge.color}18`
          : "0 1px 8px rgba(0,0,0,0.04)",
        padding: "14px 16px",
        cursor: "pointer",
        transition: "box-shadow 0.15s ease",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Promotion badge — sits at top-left, never overlaps price */}
      {badge && (
        <div style={{
          position: "absolute", top: 0, left: 0,
          background: badge.color,
          color: "#FFF",
          fontSize: 10, fontWeight: 700,
          padding: "3px 10px",
          borderBottomRightRadius: 10,
          borderTopLeftRadius: 16,
          letterSpacing: "0.04em",
        }}>
          {badge.label}
        </div>
      )}

      {/* Demo badge — top-right so makers/takers see this isn't real liquidity */}
      {ad.isDemo && (
        <div style={{
          position: "absolute", top: 0, right: 0,
          background: "#8E8E93",
          color: "#FFF",
          fontSize: 10, fontWeight: 700,
          padding: "3px 10px",
          borderBottomLeftRadius: 10,
          borderTopRightRadius: 16,
          letterSpacing: "0.04em",
        }}>
          DEMO
        </div>
      )}

      {/* Top row: avatar + name + rate */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            background: "rgba(0,200,150,0.10)",
            border: "0.5px solid rgba(0,200,150,0.20)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 800, color: "#00C896",
          }}>
            {ad.poster.displayName[0].toUpperCase()}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E" }}>
                {ad.poster.displayName}
              </span>
              {ad.poster.completionRate >= 99 && (
                <span style={{ fontSize: 12, color: "#00C896" }}>✓</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
              <span style={{ fontSize: 12, color: "#D4A017" }}>
                ★ {ad.poster.avgRating.toFixed(2)}
              </span>
              <span style={{ fontSize: 11, color: "#AEAEB2" }}>·</span>
              <span style={{ fontSize: 11, color: "#8E8E93" }}>
                {fmtNum(ad.poster.totalOrdersFilled)} trades
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{
                fontSize: 11, fontWeight: 600,
                color: completionColor(ad.poster.completionRate30d),
              }}>
                {ad.poster.completionRate30d.toFixed(1)}% completion
              </span>
              <span style={{ fontSize: 11, color: "#AEAEB2" }}>·</span>
              <span style={{ fontSize: 11, color: "#8E8E93" }}>
                ~{ad.poster.avgSettlementMinutes < 1
                  ? `${Math.round(ad.poster.avgSettlementMinutes * 60)}s`
                  : `${ad.poster.avgSettlementMinutes.toFixed(0)}m`} avg
              </span>
            </div>
          </div>
        </div>

        {/* Rate — right-aligned, padded top to clear any badge */}
        <div style={{ textAlign: "right", paddingTop: badge ? 18 : 0 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#00C896", letterSpacing: "-0.02em", lineHeight: 1 }}>
            {ad.rate >= 1000
              ? ad.rate.toLocaleString(undefined, { maximumFractionDigits: 0 })
              : ad.rate.toFixed(4)}
          </div>
          <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 3 }}>{ad.toToken} per {ad.fromToken}</div>
        </div>
      </div>

      {/* Pair + liquidity */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          background: "rgba(0,200,150,0.06)",
          border: "0.5px solid rgba(0,200,150,0.20)",
          borderRadius: 20, padding: "4px 10px",
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#00C896" }}>
            {ad.fromToken}
          </span>
          <span style={{ fontSize: 12, color: "#AEAEB2" }}>→</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#00C896" }}>
            {ad.toToken}
          </span>
        </div>
        {ad.poster.location && (
          <span style={{ fontSize: 12, color: "#8E8E93" }}>{ad.poster.location}</span>
        )}

      </div>

      {/* Limits + CTA */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 12, color: "#8E8E93" }}>
          Limit:{" "}
          <span style={{ color: "#1C1C1E", fontWeight: 600 }}>
            {fmtNum(ad.minOrder)} – {fmtNum(ad.maxOrder)} {ad.fromToken}
          </span>
        </div>
        <div style={{
          background: "linear-gradient(135deg, #00C896, #00A87A)",
          color: "#FFFFFF",
          fontSize: 13, fontWeight: 700,
          padding: "7px 18px", borderRadius: 20,
        }}>
          {isSwap ? "Swap" : ad.adType === "buy" ? "On-Ramp" : "Off-Ramp"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trader Profile Sheet
// ---------------------------------------------------------------------------

function TraderProfileSheet({
  handle,
  onClose,
  onSwap,
}: {
  handle: string;
  onClose: () => void;
  onSwap: (ad: Ad) => void;
}) {
  const { data, isLoading } = trpc.p2p.getTraderProfile.useQuery({ handle });

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 110,
          background: "rgba(0,0,0,0.5)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
      />
      <div
        style={{
          position: "fixed",
          bottom: "var(--nav-height, 64px)",
          left: 0, right: 0, zIndex: 111,
          maxWidth: 480, margin: "0 auto",
          background: "#F2F2F7",
          borderRadius: "20px 20px 0 0",
          boxShadow: "0 -4px 40px rgba(0,0,0,0.18)",
          display: "flex", flexDirection: "column",
          maxHeight: "calc(88vh - var(--nav-height, 64px))",
          animation: "slideUp 0.25s cubic-bezier(0.32,0.72,0,1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 12, paddingBottom: 4, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(60,60,67,0.18)" }} />
        </div>

        <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch" as any }}>
          {isLoading ? (
            <div style={{ padding: 32, textAlign: "center", color: "#8E8E93" }}>Loading profile…</div>
          ) : !data || !data.profile ? (
            <div style={{ padding: 32, textAlign: "center", color: "#8E8E93" }}>Profile not found</div>
          ) : (
            <>
              {/* Profile header */}
              <div style={{ padding: "12px 16px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: 16,
                    background: "rgba(0,200,150,0.10)",
                    border: "1.5px solid rgba(0,200,150,0.25)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 24, fontWeight: 800, color: "#00C896",
                  }}>
                    {data.profile.displayName[0]?.toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#1C1C1E" }}>
                      {data.profile.displayName}
                    </div>
                    {data.profile.telegramHandle && (
                      <div style={{ fontSize: 13, color: "#8E8E93" }}>@{data.profile.telegramHandle}</div>
                    )}
                    {data.profile.location && (
                      <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>{data.profile.location}</div>
                    )}
                  </div>
                </div>

                {/* Stats grid */}
                <div style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr",
                  gap: 8, background: "#FFFFFF",
                  borderRadius: 14, padding: "14px 16px",
                  border: "0.5px solid rgba(60,60,67,0.10)",
                }}>
                  {[
                    { label: "All Trades", value: fmtNum(data.profile.totalOrdersFilled) },
                    { label: "30d Trades", value: fmtNum(data.profile.totalOrders30d) },
                    { label: "30d Completion", value: `${data.profile.completionRate30d.toFixed(2)}%` },
                    { label: "Avg Settlement", value: data.profile.avgSettlementMinutes < 1 ? `${Math.round(data.profile.avgSettlementMinutes * 60)}s` : `${data.profile.avgSettlementMinutes.toFixed(1)}m` },
                    { label: "Rating", value: `★ ${data.profile.avgRating.toFixed(2)}` },
                    { label: "Settlement", value: "On-chain" },
                  ].map((stat) => (
                    <div key={stat.label} style={{ padding: "6px 0" }}>
                      <div style={{ fontSize: 11, color: "#8E8E93", marginBottom: 2 }}>{stat.label}</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>{stat.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Active ads */}
              {data.ads.length > 0 && (
                <div style={{ padding: "0 16px 16px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#8E8E93", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                    Active Positions ({data.ads.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {data.ads.map((ad) => (
                      <div
                        key={ad.id}
                        onClick={() => { onSwap(ad as Ad); onClose(); }}
                        style={{
                          background: "#FFFFFF", borderRadius: 12,
                          border: "0.5px solid rgba(60,60,67,0.10)",
                          padding: "12px 14px", cursor: "pointer",
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E" }}>
                            {ad.fromToken} → {ad.toToken}
                          </div>
                          <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>
                            {fmtRate(ad.rate, ad.fromToken, ad.toToken)}
                          </div>
                          <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 2 }}>
                            Limit: {fmtNum(ad.minOrder)} – {fmtNum(ad.maxOrder)} {ad.fromToken}
                          </div>
                        </div>
                        <div style={{
                          background: ad.adType === "swap"
                            ? "linear-gradient(135deg, #00C896, #00A87A)"
                            : "rgba(118,118,128,0.12)",
                          color: ad.adType === "swap" ? "#FFF" : "#8E8E93",
                          fontSize: 12, fontWeight: 700,
                          padding: "6px 14px", borderRadius: 20,
                        }}>
                          {ad.adType === "swap" ? "Swap" : "Soon"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Close button */}
        <div style={{ flexShrink: 0, padding: "12px 16px 24px", borderTop: "0.5px solid rgba(60,60,67,0.10)", background: "#F2F2F7" }}>
          <button
            onClick={onClose}
            style={{
              width: "100%", padding: "14px 0", borderRadius: 14,
              border: "0.5px solid rgba(60,60,67,0.20)",
              background: "transparent",
              fontSize: 14, fontWeight: 600, color: "#3C3C43",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
      <style>{`@keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }`}</style>
    </>
  );
}

// ---------------------------------------------------------------------------
// Ad Detail Sheet
// ---------------------------------------------------------------------------

function AdDetailSheet({
  ad,
  onClose,
  onViewProfile,
  onOrderPlaced,
}: {
  ad: Ad;
  onClose: () => void;
  onViewProfile: (handle: string) => void;
  onOrderPlaced?: (orderId: number) => void;
}) {
  const { haptic } = useTelegram();
  const { user } = useAuth();
  const [amount, setAmount] = useState("");
  const [fiatAmount, setFiatAmount] = useState("");
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [tradeSimulated, setTradeSimulated] = useState(false);

  const executeSwap = trpc.p2p.executeSwap.useMutation();
  const placeOrder = trpc.p2p.placeOrder.useMutation();

  // Vault-backed 3-leg burst (testnet imported-key flow). Server orchestrates
  // taker-pays → maker-vault-withdraw → maker-recycle. Validated on-chain.
  const reserveMut = trpc.shopSettlement.reserve.useMutation();
  const burstMut = trpc.shopSettlement.executeBurst.useMutation();
  // The taker's wallet address (imported via Me tab → wallet.importPrivateKey).
  const takerWalletQuery = trpc.wallet.getOrCreate.useQuery(undefined, { retry: false });
  const takerAddr = takerWalletQuery.data?.address ?? null;

  // Live-mode plumbing (Privy + the venue). When unavailable, the legacy
  // server-side placeholder path runs.
  const venueWallet = useVenueWallet();
  const trpcUtils = trpc.useUtils();
  const dexTokensQuery = trpc.dex.tokens.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const venueLiveMode =
    venueWallet.isReady && venueWallet.isAuthenticated && !!venueWallet.address;

  const toAmount = useMemo(() => {
    const val = parseFloat(amount);
    if (!val || val <= 0) return "";
    return (val * ad.rate).toFixed(4);
  }, [amount, ad.rate]);

  const isSwap = ad.adType === "swap";
  const isFiat = !isSwap; // buy or sell — P2P settlement flow

  const { blockIfDemo } = useDemoGate();
  const handleSwapClick = () => {
    if (blockIfDemo("P2P trading")) return;
    if (isFiat && !selectedPaymentMethod) {
      toast.error("Please select a payment method");
      return;
    }
    haptic.impact("medium");
    const val = parseFloat(amount);
    if (!amount || isNaN(val) || val <= 0) {
      toast.error("Please enter an amount");
      return;
    }
    if (val < ad.minOrder) {
      toast.error(`Minimum order: ${fmtNum(ad.minOrder)} ${ad.fromToken}`);
      return;
    }
    if (val > ad.maxOrder) {
      toast.error(`Maximum order: ${fmtNum(ad.maxOrder)} ${ad.fromToken}`);
      return;
    }
    if (!user) {
      toast.error("Please log in to trade");
      return;
    }
    setShowConfirm(true);
  };

  const handleConfirm = async () => {
    const val = parseFloat(amount);
    if (isSwap) {
      // Stablecoin swap. Live mode (Privy connected): real the venue quote+sign+execute.
      // Demo mode: server-side placeholder tx hash + DB insert.
      try {
        if (takerAddr && !venueLiveMode) {
          // Vault-backed coordinated 3-leg burst against this specific shop.
          // Server signs all legs via managed wallets (taker imported key +
          // maker managed-shop-wallet). Identity-locked, vault-backed.
          const reserved = await reserveMut.mutateAsync({
            adId: typeof ad.id === "string" ? parseInt(ad.id) : ad.id,
            takeAmountHuman: String(val),
            takerAddress: takerAddr,
            ttlSeconds: 180,
          });
          const burst = await burstMut.mutateAsync({ settlementUuid: reserved.settlementUuid });
          const burstErr = "error" in burst ? burst.error : undefined;
          if (!burst.ok && burst.finalStatus !== "recycle_pending") {
            throw new Error(burstErr || `Trade ended at ${burst.finalStatus}`);
          }
          // Taker cares about the release leg (they received the token).
          setTxHash(burst.releaseTxHash ?? burst.paymentTxHash ?? "");
          setTradeSimulated(false);
        } else {
          // No imported wallet → no real settlement path. Don't fake a swap
          // (the old executeSwap demo wrote a fake "filled" order + XP).
          throw new Error("Import your wallet first to trade (Me → Import your wallet).");
        }
        setShowConfirm(false);
        haptic.notification("success");
        setShowSuccess(true);
      } catch (err) {
        haptic.notification("error");
        toast.error(err instanceof Error ? err.message : "Swap failed");
      }
    } else {
      // Fiat order — escrow flow
      try {
        const result = await placeOrder.mutateAsync({
          adId: typeof ad.id === "string" ? parseInt(ad.id) : ad.id,
          changerId: ad.poster.id ?? 0,
          fromToken: ad.fromToken,
          toToken: ad.toToken,
          fromAmount: String(val),
          toAmount: toAmount || "0",
          rateUsed: ad.rate,
          adType: ad.adType as "buy" | "sell",
          fiatAmount: fiatAmount || toAmount,
          fiatCurrency: ad.toToken,
          paymentMethod: selectedPaymentMethod,
          advertiserHandle: ad.poster.telegramHandle ?? undefined,
        });
        setShowConfirm(false);
        haptic.notification("success");
        toast.success("Order placed! Escrow locked.");
        onClose();
        if (result.orderId && onOrderPlaced) {
          onOrderPlaced(result.orderId as number);
        }
      } catch (err: any) {
        toast.error(err.message || "Failed to place order");
      }
    }
  };

  const handleChat = () => {
    haptic.impact("light");
    if (ad.poster.telegramHandle) {
      toast.success(`Opening chat with @${ad.poster.telegramHandle}…`);
      setTimeout(() => {
        window.Telegram?.WebApp?.openTelegramLink?.(
          `https://t.me/${ad.poster.telegramHandle}`
        );
      }, 400);
    } else {
      toast.info("This trader has not linked a Telegram handle.");
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
      />

      <div
        style={{
          position: "fixed",
          bottom: "var(--nav-height, 64px)",
          left: 0, right: 0, zIndex: 101,
          maxWidth: 480, margin: "0 auto",
          background: "#F2F2F7",
          borderRadius: "20px 20px 0 0",
          boxShadow: "0 -4px 40px rgba(0,0,0,0.15)",
          display: "flex", flexDirection: "column",
          maxHeight: "calc(92vh - var(--nav-height, 64px))",
          animation: "slideUp 0.25s cubic-bezier(0.32,0.72,0,1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 12, paddingBottom: 4, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(60,60,67,0.18)" }} />
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch" as any, padding: "0 0 8px" }}>

          {/* Header */}
          <div style={{ padding: "8px 16px 14px" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.02em" }}>
              {ad.fromToken} → {ad.toToken}
            </div>
            <div style={{ fontSize: 13, color: "#8E8E93", marginTop: 3 }}>
              {fmtRate(ad.rate, ad.fromToken, ad.toToken)}

            </div>
          </div>

          {/* Payment method selector for fiat orders */}
          {isFiat && (
            <div style={{ margin: "0 16px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#8E8E93", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Payment Method</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {(ad.paymentMethods?.length ? ad.paymentMethods : ["Bank Transfer", "Wise", "Revolut"]).map((method: string) => (
                  <button
                    key={method}
                    onClick={() => setSelectedPaymentMethod(method)}
                    style={{
                      padding: "8px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600,
                      border: selectedPaymentMethod === method ? "1.5px solid #00C896" : "0.5px solid rgba(60,60,67,0.20)",
                      background: selectedPaymentMethod === method ? "rgba(0,200,150,0.10)" : "#FFFFFF",
                      color: selectedPaymentMethod === method ? "#00C896" : "#3C3C43",
                      cursor: "pointer",
                    }}
                  >
                    {method}
                  </button>
                ))}
              </div>
              {selectedPaymentMethod && (
                <div style={{ marginTop: 10, padding: "10px 14px", background: "rgba(0,200,150,0.06)", borderRadius: 12, fontSize: 13, color: "#3C3C43", lineHeight: 1.5 }}>
                  💬 After placing the order, you'll be connected with the changer on Telegram to arrange payment details.
                </div>
              )}
            </div>
          )}

          {/* Rate card */}
          <div style={{ margin: "0 16px 14px", padding: "14px 16px", background: "#FFFFFF", borderRadius: 14, border: "0.5px solid rgba(60,60,67,0.10)", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(0,200,150,0.10)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>
              {isSwap ? "⚡" : "💱"}
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 2 }}>
                {isSwap ? "Instant on-chain settlement" : "Fiat settlement required"}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#00C896" }}>
                {fmtRate(ad.rate, ad.fromToken, ad.toToken)}
              </div>
            </div>
          </div>

          {/* Amount input (swap only) */}
          {isSwap && (
            <div style={{ margin: "0 16px 10px" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#3C3C43", marginBottom: 8 }}>
                You send
              </div>
              <div style={{ background: "#FFFFFF", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.12)", overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "0.5px solid rgba(60,60,67,0.08)" }}>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    style={{
                      flex: 1, border: "none", outline: "none",
                      background: "transparent",
                      fontSize: 22, fontWeight: 700, color: "#1C1C1E",
                      minWidth: 0,
                    }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#8E8E93", flexShrink: 0 }}>{ad.fromToken}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", padding: "10px 14px" }}>
                  <span style={{ flex: 1, fontSize: 17, fontWeight: 600, color: toAmount ? "#00C896" : "#AEAEB2" }}>
                    {toAmount || "0.0000"}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#8E8E93" }}>{ad.toToken}</span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 6 }}>
                Limit: {fmtNum(ad.minOrder)} – {fmtNum(ad.maxOrder)} {ad.fromToken}
              </div>
            </div>
          )}

          {/* Quick amounts */}
          {isSwap && (
            <div style={{ margin: "0 16px 14px", display: "flex", gap: 8, overflowX: "auto", WebkitOverflowScrolling: "touch" as any, paddingBottom: 2 }}>
              {[ad.minOrder, ad.minOrder * 5, ad.minOrder * 10, ad.minOrder * 20]
                .filter((v) => v <= ad.maxOrder)
                .map((v) => (
                  <button
                    key={v}
                    onClick={() => { haptic.impact("light"); setAmount(String(v)); }}
                    style={{
                      flexShrink: 0, padding: "7px 14px", borderRadius: 20,
                      background: "rgba(0,200,150,0.08)",
                      border: "0.5px solid rgba(0,200,150,0.25)",
                      fontSize: 13, fontWeight: 600, color: "#00C896", cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmtNum(v)}
                  </button>
                ))}
            </div>
          )}

          {/* How it works — fiat orders only */}
          {isFiat && (
            <div style={{ margin: "0 16px 14px", padding: "14px 16px", background: "rgba(0,200,150,0.05)", borderRadius: 14, border: "0.5px solid rgba(0,200,150,0.18)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#00C896", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>How it works</div>
              {[
                { step: "1", text: ad.adType === "buy" ? `Send fiat via your chosen payment method to the changer` : `Your ${ad.fromToken} is locked in escrow` },
                { step: "2", text: "Chat on Telegram to share payment details" },
                { step: "3", text: ad.adType === "buy" ? `Changer confirms receipt and releases ${ad.toToken} to you` : `Confirm you received fiat — escrow releases to you` },
              ].map(({ step, text }) => (
                <div key={step} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: step === "3" ? 0 : 8 }}>
                  <div style={{ width: 22, height: 22, borderRadius: 11, background: "#00C896", color: "#FFF", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{step}</div>
                  <span style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.5, paddingTop: 2 }}>{text}</span>
                </div>
              ))}
            </div>
          )}

          {/* Trade details */}
          <div style={{ margin: "0 16px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#8E8E93", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Trade details</div>
            <div style={{ background: "#FFFFFF", borderRadius: 14, border: "0.5px solid rgba(60,60,67,0.10)", overflow: "hidden" }}>
              {[
                { label: "Pair", value: `${ad.fromToken} → ${ad.toToken}` },
                { label: "Rate", value: fmtRate(ad.rate, ad.fromToken, ad.toToken) },
                { label: "Available liquidity", value: `${fmtNum(ad.liquidityRemaining)} ${ad.fromToken}` },
                { label: "Settlement", value: isSwap ? "Instant on-chain" : "P2P Settlement" },
                ...(ad.poster.location ? [{ label: "Location", value: ad.poster.location }] : []),
              ].map((row, i, arr) => (
                <div key={row.label} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: i < arr.length - 1 ? "0.5px solid rgba(60,60,67,0.08)" : "none",
                }}>
                  <span style={{ fontSize: 13, color: "#8E8E93" }}>{row.label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E" }}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Terms */}
          {ad.terms && (
            <div style={{ margin: "0 16px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#8E8E93", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Terms</div>
              <div style={{ background: "#FFFFFF", borderRadius: 14, border: "0.5px solid rgba(60,60,67,0.10)", padding: "14px 16px", fontSize: 13, color: "#3C3C43", lineHeight: 1.6 }}>
                {ad.terms}
              </div>
            </div>
          )}

          {/* Trader info */}
          <div style={{ margin: "0 16px 8px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#8E8E93", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Trader</div>
            <div
              onClick={() => ad.poster.telegramHandle && onViewProfile(ad.poster.telegramHandle)}
              style={{
                background: "#FFFFFF", borderRadius: 14,
                border: "0.5px solid rgba(60,60,67,0.10)",
                padding: "14px 16px", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(0,200,150,0.10)", border: "0.5px solid rgba(0,200,150,0.20)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#00C896", flexShrink: 0 }}>
                  {ad.poster.displayName[0].toUpperCase()}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E" }}>{ad.poster.displayName}</div>
                  <div style={{ fontSize: 12, color: "#D4A017", marginTop: 1 }}>
                    ★ {ad.poster.avgRating.toFixed(2)} · {fmtNum(ad.poster.totalOrdersFilled)} trades · {ad.poster.completionRate30d.toFixed(1)}% completion
                  </div>
                </div>
              </div>
              <span style={{ fontSize: 13, color: "#8E8E93" }}>›</span>
            </div>
          </div>

        </div>

        {/* Sticky CTAs */}
        <div style={{
          flexShrink: 0,
          padding: "12px 16px 24px",
          borderTop: "0.5px solid rgba(60,60,67,0.10)",
          background: "#F2F2F7",
          display: "flex", gap: 10,
        }}>
          <button
            onClick={handleChat}
            style={{
              flex: 1, padding: "14px 0", borderRadius: 14,
              border: "0.5px solid rgba(60,60,67,0.20)",
              background: "transparent",
              fontSize: 14, fontWeight: 600, color: "#3C3C43",
              cursor: "pointer",
            }}
          >
            💬 Chat
          </button>
          <button
            onClick={handleSwapClick}
            style={{
              flex: 2, padding: "14px 0", borderRadius: 14, border: "none",
              background: "linear-gradient(135deg, #00C896, #00A87A)",
              fontSize: 14, fontWeight: 700,
              color: "#FFFFFF",
              cursor: "pointer",
              boxShadow: "0 4px 16px rgba(0,200,150,0.30)",
            }}
          >
            {isSwap ? `Swap ${ad.fromToken} →` : ad.adType === "buy" ? `On-Ramp ${ad.toToken} →` : `Off-Ramp ${ad.fromToken} →`}
          </button>
        </div>
      </div>

      {/* Confirm Sheet */}
      <ConfirmSheet
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleConfirm}
        loading={isSwap ? executeSwap.isPending : placeOrder.isPending}
        title={isSwap ? "Confirm Swap" : `Confirm ${ad.adType === "buy" ? "On-Ramp" : "Off-Ramp"}`}
        emoji={isSwap ? "⚡" : "💱"}
        subtitle={
          isSwap
            ? `Instant on-chain settlement via the settlement venue. Your ${ad.fromToken} will be locked in escrow and released to the counterparty upon confirmation.`
            : "Stablecoin held in escrow until fiat settles. You'll get a Telegram link to chat with the changer."
        }
        confirmLabel={(() => {
          if (isSwap) return executeSwap.isPending ? "Executing swap…" : "Confirm Swap";
          return placeOrder.isPending ? "Placing order…" : "Confirm Order";
        })()}
        details={[
          { label: "You send", value: `${parseFloat(amount || "0").toLocaleString()} ${ad.fromToken}` },
          { label: "You receive", value: `${toAmount || "0"} ${ad.toToken}` },
          { label: "Rate", value: fmtRate(ad.rate, ad.fromToken, ad.toToken) },
          { label: "Counterparty", value: ad.poster.displayName },
          { label: "Settlement", value: isSwap ? "Instant on-chain" : "Escrow until fiat received" },
        ]}
      />

      {/* Success Modal */}
      <SuccessModal
        open={showSuccess}
        onClose={() => { setShowSuccess(false); onClose(); }}
        title={tradeSimulated ? "Demo trade complete" : "Swap complete!"}
        subtitle={tradeSimulated
          ? `Demo settlement — no funds moved. Connect a wallet to trade real ${ad.fromToken} → ${ad.toToken}.`
          : `${parseFloat(amount || "0").toLocaleString()} ${ad.fromToken} swapped to ${toAmount} ${ad.toToken} via the settlement venue.`}
        xpAwarded={0}
        emoji={tradeSimulated ? "🧪" : "⚡"}
        details={[
          { label: "You sent", value: `${parseFloat(amount || "0").toLocaleString()} ${ad.fromToken}` },
          { label: "You received", value: `${toAmount} ${ad.toToken}` },
          { label: "TX Hash", value: tradeSimulated
            ? "— (demo, no on-chain tx)"
            : (txHash ? `${txHash.slice(0, 18)}…${txHash.slice(-4)}` : "—") },
          // The release leg sent the tokens to the taker's wallet; honest copy —
          // not "Confirmed ✓" (the release tx broadcasts; recycle may still settle).
          { label: "Status", value: tradeSimulated ? "Demo settlement" : (txHash ? "Sent to your wallet" : "Settling…") },
        ]}
        ctaLabel={tradeSimulated ? undefined : "View on Explorer"}
        onCta={tradeSimulated ? undefined : () => {
          if (txHash) window.open(getExplorerUrl(txHash), "_blank");
        }}
      />

      <style>{`@keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }`}</style>
    </>
  );
}

// ---------------------------------------------------------------------------
// Post Ad Sheet
// ---------------------------------------------------------------------------

function PostAdSheet({ onClose }: { onClose: () => void }) {
  const { haptic } = useTelegram();
  const [adType, setAdType] = useState<AdMode>("swap");
  const [fromToken, setFromToken] = useState("USDT");
  const [toToken, setToToken] = useState("XSGD");
  const [rate, setRate] = useState("");
  const [liquidity, setLiquidity] = useState("");
  const [minOrder, setMinOrder] = useState("");
  const [maxOrder, setMaxOrder] = useState("");
  const [terms, setTerms] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  const postAd = trpc.p2p.postAd.useMutation();
  const postAdLive = trpc.p2p.postAdLive.useMutation();
  const utils = trpc.useUtils();

  const { blockIfDemo: blockPost } = useDemoGate();
  const handlePost = async () => {
    if (blockPost("Posting an offer")) return;
    if (!rate || !liquidity || !minOrder || !maxOrder) {
      toast.error("Please fill in all required fields");
      return;
    }
    haptic.impact("medium");
    const common = {
      fromToken,
      toToken,
      rate: parseFloat(rate),
      liquidity: parseFloat(liquidity),
      minOrder: parseFloat(minOrder),
      maxOrder: parseFloat(maxOrder),
      terms: terms || undefined,
    };
    try {
      if (adType === "swap") {
        // Real, vault-backed: checks vault, deposits the shortfall, and posts
        // a live the venue order. Can take ~1 min if a deposit is needed.
        await postAdLive.mutateAsync(common);
      } else {
        // Fiat on/off-ramp ads aren't on the the venue book — DB row is correct here.
        await postAd.mutateAsync({ adType, ...common });
      }
      utils.p2p.listAds.invalidate();
      utils.p2p.getMyAds.invalidate();
      haptic.notification("success");
      setShowSuccess(true);
    } catch (err: any) {
      toast.error(err.message || "Failed to post ad");
    }
  };

  if (showSuccess) {
    return (
      <SuccessModal
        open={true}
        onClose={() => { setShowSuccess(false); onClose(); }}
        title="Ad Posted!"
        subtitle={
          adType === "swap"
            ? `Your offer is now live. People can see it and trade with you. The ${fromToken} you offered is kept safe in your venue vault until someone trades.`
            : `Your ${fromToken} → ${toToken} offer is now listed. When someone wants it, you'll get a link in Telegram to chat with them.`
        }
        xpAwarded={0}
        emoji="📢"
        details={[
          { label: "Pair", value: `${fromToken} → ${toToken}` },
          { label: "Rate", value: fmtRate(parseFloat(rate), fromToken, toToken) },
          { label: "Liquidity", value: `${parseFloat(liquidity).toLocaleString()} ${fromToken}` },
          { label: "Order limits", value: `${parseFloat(minOrder).toLocaleString()} – ${parseFloat(maxOrder).toLocaleString()} ${fromToken}` },
        ]}
      />
    );
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
      />
      <div
        style={{
          position: "fixed",
          bottom: "var(--nav-height, 64px)",
          left: 0, right: 0, zIndex: 101,
          maxWidth: 480, margin: "0 auto",
          background: "#F2F2F7",
          borderRadius: "20px 20px 0 0",
          boxShadow: "0 -4px 40px rgba(0,0,0,0.15)",
          display: "flex", flexDirection: "column",
          maxHeight: "calc(92vh - var(--nav-height, 64px))",
          animation: "slideUp 0.25s cubic-bezier(0.32,0.72,0,1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 12, paddingBottom: 4, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(60,60,67,0.18)" }} />
        </div>

        <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch" as any }}>
          <div style={{ padding: "8px 16px 16px" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1C1C1E", marginBottom: 4 }}>Create a Position</div>
            <div style={{ fontSize: 13, color: "#8E8E93", marginBottom: 16 }}>
              Set your absolute rate and deposit liquidity. Takers swap directly against your position on-chain.
            </div>

            {/* Position type selector removed 2026-06-09 — P2P positions are
                crypto↔crypto swaps only. Fiat on/off-ramp lives in the Cash
                tab (Peer). adType stays "swap". */}

            {/* Token pair */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", marginBottom: 8 }}>Token pair</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <select
                  value={fromToken}
                  onChange={(e) => setFromToken(e.target.value)}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "0.5px solid rgba(60,60,67,0.15)", background: "#FFFFFF", fontSize: 14, fontWeight: 600, color: "#1C1C1E", outline: "none" }}
                >
                  {ALL_TOKENS.map((t: string) => <option key={t} value={t}>{t}</option>)}
                </select>
                <span style={{ fontSize: 18, color: "#8E8E93" }}>→</span>
                <select
                  value={toToken}
                  onChange={(e) => setToToken(e.target.value)}
                  style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "0.5px solid rgba(60,60,67,0.15)", background: "#FFFFFF", fontSize: 14, fontWeight: 600, color: "#1C1C1E", outline: "none" }}
                >
                  {ALL_TOKENS.filter((t: string) => t !== fromToken).map((t: string) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            {/* Rate */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", marginBottom: 8 }}>
                Your absolute rate (1 {fromToken} = ? {toToken})
              </div>
              <input
                type="number"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="e.g. 1.3621"
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: 10,
                  border: "0.5px solid rgba(60,60,67,0.15)",
                  background: "#FFFFFF", fontSize: 16, fontWeight: 600, color: "#1C1C1E",
                  outline: "none", boxSizing: "border-box",
                }}
              />
            </div>

            {/* Liquidity */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", marginBottom: 8 }}>
                Deposit liquidity ({fromToken})
              </div>
              <input
                type="number"
                inputMode="decimal"
                value={liquidity}
                onChange={(e) => setLiquidity(e.target.value)}
                placeholder="e.g. 10000"
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: 10,
                  border: "0.5px solid rgba(60,60,67,0.15)",
                  background: "#FFFFFF", fontSize: 16, fontWeight: 600, color: "#1C1C1E",
                  outline: "none", boxSizing: "border-box",
                }}
              />
            </div>

            {/* Order limits */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", marginBottom: 8 }}>
                Order limits ({fromToken})
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  type="number"
                  inputMode="decimal"
                  value={minOrder}
                  onChange={(e) => setMinOrder(e.target.value)}
                  placeholder="Min (e.g. 100)"
                  style={{
                    flex: 1, padding: "12px 14px", borderRadius: 10,
                    border: "0.5px solid rgba(60,60,67,0.15)",
                    background: "#FFFFFF", fontSize: 14, fontWeight: 600, color: "#1C1C1E",
                    outline: "none",
                  }}
                />
                <input
                  type="number"
                  inputMode="decimal"
                  value={maxOrder}
                  onChange={(e) => setMaxOrder(e.target.value)}
                  placeholder="Max (e.g. 10000)"
                  style={{
                    flex: 1, padding: "12px 14px", borderRadius: 10,
                    border: "0.5px solid rgba(60,60,67,0.15)",
                    background: "#FFFFFF", fontSize: 14, fontWeight: 600, color: "#1C1C1E",
                    outline: "none",
                  }}
                />
              </div>
            </div>

            {/* Terms */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", marginBottom: 8 }}>
                Terms (optional)
              </div>
              <textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                placeholder="e.g. Instant settlement. High volume preferred."
                rows={3}
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: 10,
                  border: "0.5px solid rgba(60,60,67,0.15)",
                  background: "#FFFFFF", fontSize: 14, color: "#1C1C1E",
                  outline: "none", resize: "none", boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
              />
            </div>
          </div>
        </div>

        {/* CTAs */}
        <div style={{ flexShrink: 0, padding: "12px 16px 24px", borderTop: "0.5px solid rgba(60,60,67,0.10)", background: "#F2F2F7", display: "flex", gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: "14px 0", borderRadius: 14,
              border: "0.5px solid rgba(60,60,67,0.20)",
              background: "transparent",
              fontSize: 14, fontWeight: 600, color: "#3C3C43",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handlePost}
            disabled={postAd.isPending || postAdLive.isPending}
            style={{
              flex: 2, padding: "14px 0", borderRadius: 14, border: "none",
              background: "linear-gradient(135deg, #00C896, #00A87A)",
              fontSize: 14, fontWeight: 700, color: "#FFFFFF",
              cursor: "pointer",
              boxShadow: "0 4px 16px rgba(0,200,150,0.30)",
              opacity: postAd.isPending || postAdLive.isPending ? 0.7 : 1,
            }}
          >
            {postAdLive.isPending
              ? "Funding vault + posting order…"
              : postAd.isPending
              ? "Posting…"
              : "Create Position →"}
          </button>
        </div>
      </div>
      <style>{`@keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }`}</style>
    </>
  );
}

// ---------------------------------------------------------------------------
// My Ads Section
// ---------------------------------------------------------------------------

function MyAdsSection() {
  const { data: myAds, isLoading } = trpc.p2p.getMyAds.useQuery();
  const { data: pendingPlacement } = trpc.p2p.pendingPlacementAds.useQuery();
  const cancelAd = trpc.p2p.cancelAd.useMutation();
  const utils = trpc.useUtils();
  const { haptic } = useTelegram();
  const venueWallet = useVenueWallet();
  const dexTokensQuery = trpc.dex.tokens.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const venueLiveMode =
    venueWallet.isReady && venueWallet.isAuthenticated && !!venueWallet.address;
  const [retrying, setRetrying] = useState<number | null>(null);
  const editAd = trpc.p2p.editAd.useMutation();
  const [editing, setEditing] = useState<any>(null);
  const [editRate, setEditRate] = useState("");
  const [editMin, setEditMin] = useState("");
  const [editMax, setEditMax] = useState("");

  const openEdit = (ad: any) => {
    haptic.impact("light");
    setEditRate(String(ad.rate ?? ""));
    setEditMin(String(ad.minOrder ?? ""));
    setEditMax(String(ad.maxOrder ?? ""));
    setEditing(ad);
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    const rate = parseFloat(editRate), min = parseFloat(editMin), max = parseFloat(editMax);
    if (!(rate > 0)) { toast.error("Enter a valid rate"); return; }
    if (min > 0 && max > 0 && min > max) { toast.error("Min order can't exceed max"); return; }
    haptic.impact("medium");
    try {
      const res = await editAd.mutateAsync({
        adId: editing.id, rate,
        ...(min > 0 ? { minOrder: min } : {}),
        ...(max > 0 ? { maxOrder: max } : {}),
      });
      utils.p2p.getMyAds.invalidate();
      utils.p2p.listAds.invalidate();
      haptic.notification("success");
      toast.success(res.reposted ? "Order updated — repriced on the the venue book" : "Ad updated");
      setEditing(null);
    } catch (err) {
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Couldn't update the ad");
    }
  };

  // Ads where deposit succeeded but order placement didn't — see Phase A3.
  // The `pendingPlacement` list comes from p2p.pendingPlacementAds (ads with
  // status='paused', meaning draft rows that never reached commitOrder).
  const stalledAds = (pendingPlacement ?? []).filter(
    (a) => a.settlementDepositTxHash && !a.settlementOrderId,
  );

  const handleRetryPlacement = async (adId: number) => {
    if (!venueLiveMode) return;
    setRetrying(adId);
    try {
      const ad = stalledAds.find((a) => a.id === adId);
      if (!ad) throw new Error("Ad not found");
      const fromTok = resolveToken(ad.fromToken, dexTokensQuery.data?.tokens);
      const toTok = resolveToken(ad.toToken, dexTokensQuery.data?.tokens);
      if (!fromTok || !toTok) throw new Error("Token addresses unavailable");
      const liq = parseFloat(String(ad.liquidity));
      const rate = parseFloat(String(ad.rate));
      const fromAmountRaw = toRawAmount(String(liq), fromTok.decimals);
      const toAmountRaw = toRawAmount(String(liq * rate), toTok.decimals);
      const serverNow = await utils.client.dex.serverTime.query();
      await runRetryOrderPlacement({
        wallet: venueWallet,
        utils,
        adId,
        fromToken: fromTok.address,
        toToken: toTok.address,
        fromAmount: fromAmountRaw,
        toAmount: toAmountRaw,
        initialDepositAmount: fromAmountRaw,
        expiration: serverNow.timestamp + 30 * 24 * 60 * 60,
      });
      utils.p2p.getMyAds.invalidate();
      utils.p2p.pendingPlacementAds.invalidate();
      haptic.notification("success");
      toast.success("Order placed — your position is live on the venue");
    } catch (err) {
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(null);
    }
  };

  const handleCancel = async (adId: number) => {
    haptic.impact("medium");
    try {
      const ad = (myAds ?? []).find((a) => a.id === adId);
      // If this ad has a live the venue order attached AND we're in live mode,
      // sign + submit the CancelOrder before clearing the DB row. the venue's
      // 5-minute cooldown surfaces as a friendly TOO_MANY_REQUESTS error.
      if (venueLiveMode && ad?.settlementOrderId && ad?.settlementOrderUuidInt) {
        await runMarketMakerCancel({
          wallet: venueWallet,
          utils,
          orderId: ad.settlementOrderId,
          uuidInt: ad.settlementOrderUuidInt,
        });
      }
      await cancelAd.mutateAsync({ adId });
      utils.p2p.getMyAds.invalidate();
      toast.success("Position cancelled");
    } catch (err) {
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  };

  if (isLoading) return <div style={{ padding: 32, textAlign: "center", color: "#8E8E93" }}>Loading your positions…</div>;
  if (!myAds || myAds.length === 0) {
    return (
      <div style={{ padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", marginBottom: 6 }}>No active positions</div>
        <div style={{ fontSize: 13, color: "#8E8E93" }}>Create a liquidity position to start earning from your stablecoin holdings.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Stalled-deposit recovery banner — Phase A3 partial-failure UX */}
      {stalledAds.map((ad) => (
        <div
          key={`stalled-${ad.id}`}
          style={{
            background: "linear-gradient(135deg, rgba(255,149,0,0.10) 0%, rgba(255,149,0,0.04) 100%)",
            border: "0.5px solid rgba(255,149,0,0.30)",
            borderRadius: 14, padding: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E", marginBottom: 6 }}>
            ⚠️ Position needs placement
          </div>
          <div style={{ fontSize: 12, color: "#3C3C43", lineHeight: 1.45, marginBottom: 10 }}>
            You deposited {parseFloat(String(ad.liquidity)).toLocaleString()} {ad.fromToken} into your venue vault but this ad isn't live yet. Your funds are safe in your own vault — you can withdraw them anytime from the Wallet tab (Me → Withdraw).
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => handleRetryPlacement(ad.id)}
              disabled={retrying === ad.id || !venueLiveMode}
              style={{
                flex: 1, padding: "10px 0", borderRadius: 10, border: "none",
                background: retrying === ad.id || !venueLiveMode
                  ? "rgba(60,60,67,0.10)"
                  : "linear-gradient(135deg, #FF9500 0%, #E07F00 100%)",
                color: retrying === ad.id || !venueLiveMode ? "#8E8E93" : "#FFFFFF",
                fontSize: 13, fontWeight: 700,
                cursor: retrying === ad.id || !venueLiveMode ? "not-allowed" : "pointer",
              }}
            >
              {retrying === ad.id ? "Placing…" : "Retry placement"}
            </button>
            <button
              onClick={() => handleCancel(ad.id)}
              disabled={cancelAd.isPending}
              style={{
                padding: "10px 14px", borderRadius: 10,
                border: "0.5px solid rgba(60,60,67,0.20)",
                background: "transparent",
                color: "#3C3C43", fontSize: 13, fontWeight: 600,
                cursor: cancelAd.isPending ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
          </div>
          {ad.settlementDepositTxHash && (
            <a
              href={getExplorerUrl(ad.settlementDepositTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "block", marginTop: 8, fontSize: 11, color: "#FF9500", fontWeight: 600 }}
            >
              View deposit tx ↗
            </a>
          )}
        </div>
      ))}
      {myAds.map((ad) => (
        <div
          key={ad.id}
          style={{
            background: "#FFFFFF", borderRadius: 14,
            border: "0.5px solid rgba(60,60,67,0.12)",
            padding: "14px 16px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>
                {ad.fromToken} → {ad.toToken}
              </div>
              <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>
                Rate: {fmtRate(parseFloat(ad.rate), ad.fromToken, ad.toToken)}
              </div>
              {ad.settlementOrderId && (
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  marginTop: 6,
                  fontSize: 10, fontWeight: 700, color: "#00A07A",
                  background: "rgba(0,200,150,0.10)",
                  border: "0.5px solid rgba(0,200,150,0.30)",
                  padding: "2px 8px", borderRadius: 12,
                  letterSpacing: "0.04em",
                }}>
                  ● LIVE
                </div>
              )}
            </div>
            <span style={{
              fontSize: 11, fontWeight: 700,
              color: ad.status === "active" ? "#34C759" : "#8E8E93",
              background: ad.status === "active" ? "rgba(52,199,89,0.10)" : "rgba(142,142,147,0.10)",
              padding: "3px 10px", borderRadius: 20,
            }}>
              {ad.status}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 12, color: "#8E8E93" }}>
              Remaining: <span style={{ color: "#1C1C1E", fontWeight: 600 }}>{fmtNum(parseFloat(ad.liquidityRemaining))} {ad.fromToken}</span>
              {" · "}
              Fills: <span style={{ color: "#1C1C1E", fontWeight: 600 }}>{ad.totalFills}</span>
            </div>
            {ad.status === "active" && (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => openEdit(ad)}
                  style={{
                    padding: "6px 14px", borderRadius: 20,
                    border: "0.5px solid rgba(0,200,150,0.30)",
                    background: "rgba(0,200,150,0.06)",
                    fontSize: 12, fontWeight: 600, color: "#00A07A",
                    cursor: "pointer",
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleCancel(ad.id)}
                  disabled={cancelAd.isPending}
                  style={{
                    padding: "6px 14px", borderRadius: 20,
                    border: "0.5px solid rgba(255,59,48,0.30)",
                    background: "rgba(255,59,48,0.06)",
                    fontSize: 12, fontWeight: 600, color: "#FF3B30",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      ))}

      {/* Edit-ad sheet */}
      {editing && (
        <div
          onClick={() => setEditing(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "flex-end" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", background: "#FFFFFF", borderRadius: "20px 20px 0 0", padding: "20px 18px 28px" }}
          >
            <div style={{ fontSize: 17, fontWeight: 800, color: "#1C1C1E", marginBottom: 2 }}>Edit your offer</div>
            <div style={{ fontSize: 12.5, color: "#8E8E93", marginBottom: 16 }}>
              {editing.adType === "swap"
                ? "Changing the rate or size reprices your live order on the venue (your old order is cancelled and a new one posted)."
                : "Update your offer details."}
            </div>
            {[
              { label: `Rate (${editing.toToken} per ${editing.fromToken})`, value: editRate, set: setEditRate, ph: "0.00" },
              { label: `Min order (${editing.fromToken})`, value: editMin, set: setEditMin, ph: "—" },
              { label: `Max order (${editing.fromToken})`, value: editMax, set: setEditMax, ph: "—" },
            ].map((f) => (
              <div key={f.label} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", marginBottom: 6 }}>{f.label}</div>
                <input
                  type="number" inputMode="decimal" placeholder={f.ph}
                  value={f.value} onChange={(e) => f.set(e.target.value)}
                  style={{
                    width: "100%", padding: "12px 14px", borderRadius: 12,
                    border: "1px solid rgba(60,60,67,0.18)", background: "rgba(118,118,128,0.06)",
                    fontSize: 16, color: "#1C1C1E", outline: "none", fontFamily: "inherit",
                  }}
                />
              </div>
            ))}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button
                onClick={() => setEditing(null)}
                style={{ flex: 1, padding: "13px 0", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.20)", background: "transparent", fontSize: 14, fontWeight: 700, color: "#3C3C43", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={editAd.isPending}
                style={{
                  flex: 2, padding: "13px 0", borderRadius: 12, border: "none",
                  background: editAd.isPending ? "rgba(0,200,150,0.4)" : "linear-gradient(135deg,#00C896,#00A87A)",
                  fontSize: 14, fontWeight: 700, color: "#fff", cursor: editAd.isPending ? "default" : "pointer",
                }}
              >
                {editAd.isPending ? (editing.adType === "swap" ? "Repricing…" : "Saving…") : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main P2PTab
// ---------------------------------------------------------------------------

interface P2PTabProps {
  onOrderPlaced?: (orderId: number) => void;
  /** Cross-tab nav from the Swap "trade with a shop" CTA: focus this pair + open the ad. */
  nav?: { fromToken: string; toToken: string; openAdId: number } | null;
  onNavConsumed?: () => void;
}

export default function P2PTab({ onOrderPlaced, nav, onNavConsumed }: P2PTabProps = {}) {
  const { haptic } = useTelegram();
  const { user } = useAuth();

  const [adMode, setAdMode] = useState<AdMode>("swap");
  const [fromToken, setFromToken] = useState("USDT");
  const [toToken, setToToken] = useState<string | undefined>(undefined);
  const [section, setSection] = useState<TabSection>("browse");
  const [selectedAd, setSelectedAd] = useState<Ad | null>(null);
  const [showPostAd, setShowPostAd] = useState(false);
  const [profileHandle, setProfileHandle] = useState<string | null>(null);

  const { data: adsData, isLoading } = trpc.p2p.listAds.useQuery({
    adType: adMode,
    fromToken,
    toToken,
    limit: 30,
  });

  const { data: pairsData } = trpc.p2p.getAvailablePairs.useQuery({ adType: adMode });

  // Cross-tab nav from the Swap "trade with a shop" CTA → focus this pair.
  useEffect(() => {
    if (!nav) return;
    setAdMode("swap");
    setFromToken(nav.fromToken);
    setToToken(nav.toToken);
    setSection("browse");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav?.fromToken, nav?.toToken, nav?.openAdId]);

  // …then open that ad's take sheet once it's loaded into the filtered list.
  useEffect(() => {
    if (!nav?.openAdId || !adsData?.ads) return;
    const ad = adsData.ads.find((a) => Number(a.id) === nav.openAdId);
    if (ad) { setSelectedAd(ad as unknown as Ad); onNavConsumed?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav?.openAdId, adsData]);

  const fromTokens = useMemo(() => {
    if (!pairsData) return ["USDT", "GBPX", "PHPX", "XSGD", "MYRC"];
    return Array.from(new Set(pairsData.map((p: any) => p.fromToken)));
  }, [pairsData]);

  const toTokens = useMemo(() => {
    if (!pairsData) return [];
    const tokens = pairsData
      .filter((p: any) => p.fromToken === fromToken)
      .map((p: any) => p.toToken);
    return Array.from(new Set(tokens));
  }, [pairsData, fromToken]);

  const ads = adsData?.ads ?? [];

  return (
    <div className="tab-page">

      {/* Sticky header */}
      <div style={{
        position: "sticky", top: 0, zIndex: 20,
        background: "rgba(249,249,249,0.94)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderBottom: "0.5px solid rgba(60,60,67,0.12)",
        padding: "12px 16px",
      }}>

        {/* Page heading + how-it-works chip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <div
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: "#1C1C1E",
              letterSpacing: "-0.01em",
            }}
          >
            P2P
          </div>
          <InfoChip topic="p2p" compact />
        </div>

        {/* Section tabs */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {([
            { key: "browse", label: "Browse" },
            { key: "myads", label: "My Positions" },
          ] as { key: TabSection; label: string }[]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => { haptic.selectionChanged(); setSection(key); }}
              style={{
                padding: "7px 16px", borderRadius: 20, border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 700,
                background: section === key ? "#1C1C1E" : "rgba(118,118,128,0.12)",
                color: section === key ? "#FFFFFF" : "#8E8E93",
              }}
            >
              {label}
            </button>
          ))}

          {/* Create Position button */}
          <button
            onClick={() => {
              haptic.impact("light");
              if (!user) { toast.error("Please log in to create a position"); return; }
              setShowPostAd(true);
            }}
            style={{
              marginLeft: "auto",
              padding: "7px 16px", borderRadius: 20, border: "none", cursor: "pointer",
              fontSize: 13, fontWeight: 700,
              background: "linear-gradient(135deg, #00C896, #00A87A)",
              color: "#FFFFFF",
              boxShadow: "0 2px 10px rgba(0,200,150,0.25)",
            }}
          >
            ⚡ Position
          </button>
        </div>

        {/* P2P is crypto↔crypto only. Fiat on/off-ramp lives in the Cash tab
            (Peer). The old buy/sell mode tabs were removed 2026-06-09. */}

        {/* Token filters (browse only) */}
        {section === "browse" && (
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "#8E8E93", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>I have</div>
              <select
                value={fromToken}
                onChange={(e) => { setFromToken(e.target.value); setToToken(undefined); }}
                style={{ width: "100%", border: "0.5px solid rgba(60,60,67,0.15)", borderRadius: 10, padding: "8px 10px", fontSize: 13, fontWeight: 600, color: "#1C1C1E", background: "#FFFFFF", outline: "none", appearance: "none" }}
              >
                {fromTokens.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "#8E8E93", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>I want</div>
              <select
                value={toToken ?? ""}
                onChange={(e) => setToToken(e.target.value || undefined)}
                style={{ width: "100%", border: "0.5px solid rgba(60,60,67,0.15)", borderRadius: 10, padding: "8px 10px", fontSize: 13, fontWeight: 600, color: "#1C1C1E", background: "#FFFFFF", outline: "none", appearance: "none" }}
              >
                <option value="">Any</option>
                {toTokens.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="tab-content">

        {section === "myads" ? (
          <MyAdsSection />
        ) : isLoading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ background: "#FFFFFF", borderRadius: 16, height: 120, border: "0.5px solid rgba(60,60,67,0.08)", animation: "pulse 1.5s ease-in-out infinite" }} />
            ))}
          </div>
        ) : ads.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔍</div>
            <div className="empty-title">No ads found</div>
            <div className="empty-desc">
              No stablecoin swap ads match your filters. Try a different pair or be the first to post one.
            </div>
          </div>
        ) : (
          <>
            {/* DEMO_ADS source indicator removed in v4 scrub — all ads are now
                real DB rows. No "Sepolia Testnet preview · illustrative" banner. */}
            {ads.map((ad) => (
              <AdCard
                key={ad.id}
                ad={ad as Ad}
                onSelect={(a) => { haptic.impact("light"); setSelectedAd(a); }}
              />
            ))}
          </>
        )}
      </div>

      {/* Ad detail sheet */}
      {selectedAd && (
        <AdDetailSheet
          ad={selectedAd}
          onClose={() => setSelectedAd(null)}
          onViewProfile={(handle) => { setSelectedAd(null); setProfileHandle(handle); }}
          onOrderPlaced={onOrderPlaced}
        />
      )}

      {/* Trader profile sheet */}
      {profileHandle && (
        <TraderProfileSheet
          handle={profileHandle}
          onClose={() => setProfileHandle(null)}
          onSwap={(ad) => { setProfileHandle(null); setSelectedAd(ad); }}
        />
      )}

      {/* Post ad sheet */}
      {showPostAd && <PostAdSheet onClose={() => setShowPostAd(false)} />}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
