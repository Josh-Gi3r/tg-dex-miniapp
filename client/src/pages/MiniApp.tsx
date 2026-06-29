import { useState, useEffect, useCallback, type ReactNode } from "react";
import { SplashScreen } from "@/components/SplashScreen";
import { useTelegram } from "@/contexts/TelegramContext";
import { trpc } from "@/lib/trpc";
import SwapTab from "./tabs/SwapTab";
import SendTab from "./tabs/SendTab";
import P2PTab from "./tabs/P2PTab";
import SignalsTab from "./tabs/SignalsTab";
import MeTab from "./tabs/MeTab";
import NewsTab from "./tabs/NewsTab";
import QuestsTab from "./tabs/QuestsTab";
import CashTab from "./tabs/CashTab";
import ActiveOrder from "./ActiveOrder";
import PeerOrder from "./PeerOrder";
import { Walkthrough } from "@/components/onboarding/Walkthrough";
import { WALKTHROUGHS, type WalkthroughTab } from "@/components/onboarding/walkthroughSteps";
import { VideoTour } from "@/components/onboarding/VideoTour";
import { useOnboardingState } from "@/hooks/useOnboardingState";

type Tab = "swap" | "send" | "p2p" | "cash" | "signals" | "quests" | "news" | "me";

// Tabs that have a HyperFrames explainer video (lazy-loaded from /embeds). On a
// first-time visit these auto-show the video instead of the spotlight tour; the
// "?" button re-summons whichever the tab has. Set-up-shop's video is summoned
// contextually from the maker UI, not tied to a tab. Flag namespace "video:<tab>"
// keeps the video's seen-state separate from the spotlight coach marks.
const TAB_VIDEOS: Partial<Record<Tab, { src: string; title: string }>> = {
  swap: { src: "/embeds/swap.mp4", title: "How Swap works" },
  send: { src: "/embeds/send.mp4", title: "How Send works" },
  p2p: { src: "/embeds/p2p.mp4", title: "How FX works" },
  cash: { src: "/embeds/cash.mp4", title: "How P2P works" },
};

const LEVEL_NAMES = ["Novice", "Trader", "Dealer", "Broker", "Mkt Maker", "Legend"];
const LEVEL_XP = [0, 500, 1500, 3000, 6000, 12000, 20000];

function computeXpProgress(xp: number, level: number): number {
  const curr = LEVEL_XP[level] ?? 0;
  const next = LEVEL_XP[level + 1] ?? curr + 1;
  return Math.round(((xp - curr) / (next - curr)) * 100);
}

const TABS: { id: Tab; label: string; svg: ReactNode }[] = [
  {
    id: "swap",
    label: "Swap",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <path d="M5 4v13M5 17l-2.5-2.5M5 17l2.5-2.5M17 18V5M17 5l-2.5 2.5M17 5l2.5 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: "send",
    label: "Send",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <path d="M4 18L18 4M18 4H10M18 4v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: "p2p",
    label: "FX",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <circle cx="6" cy="11" r="3.5" stroke="currentColor" strokeWidth="1.8"/>
        <circle cx="16" cy="11" r="3.5" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M9.5 11h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M11.5 9l2 2-2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  // Cash (Peer/zkP2P fiat ramp). Only shown in the nav when the feature is on
  // — see `navTabs` in the component. Kept in TABS so render code can find it.
  {
    id: "cash",
    label: "P2P",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <rect x="2.5" y="6" width="17" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.8"/>
        <circle cx="11" cy="11" r="2.3" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M5.5 9v4M16.5 9v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "signals",
    label: "Assistant",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <path d="M11 4v3M11 15v3M4 11h3M15 11h3M6.05 6.05l2.12 2.12M13.83 13.83l2.12 2.12M6.05 15.95l2.12-2.12M13.83 8.17l2.12-2.12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <circle cx="11" cy="11" r="2.5" stroke="currentColor" strokeWidth="1.8"/>
      </svg>
    ),
  },
  {
    id: "quests",
    label: "Quests",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <path d="M11 2.5l2.3 4.6 5.1.75-3.7 3.6.87 5.09L11 14.1l-4.57 2.45.87-5.09L3.6 7.85l5.1-.75L11 2.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    id: "news",
    label: "News",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <rect x="2.5" y="4.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M7 9h8M7 12.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "me",
    label: "Me",
    svg: (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <circle cx="11" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M3.5 19.5c0-4.142 3.358-7.5 7.5-7.5s7.5 3.358 7.5 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      </svg>
    ),
  },
];

export default function MiniApp() {
  const [splashDone, setSplashDone] = useState(false);
  const handleSplashComplete = useCallback(() => setSplashDone(true), []);
  const [activeTab, setActiveTab] = useState<Tab>("swap");
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null);
  // Cash ramp: the Cash tab is visible to EVERYONE (browse + see prices). The
  // real-money action buttons are gated inside CashTab (moneyEnabled).
  const [peerOrderId, setPeerOrderId] = useState<number | null>(null);
  // Cross-tab nav: Swap → "trade with a shop" opens the P2P tab focused on that
  // pair + ad. Consumed (cleared) by P2PTab once it opens the take sheet.
  const [p2pNav, setP2pNav] = useState<{ fromToken: string; toToken: string; openAdId: number } | null>(null);
  const [showImportNudge, setShowImportNudge] = useState(false);
  const [forceImport, setForceImport] = useState(false);
  const [tourTab, setTourTab] = useState<Tab | null>(null);
  const [videoTab, setVideoTab] = useState<Tab | null>(null);
  const { isCoachMarkSeen, markCoachMarkSeen } = useOnboardingState();
  // Server-side onboarding "seen" set — the durable source of truth (Telegram
  // WebView doesn't reliably keep localStorage, so tutorials replayed every open).
  const onboardingSeenQuery = trpc.onboarding.seen.useQuery(undefined, { retry: false, staleTime: Infinity });
  const markOnboardingSeen = trpc.onboarding.markSeen.useMutation();
  const isSeen = (key: string) =>
    (onboardingSeenQuery.data?.includes(key) ?? false) || isCoachMarkSeen(key);
  const markSeen = (key: string) => {
    markCoachMarkSeen(key); // local fast-path
    markOnboardingSeen.mutate({ key }); // durable
    onboardingSeenQuery.refetch();
  };
  const { isTelegramApp, haptic, user } = useTelegram();
  const { data: me } = trpc.auth.me.useQuery(undefined, { retry: false });
  const storeChatId = trpc.p2p.storeChatId.useMutation();
  const userXp = (me as any)?.xp ?? 0;
  const userLevel = (me as any)?.level ?? 0;
  const xpProgress = computeXpProgress(userXp, userLevel);
  const { data: activeOrders } = trpc.p2p.getActiveOrders.useQuery(undefined, {
    refetchInterval: 10000,
    enabled: !!me,
  });
  const activeOrderCount = activeOrders?.length ?? 0;

  useEffect(() => {
    if (isTelegramApp && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.expand?.();
      try { tg.setBackgroundColor?.("#F2F2F7"); } catch {}
      try { tg.setHeaderColor?.("#F9F9F9"); } catch {}
    }
  }, [isTelegramApp]);

  // Make this user reachable by the bot (notifications + chat hand-off). Record
  // their Telegram chat id + username once after login. Was never called, so the
  // bot couldn't message anyone.
  useEffect(() => {
    if (me && user?.id) {
      storeChatId.mutate({ telegramChatId: user.id, telegramUsername: user.username });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, user?.id]);

  // Nudge testers to import their OWN wallet. Pop on open + every 3 min UNTIL
  // they've imported (legacy auto-generated wallets still get nudged — they're
  // useless/empty). isImported comes from wallet.getOrCreate provenance.
  const walletProvenanceQuery = trpc.wallet.getOrCreate.useQuery(undefined, { retry: false });
  const isImported = Boolean(walletProvenanceQuery.data?.isImported);
  useEffect(() => {
    if (!me || walletProvenanceQuery.isLoading) return;
    if (isImported) { setShowImportNudge(false); return; }
    setShowImportNudge(true);
    const iv = setInterval(() => setShowImportNudge(true), 3 * 60 * 1000);
    return () => clearInterval(iv);
  }, [me, isImported, walletProvenanceQuery.isLoading]);

  const handleTabChange = (tab: Tab) => {
    haptic.selectionChanged();
    setActiveTab(tab);
  };

  // First-time onboarding per tab (after splash; never while the import nudge or
  // an order is up). If the tab has an explainer VIDEO, auto-show it once; else
  // fall back to the spotlight walkthrough once. Both are re-summonable via "?".
  // Distinct seen-flags ("video:<tab>" vs "<tab>") so they never double-fire.
  useEffect(() => {
    if (!splashDone || showImportNudge || activeOrderId !== null) return;
    if (videoTab || tourTab) return; // something's already open
    // Wait for the server's seen-set before deciding — otherwise we'd flash a
    // tutorial the user already watched on a prior open (localStorage is gone
    // in the TG WebView, but the server remembers).
    if (onboardingSeenQuery.data === undefined) return;
    if (TAB_VIDEOS[activeTab] && !isSeen(`video:${activeTab}`)) {
      setVideoTab(activeTab);
      return;
    }
    if (WALKTHROUGHS[activeTab as WalkthroughTab] && !isSeen(activeTab)) setTourTab(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, splashDone, showImportNudge, activeOrderId, onboardingSeenQuery.data]);

  return (
    <>
      {!splashDone && <SplashScreen onComplete={handleSplashComplete} />}
      <div style={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        width: "100%",
        maxWidth: 480,
        margin: "0 auto",
        background: "#F2F2F7",
        overflow: "hidden",
        position: "relative",
        boxSizing: "border-box",
      }}>

        {/* ── the venue Brand Header ── */}
        <div style={{
          background: "rgba(249,249,249,0.96)",
          borderBottom: "0.5px solid rgba(60,60,67,0.12)",
          padding: "10px 16px 0",
          flexShrink: 0,
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          zIndex: 20,
        }}>
          {/* Top row: logo + right-side stats */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            {/* the venue logo */}
            <img
              src={import.meta.env.VITE_APP_LOGO_URL ?? ""}
              alt="App Logo"
              style={{ height: 22, width: "auto", display: "block", objectFit: "contain" }}
            />
            {/* Right side: level badge + streak */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Level badge */}
              <div style={{
                background: "rgba(0,200,150,0.10)",
                border: "0.5px solid rgba(0,200,150,0.28)",
                color: "#00C896",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                padding: "3px 10px",
                borderRadius: 20,
                flexShrink: 0,
              }}>
                LV.{userLevel + 1} {LEVEL_NAMES[userLevel]?.toUpperCase()}
              </div>
              {/* XP count */}
              <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>
                {userXp.toLocaleString()} XP
              </span>
              {/* Streak */}
              <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>🔥 {(me as any)?.streakDays ?? 0}d</span>
              {/* Daily XP bonus */}
              {((me as any)?.dailyXpToday ?? 0) > 0 && (
                <div style={{
                  background: "rgba(0,200,150,0.10)",
                  border: "0.5px solid rgba(0,200,150,0.28)",
                  color: "#00C896",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "3px 8px",
                  borderRadius: 20,
                  letterSpacing: "0.03em",
                }}>+{(me as any)?.dailyXpToday} XP</div>
              )}
              {/* Help: re-run this page's walkthrough anytime */}
              <button
                onClick={() => {
                  haptic.impact("light");
                  if (TAB_VIDEOS[activeTab]) setVideoTab(activeTab);
                  else setTourTab(activeTab);
                }}
                aria-label="How this page works"
                style={{
                  width: 22, height: 22, borderRadius: "50%", padding: 0, flexShrink: 0,
                  border: "0.5px solid rgba(60,60,67,0.2)", background: "rgba(60,60,67,0.06)",
                  color: "#8E8E93", fontSize: 12, fontWeight: 800, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >?</button>
            </div>
          </div>
          {/* XP progress bar */}
          <div style={{ height: 2, background: "rgba(60,60,67,0.08)", overflow: "hidden", borderRadius: 1 }}>
            <div style={{
              height: "100%",
              width: `${xpProgress}%`,
              background: "linear-gradient(90deg, #00C896, #00E5AC)",
              transition: "width 0.6s ease",
              borderRadius: 1,
            }} />
          </div>
        </div>

        {/* ── Tab Content ── */}
        <div style={{ flex: 1, width: "100%", minWidth: 0, overflowY: "auto", overflowX: "hidden", position: "relative", background: "#F2F2F7" }}>
          {peerOrderId !== null ? (
            <PeerOrder rowId={peerOrderId} onBack={() => setPeerOrderId(null)} />
          ) : activeOrderId !== null ? (
            <ActiveOrder orderId={activeOrderId} onBack={() => setActiveOrderId(null)} />
          ) : (
            <>
              {activeTab === "swap"   && <SwapTab onTradeShop={(nav) => { setP2pNav({ fromToken: nav.fromToken, toToken: nav.toToken, openAdId: nav.adId }); setActiveTab("p2p"); }} />}
              {activeTab === "send"   && <SendTab />}
              {activeTab === "p2p"    && <P2PTab onOrderPlaced={(id: number) => setActiveOrderId(id)} nav={p2pNav} onNavConsumed={() => setP2pNav(null)} />}
              {activeTab === "cash"   && <CashTab onOrderCreated={(id: number) => setPeerOrderId(id)} />}
              {activeTab === "signals" && <SignalsTab onNavigate={(t) => setActiveTab(t as Tab)} />}
              {activeTab === "quests" && <QuestsTab />}
              {activeTab === "news"   && <NewsTab />}
              {activeTab === "me"     && <MeTab autoOpenImport={forceImport} />}
            </>
          )}
        </div>

        {/* ── Import-wallet nudge (until they import their own funded testnet wallet) ── */}
        {showImportNudge && !isImported && activeOrderId === null && (
          <div
            onClick={() => setShowImportNudge(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ width: "100%", maxWidth: 360, background: "#FFFFFF", borderRadius: 20, padding: "24px 20px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}
            >
              <div style={{ fontSize: 40, marginBottom: 10 }}>🔐</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#1C1C1E", marginBottom: 6 }}>Import your wallet to start</div>
              <div style={{ fontSize: 13.5, color: "#8E8E93", lineHeight: 1.5, marginBottom: 18 }}>
                Bring in your own testnet wallet — the one that already has your Sepolia ETH + claimed the venue tokens. We use it to sign your testnet trades. Nothing works until you do.
              </div>
              <button
                onClick={() => { haptic.impact("medium"); setForceImport(true); setActiveTab("me"); setShowImportNudge(false); }}
                style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: "none", background: "linear-gradient(135deg,#00C896,#00A87A)", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,200,150,0.3)" }}
              >
                Import my wallet
              </button>
              <button
                onClick={() => setShowImportNudge(false)}
                style={{ width: "100%", padding: "12px 0 0", border: "none", background: "transparent", color: "#AEAEB2", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                Later
              </button>
            </div>
          </div>
        )}

        {/* ── Bottom Tab Bar - iOS frosted glass, light ── */}
        <nav style={{
          display: "flex",
          background: "rgba(249,249,249,0.94)",
          borderTop: "0.5px solid rgba(60,60,67,0.15)",
          paddingBottom: "env(safe-area-inset-bottom, 4px)",
          flexShrink: 0,
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          zIndex: 20,
        }}>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "10px 0 8px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  gap: 3,
                  WebkitTapHighlightColor: "transparent",
                  transition: "all 0.15s ease",
                  position: "relative",
                }}
              >
                {/* Active indicator - teal dot above icon */}
                {isActive && (
                  <div style={{
                    position: "absolute",
                    top: 6,
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "#00C896",
                    boxShadow: "0 0 6px rgba(0,200,150,0.6)",
                  }} />
                )}
                <span style={{
                  color: isActive ? "#00C896" : "#AEAEB2",
                  lineHeight: 1,
                  marginTop: isActive ? 6 : 0,
                  transition: "color 0.15s ease, margin-top 0.15s ease",
                }}>
                  {tab.svg}
                </span>
                <span style={{
                  fontSize: 10,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? "#00C896" : "#AEAEB2",
                  letterSpacing: "-0.01em",
                  transition: "color 0.15s ease, font-weight 0.15s ease",
                }}>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* First-timer walkthrough (auto first visit per tab; "?" re-summons). */}
        {tourTab && WALKTHROUGHS[tourTab as WalkthroughTab] && (
          <Walkthrough
            steps={WALKTHROUGHS[tourTab as WalkthroughTab]}
            onClose={() => { markSeen(tourTab); setTourTab(null); }}
          />
        )}

        {/* First-timer explainer video (auto first visit on video tabs; "?"
            re-summons). Lazy: the MP4 only loads when this mounts. */}
        {videoTab && TAB_VIDEOS[videoTab] && (
          <VideoTour
            src={TAB_VIDEOS[videoTab]!.src}
            title={TAB_VIDEOS[videoTab]!.title}
            onClose={() => { markSeen(`video:${videoTab}`); setVideoTab(null); }}
          />
        )}
      </div>
    </>
  );
}
