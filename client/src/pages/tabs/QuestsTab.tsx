import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { useDemoGate } from "@/contexts/DemoGate";
import { useConfetti } from "@/hooks/useConfetti";
import { SuccessModal } from "@/components/SuccessModal";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { toast } from "sonner";
import { InfoChip } from "@/components/onboarding/InfoChip";

type QuestCategory = "all" | "trading" | "streak" | "social" | "partner";

const CATEGORY_LABELS: Record<QuestCategory, string> = {
  all: "All", trading: "Trading", streak: "Streak", social: "Social", partner: "Partners",
};
const CATEGORY_ICONS: Record<QuestCategory, string> = {
  all: "⚡", trading: "📈", streak: "🔥", social: "👥", partner: "🤝",
};

const STATIC_QUESTS = [
  { id: "first_swap",    category: "trading", title: "First Swap",        description: "Complete your first token swap",                  xpReward: 100,  icon: "⇄",  isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 1 },     currentValue: 0, repeatable: false },
  { id: "swap_5",        category: "trading", title: "Getting Started",   description: "Complete 5 swaps",                                xpReward: 250,  icon: "📈", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 5 },     currentValue: 0, repeatable: false },
  { id: "swap_25",       category: "trading", title: "Active Trader",     description: "Complete 25 swaps",                               xpReward: 750,  icon: "🏃", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 25 },    currentValue: 0, repeatable: false },
  { id: "volume_100",    category: "trading", title: "Century Club",      description: "Trade $100 total volume",                         xpReward: 200,  icon: "💯", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 100 },   currentValue: 0, repeatable: false },
  { id: "volume_1000",   category: "trading", title: "Grand Trader",      description: "Trade $1,000 total volume",                       xpReward: 500,  icon: "💰", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 1000 },  currentValue: 0, repeatable: false },
  { id: "volume_10000",  category: "trading", title: "Whale",             description: "Trade $10,000 total volume",                      xpReward: 2000, icon: "🐋", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 10000 }, currentValue: 0, repeatable: false },
  { id: "first_send",    category: "trading", title: "First Send",        description: "Send tokens to another wallet",                   xpReward: 150,  icon: "↗",  isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 1 },     currentValue: 0, repeatable: false },
  { id: "send_5",        category: "trading", title: "Generous Sender",   description: "Send tokens 5 times",                            xpReward: 400,  icon: "🎁", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 5 },     currentValue: 0, repeatable: false },
  { id: "first_p2p",     category: "trading", title: "FX Pioneer",       description: "Complete your first FX trade",                   xpReward: 200,  icon: "🤝", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 1 },     currentValue: 0, repeatable: false },
  { id: "p2p_5",         category: "trading", title: "FX Veteran",       description: "Complete 5 FX trades",                          xpReward: 600,  icon: "🏆", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 5 },     currentValue: 0, repeatable: false },
  { id: "streak_3",      category: "streak",  title: "3-Day Streak",      description: "Log in 3 days in a row",                         xpReward: 150,  icon: "🔥", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 3 },     currentValue: 0, repeatable: false },
  { id: "streak_7",      category: "streak",  title: "Week Warrior",      description: "Log in 7 days in a row",                         xpReward: 400,  icon: "🔥", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 7 },     currentValue: 0, repeatable: false },
  { id: "streak_30",     category: "streak",  title: "Monthly Master",    description: "Log in 30 days in a row",                        xpReward: 2000, icon: "🌟", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 30 },    currentValue: 0, repeatable: false },
  { id: "first_referral",category: "social",  title: "Spread the Word",   description: "Refer your first friend to the app",             xpReward: 500,  icon: "🔗", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 1 },     currentValue: 0, repeatable: false },
  { id: "referral_5",    category: "social",  title: "Community Builder", description: "Refer 5 friends to the app",                     xpReward: 2000, icon: "👥", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 5 },     currentValue: 0, repeatable: false },
  { id: "visit_asktian", category: "partner", title: "Seek Your Destiny", description: "Visit Asktian - web3 spiritual destiny platform", xpReward: 200,  icon: "☯️", isCompleted: false, progress: 0,   canClaim: false, requirement: { value: 1 },     currentValue: 0, repeatable: false },
  { id: "visit_youapp",  category: "partner", title: "Discover the World",description: "Explore YouApp - local experiences platform",    xpReward: 200,  icon: "🌍", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 1 },     currentValue: 0, repeatable: false },
  { id: "share_app",    category: "social",  title: "the venue Ambassador",   description: "Share the app on Telegram",                      xpReward: 100,  icon: "📣", isCompleted: false, progress: 0,    canClaim: false, requirement: { value: 1 },     currentValue: 0, repeatable: true  },
];

type StaticQuest = typeof STATIC_QUESTS[0];

export default function QuestsTab() {
  const { haptic } = useTelegram();
  const { blockIfDemo } = useDemoGate();
  const { fireXpConfetti } = useConfetti();
  const [activeCategory, setActiveCategory] = useState<QuestCategory>("all");

  // Local state to simulate quest completions for demo
  const [localCompleted, setLocalCompleted] = useState<Set<string>>(new Set());
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [successQuest, setSuccessQuest] = useState<StaticQuest | null>(null);
  const [partnerQuest, setPartnerQuest] = useState<StaticQuest | null>(null);
  const [shareConfirm, setShareConfirm] = useState(false);
  const [isPartnerLoading, setIsPartnerLoading] = useState(false);
  const [totalXpEarned, setTotalXpEarned] = useState(0);

  // Read the user record so we can surface pendingQuestXp banked during
  // the Sepolia preview. Cheap query, already cached app-wide.
  const meQuery = trpc.auth.me.useQuery(undefined, { retry: false });

  const questsQuery = trpc.quests.list.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  // Real referral code for the share link (was a fake `ref_demo` + wrong bot name).
  const referralCodeQuery = trpc.referral.getMyCode.useQuery(undefined, { retry: false });

  const claimMutation = trpc.quests.claim.useMutation({
    onSuccess: (data) => { questsQuery.refetch(); return data; },
    onError: () => {},
  });

  const claimManualMutation = trpc.quests.claimManual.useMutation({
    onSuccess: (data) => { questsQuery.refetch(); return data; },
    onError: () => {},
  });

  const rawQuests = questsQuery.data ?? STATIC_QUESTS;
  // Merge local completions for demo
  const quests = rawQuests.map((q) =>
    localCompleted.has(q.id) ? { ...q, isCompleted: true, canClaim: false } : q
  );

  const filteredQuests = activeCategory === "all"
    ? quests
    : quests.filter((q) => q.category === activeCategory);

  const totalXpAvailable = quests.filter((q) => !q.isCompleted).reduce((s, q) => s + q.xpReward, 0);
  const completedCount = quests.filter((q) => q.isCompleted).length;

  // ── Claim handler (trading / streak quests with demo simulation) ──────────
  // Server gates non-referral quests during the Sepolia preview: it still
  // records the completion and increments users.pendingQuestXp, but
  // result.gated=true so we can show the "queued for mainnet" framing
  // instead of celebrating a real XP delta.
  const handleDemoClaim = async (quest: StaticQuest) => {
    if (blockIfDemo("Quests")) return;
    if (claimingId) return;
    haptic.impact("heavy");
    setClaimingId(quest.id);

    let gated = false;
    let failed = false;
    try {
      const result = await claimMutation.mutateAsync({ questId: quest.id });
      gated = (result as { gated?: boolean })?.gated === true;
    } catch {
      failed = true; // real failure (e.g. not yet completed) — don't fake a claim
    }

    await new Promise((r) => setTimeout(r, 600));
    setClaimingId(null);
    if (failed) {
      haptic.notification("error");
      toast.error(`Couldn't claim "${quest.title}" yet — finish the quest first, then claim.`);
      return;
    }
    setLocalCompleted((prev) => new Set(Array.from(prev).concat(quest.id)));
    haptic.notification("success");
    if (gated) {
      toast("XP queued for mainnet", {
        description: `${quest.title}: +${quest.xpReward.toLocaleString()} XP saved. Credited the moment we cut over to mainnet.`,
        duration: 6000,
      });
    } else {
      setTotalXpEarned((prev) => prev + quest.xpReward);
      fireXpConfetti();
      setSuccessQuest(quest);
    }
  };

  // ── Partner quest handler ─────────────────────────────────────────────────
  // Tapping a partner opens the confirm sheet → handlePartnerConfirm opens the
  // real partner link + claims the reward. (Previously this only fired a toast,
  // leaving the real flow unreachable.)
  const handlePartnerVisit = (quest: StaticQuest) => {
    if (blockIfDemo("Quests")) return;
    haptic.impact("medium");
    setPartnerQuest(quest);
  };

  const handlePartnerConfirm = async () => {
    if (!partnerQuest) return;
    const url = partnerQuest.id === "visit_asktian" ? "https://asktian.com" : "https://youapp.ai/en-us";
    setIsPartnerLoading(true);

    // Open the link
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(url);
    } else {
      window.open(url, "_blank");
    }

    let failed = false;
    try {
      await claimManualMutation.mutateAsync({ questId: partnerQuest.id });
    } catch { failed = true; }

    await new Promise((r) => setTimeout(r, 800));
    setIsPartnerLoading(false);
    if (failed) {
      // Don't fake an XP credit when the server didn't accept the claim.
      setPartnerQuest(null);
      haptic.notification("error");
      toast.error("Couldn't credit that visit yet — open the partner, then try again.");
      return;
    }
    setLocalCompleted((prev) => new Set(Array.from(prev).concat(partnerQuest.id)));
    setTotalXpEarned((prev) => prev + partnerQuest.xpReward);
    const claimed = partnerQuest;
    setPartnerQuest(null);
    haptic.notification("success");
    fireXpConfetti();
    setSuccessQuest(claimed);
  };

  // ── Share handler ─────────────────────────────────────────────────────────
  const handleShareConfirm = async () => {
    if (blockIfDemo("Quests")) return;
    const refCode = (referralCodeQuery.data as { code?: string } | undefined)?.code;
    const link = refCode
      ? `https://t.me/your_bot_username?start=ref_${refCode}`
      : `https://t.me/your_bot_username`;
    if (window.Telegram?.WebApp?.openTelegramLink) {
      window.Telegram.WebApp.openTelegramLink(
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Join me on the app - the best FX stablecoin exchange in SEA! 🇸🇬🇲🇾🇮🇩")}`
      );
    } else {
      await navigator.clipboard.writeText(link);
      toast.success("Referral link copied to clipboard!");
    }

    try {
      await claimManualMutation.mutateAsync({ questId: "share_app" });
    } catch { /* demo */ }

    setShareConfirm(false);
    haptic.notification("success");
    fireXpConfetti();
    const shareQuest = STATIC_QUESTS.find((q) => q.id === "share_app")!;
    setTotalXpEarned((prev) => prev + shareQuest.xpReward);
    setSuccessQuest(shareQuest);
  };

  return (
    <div className="tab-page">

      {/* Page Header */}
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="page-title">Quests</div>
              <InfoChip topic="quests" compact />
            </div>
            <div className="page-subtitle">{completedCount}/{quests.length} completed</div>
          </div>
          <div style={{
            background: "rgba(0,200,150,0.08)", border: "0.5px solid rgba(0,200,150,0.25)",
            borderRadius: 14, padding: "8px 14px", textAlign: "center",
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#00C896", letterSpacing: "-0.02em" }}>
              +{totalXpAvailable.toLocaleString()}
            </div>
            <div style={{ fontSize: 10, color: "#8E8E93", marginTop: 1, letterSpacing: "0.02em" }}>XP available</div>
          </div>
        </div>
      </div>

      <div className="tab-content">

        {/* Beta / Sepolia preview banner — referral links are live; the rest
            are illustrative until mainnet cutover. */}
        <div style={{
          padding: "12px 14px",
          background: "rgba(0,122,255,0.06)",
          borderRadius: 12,
          border: "0.5px solid rgba(0,122,255,0.20)",
          fontSize: 12,
          color: "#1C1C1E",
          lineHeight: 1.55,
          marginBottom: 12,
        }}>
          <div style={{ fontWeight: 700, color: "#007AFF", marginBottom: 4 }}>
            Sepolia Testnet preview
          </div>
          <div style={{ color: "#3C3C43" }}>
            Quests, XP and partner offers are part of our beta showcase. Earn XP now — non-referral rewards bank to your account and credit on mainnet cutover. Referral links are already live.
          </div>
        </div>

        {/* Banked XP — visible only when the user has progress waiting */}
        {((meQuery.data as { pendingQuestXp?: number } | null)?.pendingQuestXp ?? 0) > 0 && (
          <div style={{
            padding: "10px 14px",
            background: "rgba(0,200,150,0.06)",
            borderRadius: 12,
            border: "0.5px solid rgba(0,200,150,0.25)",
            fontSize: 12,
            color: "#1C1C1E",
            lineHeight: 1.55,
            marginBottom: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <div>
              <div style={{ fontWeight: 700, color: "#00A07A" }}>
                {((meQuery.data as { pendingQuestXp?: number } | null)?.pendingQuestXp ?? 0).toLocaleString()} XP queued
              </div>
              <div style={{ color: "#3C3C43", fontSize: 11 }}>
                Credited automatically when we cut over to mainnet.
              </div>
            </div>
          </div>
        )}

        {/* XP earned banner (shows after first claim) */}
        {totalXpEarned > 0 && (
          <div style={{
            background: "linear-gradient(135deg, #00C896, #00A87A)",
            borderRadius: 14, padding: "12px 16px",
            display: "flex", alignItems: "center", gap: 12,
            boxShadow: "0 4px 20px rgba(0,200,150,0.30)",
          }}>
            <div style={{ fontSize: 28 }}>⚡</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#FFFFFF", letterSpacing: "-0.01em" }}>
                {totalXpEarned.toLocaleString()} XP earned this session
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.80)", marginTop: 2 }}>
                Keep completing quests to level up faster!
              </div>
            </div>
          </div>
        )}

        {/* XP intro banner (shows before any claim) */}
        {totalXpEarned === 0 && (
          <div style={{
            background: "linear-gradient(135deg, rgba(0,200,150,0.10) 0%, rgba(0,200,150,0.04) 100%)",
            border: "0.5px solid rgba(0,200,150,0.20)", borderRadius: 16,
            padding: "16px 18px", display: "flex", alignItems: "center", gap: 16,
          }}>
            <div style={{ fontSize: 36 }}>⚡</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.01em", marginBottom: 4 }}>
                Complete quests to earn XP
              </div>
              <div style={{ fontSize: 12, color: "#8E8E93", lineHeight: 1.5 }}>
                Trade, send, refer friends, and engage with the venue partners to level up faster.
              </div>
            </div>
          </div>
        )}

        {/* Category Filter */}
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
          {(Object.keys(CATEGORY_LABELS) as QuestCategory[]).map((cat) => {
            const isActive = activeCategory === cat;
            const catQuests = cat === "all" ? quests : quests.filter((q) => q.category === cat);
            const catCompleted = catQuests.filter((q) => q.isCompleted).length;
            return (
              <button
                key={cat}
                onClick={() => { haptic.selectionChanged(); setActiveCategory(cat); }}
                style={{
                  flexShrink: 0, display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px", borderRadius: 20,
                  border: isActive ? "0.5px solid rgba(0,200,150,0.40)" : "0.5px solid rgba(60,60,67,0.15)",
                  background: isActive ? "rgba(0,200,150,0.10)" : "rgba(255,255,255,0.80)",
                  cursor: "pointer", fontSize: 12,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? "#00C896" : "#3C3C43",
                  transition: "all 0.15s ease",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <span style={{ fontSize: 14 }}>{CATEGORY_ICONS[cat]}</span>
                <span>{CATEGORY_LABELS[cat]}</span>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: isActive ? "#00C896" : "#AEAEB2",
                  background: isActive ? "rgba(0,200,150,0.12)" : "rgba(118,118,128,0.10)",
                  padding: "1px 6px", borderRadius: 10,
                }}>
                  {catCompleted}/{catQuests.length}
                </span>
              </button>
            );
          })}
        </div>

        {/* Quest Cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredQuests.map((quest) => {
            const progressPct = Math.min((quest.progress ?? 0) * 100, 100);
            const isPartner = quest.category === "partner";
            const isManual = isPartner || quest.id === "share_app";
            const isClaiming = claimingId === quest.id;

            return (
              <div
                key={quest.id}
                style={{
                  background: quest.isCompleted ? "rgba(0,200,150,0.04)" : "#FFFFFF",
                  border: quest.isCompleted ? "0.5px solid rgba(0,200,150,0.20)" : "0.5px solid rgba(60,60,67,0.12)",
                  borderRadius: 16, padding: "16px",
                  boxShadow: quest.isCompleted ? "none" : "0 2px 12px rgba(0,0,0,0.05)",
                  opacity: quest.isCompleted ? 0.75 : 1,
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                  {/* Icon */}
                  <div style={{
                    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                    background: quest.isCompleted
                      ? "rgba(0,200,150,0.10)"
                      : isPartner ? "rgba(139,92,246,0.08)" : "rgba(0,200,150,0.06)",
                    border: quest.isCompleted
                      ? "0.5px solid rgba(0,200,150,0.25)"
                      : isPartner ? "0.5px solid rgba(139,92,246,0.20)" : "0.5px solid rgba(0,200,150,0.15)",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
                  }}>
                    {quest.isCompleted ? "✓" : quest.icon}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: quest.isCompleted ? "#8E8E93" : "#1C1C1E", letterSpacing: "-0.01em" }}>
                        {quest.title}
                      </div>
                      <div style={{
                        fontSize: 12, fontWeight: 700,
                        color: quest.isCompleted ? "#8E8E93" : "#00C896",
                        background: quest.isCompleted ? "rgba(118,118,128,0.08)" : "rgba(0,200,150,0.10)",
                        border: quest.isCompleted ? "0.5px solid rgba(118,118,128,0.15)" : "0.5px solid rgba(0,200,150,0.25)",
                        padding: "3px 10px", borderRadius: 20, flexShrink: 0, marginLeft: 8,
                      }}>
                        +{quest.xpReward} XP
                      </div>
                    </div>

                    <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: quest.isCompleted ? 0 : 10, lineHeight: 1.45 }}>
                      {quest.description}
                    </div>

                    {/* Progress bar */}
                    {!quest.isCompleted && !isManual && (
                      <>
                        <div style={{ height: 4, background: "rgba(60,60,67,0.08)", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
                          <div style={{
                            height: "100%", width: `${progressPct}%`,
                            background: progressPct >= 100
                              ? "linear-gradient(90deg, #00C896, #00E5AC)"
                              : "linear-gradient(90deg, #4A90D9, #6BAED6)",
                            borderRadius: 2, transition: "width 0.4s ease",
                          }} />
                        </div>
                        <div style={{ fontSize: 11, color: "#AEAEB2", display: "flex", justifyContent: "space-between" }}>
                          <span>{quest.currentValue?.toLocaleString() ?? 0} / {quest.requirement.value.toLocaleString()}</span>
                          <span>{Math.round(progressPct)}%</span>
                        </div>
                      </>
                    )}

                    {/* Action buttons */}
                    {!quest.isCompleted && (
                      <div style={{ marginTop: 10 }}>
                        {/* Regular claim (trading/streak) */}
                        {!isManual && (
                          <button
                            onClick={() => handleDemoClaim(quest as StaticQuest)}
                            disabled={isClaiming}
                            style={{
                              width: "100%", padding: "10px", borderRadius: 10, border: "none",
                              background: isClaiming
                                ? "rgba(0,200,150,0.40)"
                                : "linear-gradient(135deg, #00C896, #00A87A)",
                              color: "#FFFFFF", fontSize: 13, fontWeight: 700, cursor: isClaiming ? "default" : "pointer",
                              boxShadow: isClaiming ? "none" : "0 4px 12px rgba(0,200,150,0.30)",
                              transition: "all 0.15s ease",
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                            }}
                          >
                            {isClaiming ? (
                              <>
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ animation: "spin 1s linear infinite" }}>
                                  <circle cx="7" cy="7" r="5" stroke="#fff" strokeWidth="2" strokeDasharray="16 8"/>
                                </svg>
                                Claiming…
                              </>
                            ) : `Claim +${quest.xpReward} XP`}
                          </button>
                        )}

                        {/* Partner: Asktian */}
                        {isPartner && quest.id === "visit_asktian" && (
                          <button
                            onClick={() => handlePartnerVisit(quest as StaticQuest)}
                            style={{
                              width: "100%", padding: "10px", borderRadius: 10,
                              border: "0.5px solid rgba(139,92,246,0.30)",
                              background: "rgba(139,92,246,0.08)", color: "#8B5CF6",
                              fontSize: 13, fontWeight: 700, cursor: "pointer",
                              transition: "all 0.15s ease",
                            }}
                          >
                            ☯️ Visit Asktian & Claim +{quest.xpReward} XP
                          </button>
                        )}

                        {/* Partner: YouApp */}
                        {isPartner && quest.id === "visit_youapp" && (
                          <button
                            onClick={() => handlePartnerVisit(quest as StaticQuest)}
                            style={{
                              width: "100%", padding: "10px", borderRadius: 10,
                              border: "0.5px solid rgba(0,200,150,0.30)",
                              background: "rgba(0,200,150,0.08)", color: "#00C896",
                              fontSize: 13, fontWeight: 700, cursor: "pointer",
                              transition: "all 0.15s ease",
                            }}
                          >
                            🌍 Visit YouApp & Claim +{quest.xpReward} XP
                          </button>
                        )}

                        {/* Share quest */}
                        {quest.id === "share_app" && (
                          <button
                            onClick={() => { haptic.impact("light"); setShareConfirm(true); }}
                            style={{
                              width: "100%", padding: "10px", borderRadius: 10,
                              border: "0.5px solid rgba(0,200,150,0.30)",
                              background: "rgba(0,200,150,0.08)", color: "#00C896",
                              fontSize: 13, fontWeight: 700, cursor: "pointer",
                              transition: "all 0.15s ease",
                            }}
                          >
                            📣 Share the app & Claim +{quest.xpReward} XP
                          </button>
                        )}
                      </div>
                    )}

                    {quest.isCompleted && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#00C896", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                        <span>✓</span>
                        <span>Completed{quest.repeatable ? " · Repeatable daily" : ""}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ height: 8 }} />
      </div>

      {/* Partner Visit Confirm Sheet */}
      <ConfirmSheet
        open={!!partnerQuest}
        onClose={() => setPartnerQuest(null)}
        onConfirm={handlePartnerConfirm}
        loading={isPartnerLoading}
        title={partnerQuest?.id === "visit_asktian" ? "Visit Asktian" : "Visit YouApp"}
        emoji={partnerQuest?.id === "visit_asktian" ? "☯️" : "🌍"}
        subtitle={
          partnerQuest?.id === "visit_asktian"
            ? "You'll be taken to Asktian - a web3 spiritual destiny platform. After visiting, your XP will be credited automatically."
            : "You'll be taken to YouApp - a local experiences platform. After visiting, your XP will be credited automatically."
        }
        confirmLabel={isPartnerLoading ? "Crediting XP…" : `Visit & Earn +${partnerQuest?.xpReward ?? 0} XP`}
        details={[
          { label: "Partner",     value: partnerQuest?.id === "visit_asktian" ? "Asktian" : "YouApp" },
          { label: "XP reward",   value: `+${partnerQuest?.xpReward ?? 0} XP` },
          { label: "Action",      value: "Visit website" },
        ]}
      />

      {/* Share Confirm Sheet */}
      <ConfirmSheet
        open={shareConfirm}
        onClose={() => setShareConfirm(false)}
        onConfirm={handleShareConfirm}
        loading={false}
        title="Share the app"
        emoji="📣"
        subtitle="Share your referral link on Telegram and earn XP. This quest is repeatable - share daily to keep earning!"
        confirmLabel="Share & Earn XP"
        details={[
          { label: "XP reward",   value: "+100 XP" },
          { label: "Repeatable",  value: "Yes - daily" },
          { label: "Platform",    value: "Telegram" },
        ]}
      />

      {/* Quest Success Modal */}
      <SuccessModal
        open={!!successQuest}
        onClose={() => setSuccessQuest(null)}
        title="Quest Complete!"
        subtitle={successQuest?.description ?? ""}
        xpAwarded={successQuest?.xpReward ?? 0}
        emoji={successQuest?.icon ?? "⚡"}
        details={[
          { label: "Quest",       value: successQuest?.title ?? "" },
          { label: "XP earned",   value: `+${successQuest?.xpReward ?? 0} XP` },
          { label: "Category",    value: successQuest?.category ?? "" },
          { label: "Total earned",value: `${totalXpEarned.toLocaleString()} XP this session` },
        ]}
        ctaLabel="Keep Going!"
        onCta={() => setSuccessQuest(null)}
      />

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
