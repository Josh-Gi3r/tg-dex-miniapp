import { useState, useEffect } from "react";
import {
  SUPPORTED_TOKENS,
  TESTNET_TRADEABLE_SYMBOLS,
  type TokenSymbol,
  isMainnetActive,
  getExplorerUrl,
} from "@shared/venue-config";
import { useTelegram } from "@/contexts/TelegramContext";
import { useDemoGate } from "@/contexts/DemoGate";
import TokenPickerSheet from "@/components/TokenPickerSheet";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { InfoChip } from "@/components/onboarding/InfoChip";
import { SuccessModal } from "@/components/SuccessModal";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useVenueWallet } from "@/lib/privy/useEmbeddedWallet";
import { runSwapOrchestrator } from "@/lib/dex/swap";
import { resolveToken, toRawAmount } from "@/lib/dex/tokens";

const CURRENCY_FLAG: Record<string, string> = {
  SGD: "🇸🇬", MYR: "🇲🇾", IDR: "🇮🇩", USD: "💵",
};

// Pairs shown in the rotating header ticker. Just curated symbols — rates come
// from live trpc.swap.getRate calls below. No hardcoded numbers, no fake "up/down".
const TICKER_PAIRS: Array<[TokenSymbol, TokenSymbol]> = [
  ["USDT", "XSGD"],
  ["USDT", "MYRC"],
  ["USDT", "IDRX"],
  ["XSGD", "MYRC"],
];

function formatTimeAgo(date: Date | string): string {
  const ts = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Big-unit tokens (rupiah/won/dong/yen) display as whole numbers, not 4dp.
const BIG_UNIT = new Set(["IDRX", "IDRT", "XIDR", "VNDC", "KRW1", "KRWO", "KRWQ", "KRWIN", "JPYC", "JMYR"]);
function formatAmount(amount: number, token: string): string {
  if (BIG_UNIT.has(token)) return amount.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return amount.toFixed(4);
}

function formatRateValue(rate: number, toToken: string): string {
  if (BIG_UNIT.has(toToken)) return rate.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return rate.toFixed(4);
}

export default function SwapTab({ onTradeShop }: { onTradeShop?: (nav: { fromToken: string; toToken: string; adId: number }) => void } = {}) {
  const { haptic } = useTelegram();
  const venueWallet = useVenueWallet();
  const trpcUtils = trpc.useUtils();
  const dexTokensQuery = trpc.dex.tokens.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  // Real per-user data — replaces RECENT_TRADES + hardcoded 100 USDT balance.
  // Both are protected procs; the queries 401 cleanly when not authed and we
  // render a zero/empty state in that case (no fake data).
  const historyQuery = trpc.swap.getHistory.useQuery(
    { limit: 4 },
    { staleTime: 30_000, retry: false },
  );
  const balancesQuery = trpc.dex.balances.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  // Live money-changer rates board — the the venue CLOB book (anonymous best-price),
  // refreshed ~60s. Separate from P2P shop listings.
  const liveBoardQuery = trpc.dex.liveBoard.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const venueLiveMode =
    venueWallet.isReady && venueWallet.isAuthenticated && !!venueWallet.address;

  const [fromToken, setFromToken] = useState<string>("USDT");
  const [toToken, setToToken] = useState<string>("XSGD");
  const [amount, setAmount] = useState("");
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const swapManagedMut = trpc.dex.swapManaged.useMutation();

  // The REAL resting order book → every token with a funded order is tradeable,
  // not just a hardcoded set. fromTokens = tokens you can sell; toTokens(from) =
  // tokens reachable from the selected `from` via a funded route. Falls back to
  // the funded set while loading. (See server/lib/dex/liveOrders.ts.)
  const liveOrdersQuery = trpc.dex.liveOrders.useQuery(undefined, { staleTime: 60_000, retry: false });
  const liveRoutes = liveOrdersQuery.data?.snapshot?.routes ?? [];

  // Trusted SHOP routes — the same trade via a real changer (rep + chat), not the
  // anonymous CLOB. A shop fills via the 3-leg burst, so it can serve a pair even
  // when the CLOB can't; and even when both exist, plenty choose the shop for the
  // trust/relationship. Surfaced alongside the cold swap (INV-1: separate flows).
  const shopRoutesQuery = trpc.p2p.shopRoutes.useQuery(undefined, { staleTime: 60_000, retry: false });
  const shopRoutes = shopRoutesQuery.data?.routes ?? [];
  const shopsForPair = shopRoutes
    .filter((r) => r.from === fromToken && r.to === toToken)
    .sort((a, b) => (b.changer.rating ?? 0) - (a.changer.rating ?? 0));

  // Picker tokens = union of CLOB + shop routes (so shop-only corridors show too).
  const swapFromTokens: string[] = (() => {
    const clob = liveOrdersQuery.data?.snapshot?.fromTokens ?? [];
    const shop = shopRoutesQuery.data?.fromTokens ?? [];
    const u = [...new Set([...clob, ...shop])];
    return u.length ? u : [...TESTNET_TRADEABLE_SYMBOLS];
  })();
  const swapToTokens: string[] = (() => {
    const reachable = [
      ...liveRoutes.filter((r) => r.from === fromToken).map((r) => r.to),
      ...shopRoutes.filter((r) => r.from === fromToken).map((r) => r.to),
    ];
    return reachable.length ? [...new Set(reachable)] : [...TESTNET_TRADEABLE_SYMBOLS].filter((t) => t !== fromToken);
  })();
  const { blockIfDemo } = useDemoGate();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [rateIndex, setRateIndex] = useState(0);
  const [flipAnim, setFlipAnim] = useState(false);
  const [lastSwap, setLastSwap] = useState<{
    from: string;
    to: string;
    xp: number;
    txHash: string | null;
    simulated: boolean;
  } | null>(null);

  // Live rate for the active swap pair. the venue Frankfurter oracle. Refetches when
  // the from/to changes. No hardcoded BASE_RATES anymore.
  const activeRateQuery = trpc.swap.getRate.useQuery(
    { from: fromToken, to: toToken },
    { staleTime: 15_000, retry: false },
  );
  // Rate source: the FX oracle for core pairs; for EXOTIC / off-market routes the
  // oracle has nothing, so fall back to the live order book's actual route rate.
  // That way EVERY funded resting order is priced + swappable — not just the
  // handful of pairs the oracle knows (this is what makes "all orders, incl.
  // those without [oracle/quote] liquidity" actually show up in the swap).
  const liveRoute = liveRoutes.find((r) => r.from === fromToken && r.to === toToken);
  const oracleRate: number | undefined = activeRateQuery.data?.rate;
  const rate = oracleRate ?? liveRoute?.rate ?? shopsForPair[0]?.rate ?? 0;
  const rateLoaded = oracleRate !== undefined || (liveRoute?.rate ?? 0) > 0 || (shopsForPair[0]?.rate ?? 0) > 0;
  const rateFlash = activeRateQuery.isFetching;

  // Rotating ticker pairs. Each pair gets its own live getRate query; we rotate
  // the index every 3s for the cosmetic ticker in the header.
  const tickerRate0 = trpc.swap.getRate.useQuery({ from: TICKER_PAIRS[0]![0], to: TICKER_PAIRS[0]![1] }, { staleTime: 30_000, retry: false });
  const tickerRate1 = trpc.swap.getRate.useQuery({ from: TICKER_PAIRS[1]![0], to: TICKER_PAIRS[1]![1] }, { staleTime: 30_000, retry: false });
  const tickerRate2 = trpc.swap.getRate.useQuery({ from: TICKER_PAIRS[2]![0], to: TICKER_PAIRS[2]![1] }, { staleTime: 30_000, retry: false });
  const tickerRate3 = trpc.swap.getRate.useQuery({ from: TICKER_PAIRS[3]![0], to: TICKER_PAIRS[3]![1] }, { staleTime: 30_000, retry: false });
  const tickerQueries = [tickerRate0, tickerRate1, tickerRate2, tickerRate3];

  // Rotate ticker index every 3s
  useEffect(() => {
    const t = setInterval(() => setRateIndex((i) => (i + 1) % TICKER_PAIRS.length), 3000);
    return () => clearInterval(t);
  }, []);

  const parsedAmount = parseFloat(amount) || 0;
  const estimatedOut = parsedAmount > 0 && rateLoaded ? formatAmount(parsedAmount * rate, toToken) : "";
  // Resolve display info for ANY token (live tokens can be outside the static
  // SUPPORTED_TOKENS map). Prefer live /tokens metadata, fall back to the static
  // map, then to the symbol itself.
  const tokenMeta = (sym: string): { currency: string; name: string } => {
    const r = resolveToken(sym, dexTokensQuery.data?.tokens) as { currency?: string; name?: string } | null;
    const fb = SUPPORTED_TOKENS[sym as keyof typeof SUPPORTED_TOKENS] as { currency?: string; name?: string } | undefined;
    return { currency: r?.currency ?? fb?.currency ?? "USD", name: r?.name ?? fb?.name ?? sym };
  };
  const fromInfo = tokenMeta(fromToken);
  const toInfo = tokenMeta(toToken);

  // Live balance of the from-token from venue vault + wallet (no the venue API key
  // yet → returns {balances:[], linked:false} → shows 0). No hardcoded balance.
  // the venue /balances row shape: {symbol, decimals, wallet_balance, vault_available, ...}
  // The trpc proc types the array as unknown[] so cast at the boundary.
  type VenueBalanceRow = {
    symbol?: string;
    decimals?: number;
    wallet_balance?: string;
    vault_available?: string;
  };
  const fromBalanceHuman = (() => {
    const rows = (balancesQuery.data?.balances ?? []) as VenueBalanceRow[];
    const b = rows.find((x) => x.symbol === fromToken);
    if (!b) return 0;
    const decimals = b.decimals ?? 6;
    const denom = 10n ** BigInt(decimals);
    const total = BigInt(b.wallet_balance ?? "0") + BigInt(b.vault_available ?? "0");
    return Number(total / denom) + Number(total % denom) / Number(denom);
  })();
  const balLinked = !!balancesQuery.data?.linked;

  const handleFlip = () => {
    haptic.impact("light");
    setFlipAnim(true);
    setTimeout(() => {
      const prev = fromToken;
      setFromToken(toToken);
      setToToken(prev);
      setAmount("");
      setFlipAnim(false);
    }, 200);
  };

  const handleSwapClick = () => {
    if (blockIfDemo("Swap")) return;
    if (!amount || parsedAmount <= 0) { toast.error("Enter an amount to swap"); return; }
    if (balLinked && parsedAmount > fromBalanceHuman) {
      toast.error(`Insufficient balance. Max: ${fromBalanceHuman.toFixed(2)} ${fromToken}`);
      return;
    }
    haptic.impact("medium");
    setShowConfirm(true);
  };

  const handleConfirmSwap = async () => {
    setIsSwapping(true);
    try {
      // REAL swap, SERVER-SIGNED with the user's imported wallet (Privy is off).
      // The server errors clearly if they haven't imported a wallet yet.
      await swapManagedMut.mutateAsync({ fromToken, toToken, amount: parsedAmount });
      setLastSwap({
        from: `${amount} ${fromToken}`,
        to: `${estimatedOut} ${toToken}`,
        xp: 0,
        txHash: null, // swap settles asynchronously on the venue
        simulated: false,
      });
      haptic.notification("success");
    } catch (err) {
      setIsSwapping(false);
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Swap failed");
      return;
    }

    setIsSwapping(false);
    setShowConfirm(false);
    setShowSuccess(true);
    setAmount("");
  };

  const handleSelectFrom = (t: string) => {
    if (t === toToken) setToToken(fromToken);
    setFromToken(t);
    setShowFromPicker(false);
  };

  const handleSelectTo = (t: string) => {
    if (t === fromToken) setFromToken(toToken);
    setToToken(t);
    setShowToPicker(false);
  };

  // Current ticker pair — live rate from the rotated query
  const tickerPair = TICKER_PAIRS[rateIndex]!;
  const tickerQuery = tickerQueries[rateIndex]!;
  const tickerRateValue = tickerQuery.data?.rate;
  const tickerLabel = `${tickerPair[0]}/${tickerPair[1]}`;
  const tickerDisplay = tickerRateValue !== undefined ? formatRateValue(tickerRateValue, tickerPair[1]) : "—";

  const fee = parsedAmount > 0 ? (parsedAmount * 0.003).toFixed(4) : "0";
  const minReceived = parsedAmount > 0 && rateLoaded ? formatAmount(parsedAmount * rate * 0.995, toToken) : "0";

  return (
    <div className="tab-page">

      {/* ── Page Header ── */}
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="page-title">Swap</div>
          <div className="page-subtitle">the settlement venue · Sepolia Testnet</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <InfoChip topic="swap" compact />
          <div style={{
            display: "flex", alignItems: "center", gap: 5,
            background: "rgba(0,200,150,0.08)",
            border: "0.5px solid rgba(0,200,150,0.25)",
            padding: "5px 10px", borderRadius: 20,
            transition: "all 0.3s ease",
          }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: "#8E8E93" }}>{tickerLabel}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#1C1C1E" }}>{tickerDisplay}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#00C896", letterSpacing: "0.04em" }}>LIVE</span>
          </div>
        </div>
      </div>

      <div className="tab-content">

        {/* ── Live rates board (the venue CLOB) ── */}
        {(() => {
          const dirs = (liveBoardQuery.data?.directions ?? []).filter((d: any) => d.live && d.rate);
          if (dirs.length === 0) return null;
          return (
            <div style={{ marginBottom: 16, background: "#FFFFFF", borderRadius: 16, border: "0.5px solid rgba(60,60,67,0.12)", boxShadow: "0 2px 20px rgba(0,0,0,0.06)", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px 8px" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#1C1C1E" }}>Live rates</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#00C896" }}>LIVE BOOK</span>
              </div>
              <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "0 16px 14px" }}>
                {dirs.map((d: any) => (
                  <div
                    key={`${d.from}-${d.to}`}
                    onClick={() => { setFromToken(d.from); setToToken(d.to); }}
                    style={{ flex: "0 0 auto", minWidth: 104, padding: "10px 12px", borderRadius: 12, background: "rgba(0,200,150,0.06)", border: "0.5px solid rgba(0,200,150,0.18)", cursor: "pointer" }}
                  >
                    <div style={{ fontSize: 11, color: "#8E8E93", fontWeight: 600 }}>{d.from} → {d.to}</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#1C1C1E", marginTop: 2 }}>
                      {d.rate < 0.01 ? d.rate.toExponential(2) : d.rate.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* ── YOU PAY ── */}
        <div className="glass-card-elevated" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", letterSpacing: "0.02em" }}>YOU PAY</span>
            {balLinked ? (
              <button
                onClick={() => {
                  if (fromBalanceHuman <= 0) return;
                  haptic.impact("light");
                  setAmount(String(fromBalanceHuman));
                }}
                style={{ fontSize: 12, color: "#00C896", fontWeight: 600, background: "none", border: "none", cursor: fromBalanceHuman > 0 ? "pointer" : "default" }}
              >
                BAL: {fromBalanceHuman.toFixed(2)} {fromBalanceHuman > 0 && <span style={{ fontWeight: 700 }}>MAX</span>}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: "#8E8E93", fontWeight: 500 }}>
                Import a wallet to see balance
              </span>
            )}
          </div>
          <div data-tour="swap-amount" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="number" inputMode="decimal" placeholder="0.00"
              value={amount} onChange={(e) => setAmount(e.target.value)}
              style={{
                flex: 1, border: "none", outline: "none", background: "transparent",
                fontSize: 38, fontWeight: 700, color: amount ? "#1C1C1E" : "#C7C7CC",
                letterSpacing: "-0.03em", minWidth: 0, lineHeight: 1, fontFamily: "inherit",
              }}
            />
            <button
              onClick={() => { haptic.impact("light"); setShowFromPicker(true); }}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "rgba(118,118,128,0.12)", border: "none",
                borderRadius: 20, padding: "8px 12px 8px 10px",
                cursor: "pointer", flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 20 }}>{CURRENCY_FLAG[fromInfo.currency] ?? "🪙"}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>{fromToken}</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 3.5L5 6.5L8 3.5" stroke="#8E8E93" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <div style={{ fontSize: 12, color: "#AEAEB2", marginTop: 6 }}>{fromInfo.name}</div>
        </div>

        {/* ── FLIP ROW ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: -4, marginBottom: -4 }}>
          <button
            onClick={handleFlip}
            style={{
              width: 36, height: 36,
              background: "rgba(255,255,255,0.80)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "0.5px solid rgba(60,60,67,0.18)",
              borderRadius: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", flexShrink: 0,
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
              transform: flipAnim ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.2s ease",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M5 2L5 13M5 13L3 11M5 13L7 11" stroke="#3C3C43" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M11 14L11 3M11 3L9 5M11 3L13 5" stroke="#3C3C43" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <div style={{
            flex: 1, fontSize: 12, color: rateFlash ? "#00C896" : "#8E8E93",
            fontWeight: 500, transition: "color 0.4s ease",
          }}>
            {parsedAmount > 0
              ? `${amount} ${fromToken} → ~${estimatedOut} ${toToken}`
              : `1 ${fromToken} = ${rate.toFixed(4)} ${toToken}`}
          </div>
          <div style={{
            fontSize: 10, fontWeight: 700, color: "#00C896",
            background: rateFlash ? "rgba(0,200,150,0.20)" : "rgba(0,200,150,0.10)",
            border: "0.5px solid rgba(0,200,150,0.28)",
            padding: "3px 8px", borderRadius: 20, letterSpacing: "0.04em",
            transition: "background 0.4s ease",
          }}>LIVE</div>
        </div>

        {/* ── YOU RECEIVE ── */}
        <div className="glass-card-elevated" style={{ padding: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", letterSpacing: "0.02em" }}>YOU RECEIVE</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
            <div style={{
              flex: 1, fontSize: 38, fontWeight: 700, letterSpacing: "-0.03em",
              color: estimatedOut ? "#00C896" : "#C7C7CC", lineHeight: 1, minWidth: 0,
            }}>
              {estimatedOut || "0.00"}
            </div>
            <button
              onClick={() => { haptic.impact("light"); setShowToPicker(true); }}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "rgba(118,118,128,0.12)", border: "none",
                borderRadius: 20, padding: "8px 12px 8px 10px",
                cursor: "pointer", flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 20 }}>{CURRENCY_FLAG[toInfo.currency] ?? "🪙"}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>{toToken}</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 3.5L5 6.5L8 3.5" stroke="#8E8E93" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <div style={{ fontSize: 12, color: "#AEAEB2", marginTop: 6 }}>{toInfo.name}</div>
        </div>

        {/* ── CTA ── */}
        <button
          className="btn-primary"
          onClick={handleSwapClick}
          disabled={isSwapping || parsedAmount <= 0}
          style={{ position: "relative", overflow: "hidden" }}
        >
          {isSwapping ? (
            <>
              <span style={{
                width: 16, height: 16, borderRadius: "50%",
                border: "2px solid rgba(255,255,255,0.30)",
                borderTopColor: "#FFFFFF",
                animation: "spin 0.7s linear infinite",
                display: "inline-block", marginRight: 8,
              }} />
              Processing swap…
            </>
          ) : parsedAmount <= 0 ? "Enter Amount" : `Swap ${amount} ${fromToken} →`}
        </button>

        {/* ── Slippage / Fee Info ── */}
        {parsedAmount > 0 && (
          <div style={{
            background: "rgba(118,118,128,0.05)",
            border: "0.5px solid rgba(60,60,67,0.10)",
            borderRadius: 12, padding: "10px 14px",
            display: "flex", justifyContent: "space-between",
            fontSize: 12, color: "#8E8E93",
          }}>
            <span>Fee (0.3%): <strong style={{ color: "#1C1C1E" }}>{fee} {fromToken}</strong></span>
            <span>Min received: <strong style={{ color: "#1C1C1E" }}>{minReceived} {toToken}</strong></span>
          </div>
        )}

        {/* ── Or trade with a TRUSTED SHOP — a real changer (rep + chat), not the
            anonymous swap. Same pair, settled by the P2P burst. ── */}
        {shopsForPair.length > 0 && (
          <div>
            <div className="section-header" style={{ marginTop: 4 }}>
              <span className="section-title">OR TRADE WITH A TRUSTED SHOP</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {shopsForPair.slice(0, 4).map((s) => (
                <button
                  key={s.adId}
                  onClick={() => { haptic.impact("light"); onTradeShop?.({ fromToken: toToken, toToken: fromToken, adId: s.adId }); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
                    background: "#FFFFFF", border: "0.5px solid rgba(0,200,150,0.30)", borderRadius: 16,
                    padding: "12px 14px", boxShadow: "0 2px 12px rgba(0,0,0,0.04)", cursor: "pointer",
                  }}
                >
                  <div style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(135deg,#00C896,#00A87A)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>🏪</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.changer.name}</div>
                    <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 1 }}>
                      {s.changer.rating != null ? `⭐ ${s.changer.rating.toFixed(1)}` : "New"}
                      {s.changer.trades ? ` · ${s.changer.trades.toLocaleString()} trades` : ""}
                      {s.changer.location ? ` · ${s.changer.location}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#00936F" }}>{formatRateValue(s.rate, toToken)}</div>
                    <div style={{ fontSize: 10, color: "#AEAEB2" }}>{toToken}/{fromToken}</div>
                  </div>
                  <span style={{ color: "#00C896", fontSize: 18, fontWeight: 800, flexShrink: 0 }}>›</span>
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#AEAEB2", marginTop: 8, textAlign: "center", lineHeight: 1.4 }}>
              Trade with a real money changer you can rate &amp; chat with — instead of an anonymous swap.
            </div>
          </div>
        )}

        {/* ── YOUR BALANCES (live from trpc.dex.balances, falls back to honest empty when no API key) ── */}
        <div>
          <div className="section-header">
            <span className="section-title">YOUR BALANCES</span>
          </div>
          <div className="glass-card" style={{ overflow: "hidden" }}>
            {(() => {
              const headerCurrencies: Array<{ token: TokenSymbol; flag: string }> = [
                { token: "USDT", flag: "💵" },
                { token: "XSGD", flag: "🇸🇬" },
                { token: "MYRC", flag: "🇲🇾" },
                { token: "IDRX", flag: "🇮🇩" },
              ];
              if (!balLinked) {
                return (
                  <div style={{ padding: "20px 16px", textAlign: "center", color: "#8E8E93", fontSize: 13, lineHeight: 1.5 }}>
                    Import a wallet in the Me tab to see your balances here.
                  </div>
                );
              }
              const rows = (balancesQuery.data?.balances ?? []) as VenueBalanceRow[];
              return headerCurrencies.map((c, i, arr) => {
                const b = rows.find((x) => x.symbol === c.token);
                let human = 0;
                if (b) {
                  const decimals = b.decimals ?? 6;
                  const denom = 10n ** BigInt(decimals);
                  const total = BigInt(b.wallet_balance ?? "0") + BigInt(b.vault_available ?? "0");
                  human = Number(total / denom) + Number(total % denom) / Number(denom);
                }
                return (
                  <div key={c.token} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "14px 16px",
                    borderBottom: i < arr.length - 1 ? "0.5px solid rgba(60,60,67,0.10)" : "none",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 22 }}>{c.flag}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>{c.token}</span>
                    </div>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.01em" }}>{human.toFixed(2)}</span>
                  </div>
                );
              });
            })()}
          </div>
        </div>

        {/* ── MARKET RATES (live from the venue Frankfurter oracle, no fake change %) ── */}
        <div>
          <div className="section-header">
            <span className="section-title">MARKET RATES</span>
          </div>
          <div className="glass-card" style={{ overflow: "hidden" }}>
            {TICKER_PAIRS.map((pair, i, arr) => {
              const q = tickerQueries[i]!;
              const r = q.data?.rate;
              const pairLabel = `${pair[0]}/${pair[1]}`;
              const rateText = r !== undefined ? formatRateValue(r, pair[1]) : "—";
              return (
                <div key={pairLabel} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "13px 16px",
                  borderBottom: i < arr.length - 1 ? "0.5px solid rgba(60,60,67,0.10)" : "none",
                }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>{pairLabel}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.01em" }}>{rateText}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: r !== undefined ? "#00C896" : "#8E8E93", letterSpacing: "0.04em", minWidth: 48, textAlign: "right" }}>
                      {r !== undefined ? "LIVE" : q.isLoading ? "…" : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── YOUR RECENT TRADES (per-user, replaces hardcoded mock feed) ── */}
        <div>
          <div className="section-header">
            <span className="section-title">YOUR RECENT TRADES</span>
          </div>
          <div className="glass-card" style={{ overflow: "hidden" }}>
            {historyQuery.isLoading && (
              <div style={{ padding: "18px 16px", textAlign: "center", color: "#8E8E93", fontSize: 13 }}>
                Loading…
              </div>
            )}
            {!historyQuery.isLoading && (historyQuery.data ?? []).length === 0 && (
              <div style={{ padding: "20px 16px", textAlign: "center", color: "#8E8E93", fontSize: 13, lineHeight: 1.5 }}>
                {historyQuery.error ? "Sign in to see your trade history." : "No trades yet. Your first swap will show up here."}
              </div>
            )}
            {(historyQuery.data ?? []).slice(0, 4).map((t, i, arr) => {
              const fromAmt = Number(t.fromAmount ?? 0).toFixed(2);
              const toAmt = t.toAmount ? Number(t.toAmount).toFixed(2) : "—";
              return (
                <div key={t.id} style={{
                  padding: "13px 16px",
                  borderBottom: i < arr.length - 1 ? "0.5px solid rgba(60,60,67,0.10)" : "none",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>
                      {fromAmt} {t.fromToken} → {toAmt} {t.toToken}
                    </div>
                    <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>
                      {t.status}{t.txHash ? ` · ${t.txHash.slice(0, 8)}…` : ""}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#AEAEB2" }}>
                    {t.createdAt ? formatTimeAgo(t.createdAt) : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* ── Confirm Sheet ── */}
      <ConfirmSheet
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleConfirmSwap}
        loading={isSwapping}
        title="Confirm Swap"
        emoji="⇄"
        subtitle="the venue finds you the best rate for this swap. Please check the amount below, then tap Confirm."
        confirmLabel={isSwapping ? "Processing…" : "Confirm Swap"}
        details={[
          { label: "You pay",       value: `${amount} ${fromToken}` },
          { label: "You receive",   value: `${estimatedOut} ${toToken}`, highlight: true },
          { label: "Rate",          value: `1 ${fromToken} = ${rate.toFixed(4)} ${toToken}` },
          { label: "Fee (0.3%)",    value: `${fee} ${fromToken}` },
          { label: "Min received",  value: `${minReceived} ${toToken}` },
          { label: "Network",       value: `the settlement venue · ${isMainnetActive() ? "Mainnet" : "Sepolia"}` },
        ]}
      />

      {/* ── Success Modal ── */}
      <SuccessModal
        open={showSuccess}
        onClose={() => setShowSuccess(false)}
        title="Swap submitted"
        subtitle={lastSwap
          ? `${lastSwap.from} → ${lastSwap.to} submitted to the venue — settling on-chain now.`
          : ""}
        emoji="⇄"
        details={lastSwap ? [
          { label: "You paid",     value: lastSwap.from },
          { label: "You receive",  value: lastSwap.to },
          { label: "Status",       value: "Submitted — settling on the venue" },
        ] : []}
        ctaLabel={lastSwap?.txHash ? "View on Explorer" : "Swap Again"}
        onCta={() => {
          if (lastSwap?.txHash) {
            window.open(getExplorerUrl(lastSwap.txHash), "_blank");
          } else {
            setAmount("");
          }
        }}
      />

      <TokenPickerSheet open={showFromPicker} onClose={() => setShowFromPicker(false)} selected={fromToken} excluded={toToken} onSelect={handleSelectFrom} tokens={swapFromTokens} />
      <TokenPickerSheet open={showToPicker} onClose={() => setShowToPicker(false)} selected={toToken} excluded={fromToken} onSelect={handleSelectTo} tokens={swapToTokens} />

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
