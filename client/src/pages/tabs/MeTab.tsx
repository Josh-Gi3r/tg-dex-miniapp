import { useState, useEffect } from "react";
import { useTelegram } from "@/contexts/TelegramContext";
import { useDemoGate } from "@/contexts/DemoGate";
import { VideoTour } from "@/components/onboarding/VideoTour";
import { trpc } from "@/lib/trpc";
import { useConfetti } from "@/hooks/useConfetti";
import { SuccessModal } from "@/components/SuccessModal";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { toast } from "sonner";
// QR code generation: use the main qrcode package (has @types/qrcode)
import QRCode from "qrcode";
import { useVenueWallet } from "@/lib/privy/useEmbeddedWallet";
import { useWallet } from "@/contexts/WalletContext";
import { isMainnetActive, TESTNET_TRADEABLE_SYMBOLS } from "@shared/venue-config";
import { runMarketMakerSetup, OrderPlacementFailedError } from "@/lib/dex/marketMaker";
import { runPurchasePromotion } from "@/lib/dex/promotion";
import { runWithdraw } from "@/lib/dex/withdraw";
import { provisionDexApiKey } from "@/lib/dex/apiKey";
import { resolveToken, toRawAmount } from "@/lib/dex/tokens";
import { EarnSection } from "@/pages/sections/EarnSection";

const LEVEL_INFO = [
  { level: "novice",       label: "Novice",      emoji: "🌱", xpNeeded: 500,     color: "#8A8D96" },
  { level: "trader",       label: "Trader",       emoji: "📈", xpNeeded: 2000,    color: "#4A90D9" },
  { level: "dealer",       label: "Dealer",       emoji: "💼", xpNeeded: 5000,    color: "#00C896" },
  { level: "broker",       label: "Broker",       emoji: "🏦", xpNeeded: 15000,   color: "#D4A017" },
  { level: "market_maker", label: "Market Maker", emoji: "⚡", xpNeeded: 50000,   color: "#E05252" },
  { level: "legend",       label: "Legend",       emoji: "👑", xpNeeded: Infinity, color: "#9B59B6" },
];

function getLevelInfo(xp: number) {
  for (let i = LEVEL_INFO.length - 1; i >= 0; i--) {
    if (xp >= (LEVEL_INFO[i - 1]?.xpNeeded ?? 0)) {
      return { current: LEVEL_INFO[i]!, next: LEVEL_INFO[i + 1] ?? null, prevXp: LEVEL_INFO[i - 1]?.xpNeeded ?? 0 };
    }
  }
  return { current: LEVEL_INFO[0]!, next: LEVEL_INFO[1] ?? null, prevXp: 0 };
}

type MeSection = "profile" | "wallet" | "changer" | "earn" | "history";

const ALL_BADGES = [
  { emoji: "🐦", name: "Early Bird",      desc: "Joined in the first wave",  earned: true  },
  { emoji: "🦁", name: "Lion City",       desc: "Traded XSGD 10×",           earned: true  },
  { emoji: "🏆", name: "Level 10 Trader", desc: "Reached Trader rank",        earned: true  },
  { emoji: "🐯", name: "Harimau",         desc: "Trade MYRC 10×",             earned: false },
  { emoji: "🦅", name: "Garuda",          desc: "Trade IDR 10×",              earned: false },
  { emoji: "🎯", name: "Arb Hunter",      desc: "Triangular arb",             earned: false },
  { emoji: "👑", name: "Volume King",     desc: "Top 10 monthly",             earned: false },
  { emoji: "⭐", name: "5-Star",          desc: "Maintain 4.9+ rating",       earned: false },
  { emoji: "⚡", name: "Speed Demon",     desc: "Release in <1 min",          earned: false },
  { emoji: "🔥", name: "Hot Streak",      desc: "7-day trading streak",       earned: false },
  { emoji: "💎", name: "Diamond Hands",   desc: "Hold 30 days",               earned: false },
  { emoji: "🌏", name: "SEA Trader",      desc: "Trade all 3 currencies",     earned: false },
];

const PROMO_TIERS = [
  { tier: "Pinned",      emoji: "📌", desc: "Always at top of Shop list",   price: "5 USDT/day",  color: "#D4A017" },
  { tier: "Highlighted", emoji: "✨", desc: "Gold border + featured badge", price: "2 USDT/day",  color: "#4A90D9" },
  { tier: "Boosted",     emoji: "🚀", desc: "Appear in swap suggestions",   price: "1 USDT/day",  color: "#00C896" },
];

// Paid boosts move real USDT to the treasury. The real path (server-signed
// dex.sendToken → treasury + on-chain payment verification + APP_TREASURY_WALLET)
// is NOT wired yet, so we HIDE the block rather than ship dead/unverified-payment
// buttons. Flip to true once the treasury payment + verification is wired.
const PROMOTIONS_ENABLED = false;

export default function MeTab({ autoOpenImport = false }: { autoOpenImport?: boolean } = {}) {
  const { user: telegramUser, haptic } = useTelegram();
  const { fireXpConfetti, fireSwapConfetti } = useConfetti();
  const [section, setSection] = useState<MeSection>("profile");

  // Wallet state
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [showImportFlow, setShowImportFlow] = useState(false);
  const [importAddress, setImportAddress] = useState("");
  const [importError, setImportError] = useState("");
  const [showImportSuccess, setShowImportSuccess] = useState(false);

  // Private-key paste import (TESTNET ONLY)
  const [showPrivateKeyFlow, setShowPrivateKeyFlow] = useState(false);
  const [importPrivateKey, setImportPrivateKey] = useState("");
  const [privateKeyError, setPrivateKeyError] = useState("");
  const importPrivateKeyMutation = trpc.wallet.importPrivateKey.useMutation({
    onSuccess: (res) => {
      setShowImportSuccess(true);
      setShowPrivateKeyFlow(false);
      setImportPrivateKey("");
      setPrivateKeyError("");
      void res;
      trpcUtils.wallet.getOrCreate.invalidate();
      trpcUtils.wallet.fundStatus.invalidate();
    },
    onError: (err) => {
      setPrivateKeyError(err.message);
    },
  });
  // Poll the testnet auto-fund job kicked off by import. Polls every 4s while
  // "funding", stops once "ready" or errored.
  const fundStatusQuery = trpc.wallet.fundStatus.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.status === "funding" ? 4000 : false),
  });
  const fundStatus = fundStatusQuery.data?.status ?? null;
  // The import-wallet popup (MiniApp) deep-links here — auto-open the import form.
  useEffect(() => {
    if (autoOpenImport && !isMainnetActive()) setShowPrivateKeyFlow(true);
  }, [autoOpenImport]);

  const handlePrivateKeySubmit = () => {
    setPrivateKeyError("");
    const trimmed = importPrivateKey.trim();
    if (!/^(0x)?[a-fA-F0-9]{64}$/.test(trimmed)) {
      setPrivateKeyError("Private key must be 64 hex characters (with or without 0x prefix).");
      return;
    }
    importPrivateKeyMutation.mutate({ privateKey: trimmed });
  };

  // Changer setup modal (position model)
  const [showChangerModal, setShowChangerModal] = useState(false);
  const [changerStep, setChangerStep] = useState(0);
  const [changerLoading, setChangerLoading] = useState(false);
  const [changerDone, setChangerDone] = useState(false);
  // Position model state
  const [posPayToken, setPosPayToken] = useState("USDT");
  const [posWantToken, setPosWantToken] = useState("XSGD");
  const [posRate, setPosRate] = useState("");
  const [posLiquidity, setPosLiquidity] = useState("");
  const [posTerms, setPosTerms] = useState("");

  // Promo activation
  const [promoTier, setPromoTier] = useState<typeof PROMO_TIERS[0] | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoSuccess, setPromoSuccess] = useState<typeof PROMO_TIERS[0] | null>(null);

  // Badges — real earned-state from the server (was hardcoded + tap-to-demo-unlock).
  const [unlockedBadge, setUnlockedBadge] = useState<typeof ALL_BADGES[0] | null>(null);
  const myBadgesQuery = trpc.leaderboard.getMyBadges.useQuery(undefined, { retry: false });

  // Referral
  const [referralCopied, setReferralCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);

  // Social links
  const [showSocialSheet, setShowSocialSheet] = useState(false);
  const [activeSocialPlatform, setActiveSocialPlatform] = useState<"x"|"whatsapp"|"gmail"|"instagram"|"linkedin"|null>(null);
  const [socialHandleInput, setSocialHandleInput] = useState("");
  const [socialLinkLoading, setSocialLinkLoading] = useState(false);
  const [socialXpReward, setSocialXpReward] = useState<{platform:string;xp:number;points:number}|null>(null);

  const meQuery = trpc.auth.me.useQuery();
  const historyQuery = trpc.swap.getHistory.useQuery({ limit: 20 });
  const walletQuery = trpc.wallet.getOrCreate.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });

  // Privy / the venue live-mode plumbing. When Privy isn't configured (missing
  // appId or feature flag off), `venueWallet.isReady` stays false and all
  // orchestrator calls are skipped — the legacy demo handlers run instead.
  const venueWallet = useVenueWallet();
  const trpcUtils = trpc.useUtils();
  const dexTokensQuery = trpc.dex.tokens.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const bootstrapQuery = trpc.dex.bootstrap.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const venueLiveMode =
    venueWallet.isReady && venueWallet.isAuthenticated && !!venueWallet.address;
  const postAdMutation = trpc.p2p.postAd.useMutation();
  const postAdLiveMutation = trpc.p2p.postAdLive.useMutation();
  const withdrawMut = trpc.dex.withdraw.useMutation();
  const { blockIfDemo } = useDemoGate();
  const [showShopVideo, setShowShopVideo] = useState(false);
  // Live vault + wallet balances (real — replaces the old hardcoded "-" list).
  const meBalancesQuery = trpc.dex.balances.useQuery(undefined, { staleTime: 30_000, retry: false });

  // Withdraw section state
  const [withdrawToken, setWithdrawToken] = useState("USDT");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawTxHash, setWithdrawTxHash] = useState<string | null>(null);

  // the venue API key provisioning
  const hasVenueKeyQuery = trpc.dex.hasApiKey.useQuery(undefined, {
    enabled: venueLiveMode,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [provisionLoading, setProvisionLoading] = useState(false);
  const handleProvisionVenueKey = async () => {
    if (!venueLiveMode) return;
    setProvisionLoading(true);
    try {
      haptic.impact("medium");
      await provisionDexApiKey({
        wallet: venueWallet,
        utils: trpcUtils,
      });
      await hasVenueKeyQuery.refetch();
      haptic.notification("success");
      toast.success("the venue API key created — you're set up to deposit, withdraw, and view balances");
    } catch (err) {
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setProvisionLoading(false);
    }
  };

  // Surface the most-recent live action's status for the user
  const [makerStep, setMakerStep] = useState<string | null>(null);
  const referralCodeQuery = trpc.referral.getMyCode.useQuery(undefined, { retry: false });
  const referralStatsQuery = trpc.referral.getStats.useQuery(undefined, { retry: false });
  const pointsQuery = trpc.referral.getPointsHistory.useQuery({ limit: 10 }, { retry: false });
  const socialLinksQuery = trpc.social.list.useQuery(undefined, { retry: false });
  const socialLinkMutation = trpc.social.link.useMutation({
    onSuccess: (data) => {
      setSocialLinkLoading(false);
      socialLinksQuery.refetch();
      meQuery.refetch();
      if (data.isFirstLink) {
        setSocialXpReward({ platform: activeSocialPlatform!, xp: data.xpAwarded, points: data.pointsAwarded });
        if (data.xpAwarded > 0) fireXpConfetti();
        haptic.notification("success");
      } else {
        haptic.notification("success");
        toast.success("Handle updated!");
      }
      setShowSocialSheet(false);
      setSocialHandleInput("");
      setActiveSocialPlatform(null);
    },
    onError: (err) => {
      setSocialLinkLoading(false);
      toast.error(err.message);
    },
  });
  const socialUnlinkMutation = trpc.social.unlink.useMutation({
    onSuccess: () => { socialLinksQuery.refetch(); toast.success("Account unlinked."); },
  });
  const importWalletMutation = trpc.wallet.importWallet.useMutation({
    onSuccess: () => {
      setShowImportFlow(false);
      setImportAddress("");
      walletQuery.refetch();
      haptic.notification("success");
      fireSwapConfetti();
      setShowImportSuccess(true);
    },
    onError: (err) => setImportError(err.message),
  });

  const dbUser = meQuery.data;
  const realXP = dbUser?.xp ?? 0;
  const { current: lvl, next: nextLvl, prevXp } = getLevelInfo(realXP);
  const xpProgress = nextLvl ? (realXP - prevXp) / (nextLvl.xpNeeded - prevXp) : 1;

  const walletData = walletQuery.data;
  // Fall back to walletAddress from auth.me (already in session) so it shows immediately
  const walletAddress = walletData?.address ?? (dbUser as any)?.walletAddress ?? null;

  const rawHistory = historyQuery.data ?? [];
  // Real history only — no cosmetic fallback. Empty → honest empty state below.
  const history = rawHistory.map((tx: any) => ({
    id: tx.id, type: tx.type ?? "swap",
    from: `${tx.fromAmount} ${tx.fromToken}`, to: `${tx.toAmount} ${tx.toToken}`,
    time: new Date(tx.createdAt).toLocaleDateString(), status: tx.status ?? "completed",
  }));

  const handleCopyAddress = () => {
    if (!walletAddress) return;
    haptic.notification("success");
    navigator.clipboard.writeText(walletAddress);
    setCopiedAddress(true);
    toast.success("Address copied!", { description: "Wallet address is in your clipboard." });
    setTimeout(() => setCopiedAddress(false), 2000);
  };

  // Real referral link from the server (or fallback demo link)
  const referralUrl = referralCodeQuery.data?.url
    ?? `https://t.me/your_bot_username?start=ref_demo`;
  const referralCode = referralCodeQuery.data?.code ?? null;
  const referralEnabled = referralCodeQuery.data?.isEnabled ?? false;
  const referralStats = referralStatsQuery.data;
  const pointsBalance = pointsQuery.data?.balance ?? (dbUser as any)?.points ?? 0;

  // Generate QR code whenever the URL changes
  useEffect(() => {
    if (!referralUrl) return;
    QRCode.toDataURL(referralUrl, {
      width: 200,
      margin: 2,
      color: { dark: "#1C1C1E", light: "#FFFFFF" },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(null));
  }, [referralUrl]);

  const handleReferral = async () => {
    haptic.impact("medium");
    const shareText = "Join me on the app \u2014 the best FX stablecoin exchange in Southeast Asia! \ud83c\uddf8\ud83c\uddec\ud83c\uddf2\ud83c\uddfe\ud83c\uddee\ud83c\udde9";
    if (window.Telegram?.WebApp?.openTelegramLink) {
      window.Telegram.WebApp.openTelegramLink(
        `https://t.me/share/url?url=${encodeURIComponent(referralUrl)}&text=${encodeURIComponent(shareText)}`
      );
    } else {
      await navigator.clipboard.writeText(referralUrl);
      setReferralCopied(true);
      setTimeout(() => setReferralCopied(false), 2500);
      toast.success("Referral link copied!", { description: "Share it with friends to earn points." });
    }
    fireXpConfetti();
  };

  const handleCopyReferralLink = async () => {
    haptic.impact("light");
    await navigator.clipboard.writeText(referralUrl);
    setReferralCopied(true);
    setTimeout(() => setReferralCopied(false), 2500);
    toast.success("Referral link copied!");
  };

  const openLink = (url: string) => {
    haptic.impact("light");
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(url);
    } else {
      window.open(url, "_blank");
    }
  };

  const handleImportSubmit = () => {
    setImportError("");
    if (!/^0x[a-fA-F0-9]{40}$/.test(importAddress)) {
      setImportError("Invalid Ethereum address. Must start with 0x followed by 40 hex characters.");
      haptic.notification("error");
      return;
    }
    importWalletMutation.mutate({ address: importAddress });
  };

  // Hardcoded fallback rates — used only if the venue's /fx/rate is unavailable
  // (e.g. on Sepolia where some FX pairs have no provider data).
  // The UI prefers the live rate from trpc.swap.getRate.
  const FALLBACK_RATES: Record<string, Record<string, number>> = {
    USDT:  { XSGD: 1.3621, MYRC: 4.4815, IDRX: 16250, IDRT: 16250, XIDR: 16250, TNSGD: 1.3621, USDC: 1.0 },
    XSGD:  { USDT: 0.7341, MYRC: 3.2900, IDRX: 11930, IDRT: 11930, XIDR: 11930, TNSGD: 1.0, USDC: 0.7341 },
    MYRC:  { USDT: 0.2232, XSGD: 0.3040, IDRX: 3625,  IDRT: 3625,  XIDR: 3625,  TNSGD: 0.3040, USDC: 0.2232 },
    IDRX:  { USDT: 0.0000615, XSGD: 0.0000839, MYRC: 0.000276, IDRT: 1.0, XIDR: 1.0, TNSGD: 0.0000839, USDC: 0.0000615 },
    IDRT:  { USDT: 0.0000615, XSGD: 0.0000839, MYRC: 0.000276, IDRX: 1.0, XIDR: 1.0, TNSGD: 0.0000839, USDC: 0.0000615 },
    XIDR:  { USDT: 0.0000615, XSGD: 0.0000839, MYRC: 0.000276, IDRX: 1.0, IDRT: 1.0, TNSGD: 0.0000839, USDC: 0.0000615 },
    TNSGD: { USDT: 0.7341, XSGD: 1.0, MYRC: 3.2900, IDRX: 11930, IDRT: 11930, XIDR: 11930, USDC: 0.7341 },
    USDC:  { USDT: 1.0, XSGD: 1.3621, MYRC: 4.4815, IDRX: 16250, IDRT: 16250, XIDR: 16250, TNSGD: 1.3621 },
  };

  // Only the tradeable testnet set — a maker can't fund/fill an ad in a token
  // with no testnet liquidity (see TESTNET_TRADEABLE_SYMBOLS + docs/TOKENS.md).
  const ALL_POS_TOKENS = [...TESTNET_TRADEABLE_SYMBOLS];

  // Live rate from the venue's /fx/rate oracle pipeline. Auto-refetches when pair changes.
  const liveRateQuery = trpc.swap.getRate.useQuery(
    { from: posPayToken, to: posWantToken },
    {
      enabled: !!posPayToken && !!posWantToken && posPayToken !== posWantToken,
      refetchInterval: 30_000, // refresh every 30s while the modal is open
      staleTime: 15_000,
    },
  );

  // Prefer live rate when source==='live'; fall back to hardcoded table otherwise.
  const liveRate =
    liveRateQuery.data?.source === "live" && liveRateQuery.data.rate > 0
      ? liveRateQuery.data.rate
      : null;
  const marketRef = liveRate ?? FALLBACK_RATES[posPayToken]?.[posWantToken] ?? null;
  const marketRefSource: "live" | "fallback" =
    liveRate !== null ? "live" : "fallback";

  const posRateNum = parseFloat(posRate);
  const posLiqNum  = parseFloat(posLiquidity);
  const rateVsMarket = marketRef && posRateNum > 0
    ? ((posRateNum - marketRef) / marketRef * 100)
    : null;

  // Changer setup flow
  const handleChangerSetup = () => {
    if (blockIfDemo("Becoming a changer")) return;
    haptic.impact("medium");
    setChangerStep(0);
    setChangerDone(false);
    setPosPayToken("USDT");
    setPosWantToken("XSGD");
    setPosRate("");
    setPosLiquidity("");
    setPosTerms("");
    setShowChangerModal(true);
  };

  const handleChangerNext = async () => {
    // Defensive guard: button is disabled while loading, but a programmatic
    // re-call (or rapid double-click before re-render) shouldn't re-enter.
    if (changerLoading) return;
    if (changerStep === 0) {
      if (!posPayToken || !posWantToken || posPayToken === posWantToken) {
        toast.error("Select two different tokens."); return;
      }
      if (!posRate || isNaN(posRateNum) || posRateNum <= 0) {
        toast.error("Enter a valid rate."); return;
      }
      haptic.selectionChanged();
      setChangerStep(1);
    } else if (changerStep === 1) {
      if (!posLiquidity || isNaN(posLiqNum) || posLiqNum <= 0) {
        toast.error("Enter a valid liquidity amount."); return;
      }
      haptic.selectionChanged();
      setChangerStep(2);
    } else {
      haptic.impact("heavy");
      setChangerLoading(true);
      try {
        if (venueLiveMode) {
          // Live mode: run the full deposit + order placement against the venue.
          // The orchestrator persists a draft p2pAds row before any signing,
          // commits the deposit hash on broadcast success, and only flips
          // the row to active after /orders accepts. If any step fails after
          // the deposit, the row stays paused with settlementDepositTxHash set —
          // MyAdsSection surfaces a "Retry placement" CTA so funds aren't
          // stranded in the vault.
          const fromTok = resolveToken(posPayToken, dexTokensQuery.data?.tokens);
          const toTok = resolveToken(posWantToken, dexTokensQuery.data?.tokens);
          if (!fromTok && !toTok) throw new Error("Tokens unavailable for this pair");
          if (!fromTok) throw new Error(`Unknown token: ${posPayToken}`);
          if (!toTok) throw new Error(`Unknown token: ${posWantToken}`);
          const fromAmountRaw = toRawAmount(posLiquidity, fromTok.decimals);
          const toAmountHuman = (posLiqNum * posRateNum).toString();
          const toAmountRaw = toRawAmount(toAmountHuman, toTok.decimals);
          // Use server time so the signed expiration survives WebView clock skew.
          // Spec: now < expiration <= now + 365d - 300s, all relative to server time.
          const serverNow = await trpcUtils.client.dex.serverTime.query();
          const expiration = serverNow.timestamp + 30 * 24 * 60 * 60; // 30 days
          await runMarketMakerSetup({
            wallet: venueWallet,
            utils: trpcUtils,
            fromToken: fromTok.address,
            toToken: toTok.address,
            fromAmount: fromAmountRaw,
            toAmount: toAmountRaw,
            initialDepositAmount: fromAmountRaw,
            expiration,
            onStep: (step) => setMakerStep(step),
            adInputs: {
              fromTokenSymbol: posPayToken,
              toTokenSymbol: posWantToken,
              rateHuman: posRateNum,
              liquidityHuman: posLiqNum,
              minOrderHuman: Math.max(1, posLiqNum * 0.05),
              maxOrderHuman: posLiqNum,
              terms: posTerms || undefined,
            },
          });
        } else {
          // No client-side signer (imported-key testnet flow): the server
          // signs the vault deposit + real the venue order via postAdLive. This is
          // the REAL path — no cosmetic DB-only ad.
          await postAdLiveMutation.mutateAsync({
            fromToken: posPayToken,
            toToken: posWantToken,
            rate: posRateNum,
            liquidity: posLiqNum,
            minOrder: Math.max(1, posLiqNum * 0.05),
            maxOrder: posLiqNum,
            terms: posTerms || undefined,
          });
        }
        setChangerDone(true);
        haptic.notification("success");
        fireSwapConfetti();
      } catch (err) {
        haptic.notification("error");
        // Special-case the partial-failure path: the deposit landed but the
        // order didn't. Tell the user explicitly so they don't think their
        // funds disappeared, and direct them to MyAds for the retry CTA.
        if (err instanceof OrderPlacementFailedError) {
          toast.error(
            "Deposit succeeded but order placement failed. Open Browse → My Positions to retry — your funds are safe in the Vault.",
            { duration: 8000 },
          );
          // Close the modal so the user can navigate
          setShowChangerModal(false);
        } else {
          toast.error(err instanceof Error ? err.message : "Failed to go live");
        }
      } finally {
        setChangerLoading(false);
        setMakerStep(null);
      }
    }
  };

  // Tap a badge to see what it is / how it's earned (no fake unlock — earned
  // state comes from the server; you earn badges by actually hitting milestones).
  const handleBadgeTap = (badge: typeof ALL_BADGES[0]) => {
    haptic.impact("light");
    setUnlockedBadge(badge);
  };

  // Promo activation
  const handlePromoActivate = (tier: typeof PROMO_TIERS[0]) => {
    if (blockIfDemo("Promotions")) return;
    haptic.impact("medium");
    setPromoTier(tier);
  };

  const myAdsQuery = trpc.p2p.getMyAds.useQuery(undefined, {
    refetchOnWindowFocus: false,
    retry: false,
  });

  const handlePromoConfirm = async () => {
    if (!promoTier) return;
    setPromoLoading(true);
    try {
      if (venueLiveMode) {
        // Live mode: send the USDT to treasury, record on the most-recent
        // active ad. UI is currently profile-level so we promote the first
        // active ad — extending to "promote all my ads" is a follow-up.
        const ads = myAdsQuery.data ?? [];
        const targetAd = ads.find((a) => a.status === "active") ?? ads[0];
        if (!targetAd) {
          throw new Error(
            "Post a position first — promotions attach to an existing ad",
          );
        }
        const usdt = resolveToken("USDT", dexTokensQuery.data?.tokens);
        if (!usdt) throw new Error("USDT token not found");
        const priceUsdt = parseFloat(promoTier.price.replace(/[^0-9.]/g, ""));
        if (!isFinite(priceUsdt) || priceUsdt <= 0) {
          throw new Error("Invalid promotion price");
        }
        const treasury = bootstrapQuery.data?.treasuryWallet;
        if (!treasury) {
          throw new Error("Treasury wallet not configured (APP_TREASURY_WALLET)");
        }
        await runPurchasePromotion({
          wallet: venueWallet,
          utils: trpcUtils,
          usdtAddress: usdt.address,
          treasuryAddress: treasury,
          amountRaw: toRawAmount(String(priceUsdt), usdt.decimals),
          amountUsdt: String(priceUsdt),
          adId: targetAd.id,
          tier: promoTier.tier.toLowerCase() as "boosted" | "highlighted" | "pinned",
          durationHours: 24,
        });
      } else {
        // Promotions move real USDT to the treasury and aren't wired to the
        // server-signed imported-wallet path yet — don't fake a paid promo.
        throw new Error("Promotions aren't available on testnet yet — coming soon.");
      }
      const activated = promoTier;
      setPromoTier(null);
      haptic.notification("success");
      fireSwapConfetti();
      setPromoSuccess(activated);
    } catch (err) {
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Promotion failed");
    } finally {
      setPromoLoading(false);
    }
  };

  // Withdraw handler — Phase 8 dual-sig vault withdraw with demo fallback
  const handleWithdraw = async () => {
    if (blockIfDemo("Withdraw")) return;
    const amt = parseFloat(withdrawAmount);
    if (!isFinite(amt) || amt <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    setWithdrawLoading(true);
    setWithdrawTxHash(null);
    try {
      haptic.impact("medium");
      // REAL server-signed 3-step dual-sig withdraw with the imported wallet
      // (vault → your wallet). Replaces the dead Privy runWithdraw path.
      // Verified on-chain (tx 0x857b5626…).
      const result = await withdrawMut.mutateAsync({ token: withdrawToken, amount: amt });
      setWithdrawTxHash(result.txHash);
      toast.success("Withdraw broadcast");
      setWithdrawAmount("");
      haptic.notification("success");
    } catch (err) {
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Withdraw failed");
    } finally {
      setWithdrawLoading(false);
    }
  };

  const displayName = telegramUser
    ? telegramUser.username ? `@${telegramUser.username}` : telegramUser.firstName || "Me"
    : "My Profile";

  // Drive from the server when available; fall back to the static list (with
  // everything locked) before the query resolves.
  const allBadges = myBadgesQuery.data
    ? myBadgesQuery.data.map((b: any) => ({ emoji: b.emoji, name: b.name, desc: b.description, earned: b.earned }))
    : ALL_BADGES.map((b) => ({ ...b, earned: false }));

  const TOKEN_FLAGS: Record<string, string> = {
    USDT: "💵", USDC: "💵", XSGD: "🇸🇬", JPYC: "🇯🇵", EURT: "🇪🇺",
  };

  const CHANGER_STEPS = [
    {
      title: "Create Position",
      icon: "⚡",
      desc: "Choose your token pair and set your absolute rate. Takers will swap against you at exactly this rate.",
      content: (
        <div style={{ marginTop: 14 }}>
          {/* Token pair selector */}
          <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 8, fontWeight: 600 }}>I Pay → I Want</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <select
              value={posPayToken}
              onChange={(e) => { setPosPayToken(e.target.value); setPosRate(""); }}
              style={{ flex: 1, padding: "11px 12px", borderRadius: 12, border: "0.5px solid rgba(0,200,150,0.30)", background: "rgba(0,200,150,0.04)", fontSize: 15, fontWeight: 700, color: "#1C1C1E", outline: "none" }}
            >
              {ALL_POS_TOKENS.map((t) => <option key={t} value={t}>{TOKEN_FLAGS[t]} {t}</option>)}
            </select>
            <div style={{ fontSize: 18, color: "#8E8E93", fontWeight: 700 }}>→</div>
            <select
              value={posWantToken}
              onChange={(e) => { setPosWantToken(e.target.value); setPosRate(""); }}
              style={{ flex: 1, padding: "11px 12px", borderRadius: 12, border: "0.5px solid rgba(0,200,150,0.30)", background: "rgba(0,200,150,0.04)", fontSize: 15, fontWeight: 700, color: "#1C1C1E", outline: "none" }}
            >
              {ALL_POS_TOKENS.filter((t) => t !== posPayToken).map((t) => <option key={t} value={t}>{TOKEN_FLAGS[t]} {t}</option>)}
            </select>
          </div>

          {/* Rate input */}
          <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 8, fontWeight: 600 }}>Your rate (1 {posPayToken} = ? {posWantToken})</div>
          <div style={{ position: "relative" }}>
            <input
              type="number"
              inputMode="decimal"
              value={posRate}
              onChange={(e) => setPosRate(e.target.value)}
              placeholder={marketRef ? `Market: ${marketRef}` : "e.g. 1.3621"}
              style={{
                width: "100%", padding: "12px 14px", borderRadius: 12,
                border: "0.5px solid rgba(0,200,150,0.30)",
                background: "rgba(0,200,150,0.04)",
                fontSize: 18, fontWeight: 700, color: "#00C896",
                outline: "none", boxSizing: "border-box",
              }}
            />
          </div>
          {/* Market reference */}
          {marketRef && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <div style={{ fontSize: 11, color: "#AEAEB2" }}>
                Market ref: {marketRef} {posWantToken}
                {marketRefSource === "live" ? (
                  <span style={{ marginLeft: 6, color: "#00C896", fontWeight: 600 }}>● live</span>
                ) : (
                  <span style={{ marginLeft: 6, color: "#8E8E93" }}>(approx)</span>
                )}
              </div>
              {rateVsMarket !== null && posRate && (
                <div style={{
                  fontSize: 11, fontWeight: 700,
                  color: rateVsMarket > 0 ? "#FF9500" : rateVsMarket < -1 ? "#E05252" : "#00C896",
                  background: rateVsMarket > 0 ? "rgba(255,149,0,0.10)" : rateVsMarket < -1 ? "rgba(224,82,82,0.10)" : "rgba(0,200,150,0.10)",
                  padding: "2px 8px", borderRadius: 20,
                }}>
                  {rateVsMarket > 0 ? `+${rateVsMarket.toFixed(2)}% above market` : `${rateVsMarket.toFixed(2)}% below market`}
                </div>
              )}
            </div>
          )}
          {/* Quick-fill market rate */}
          {marketRef && (
            <button
              onClick={() => setPosRate(String(marketRef))}
              style={{ marginTop: 8, fontSize: 12, color: "#00C896", background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 600 }}
            >
              Use market rate →
            </button>
          )}
        </div>
      ),
    },
    {
      title: "Deposit Liquidity",
      icon: "🔒",
      desc: `Lock ${posPayToken} tokens so takers can swap against your position instantly. You can withdraw anytime.`,
      content: (
        <div style={{ marginTop: 14 }}>
          {!venueLiveMode && (
            <div style={{
              background: "rgba(255,149,0,0.06)",
              border: "0.5px solid rgba(255,149,0,0.30)",
              borderRadius: 12, padding: "12px 14px", marginBottom: 14,
              display: "flex", gap: 10, alignItems: "flex-start",
            }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>🔒</span>
              <div style={{ fontSize: 12, color: "#1C1C1E", lineHeight: 1.55 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Demo mode — no real deposit</div>
                <div style={{ color: "#8E8E93" }}>
                  Posting a real on-chain order requires a connected wallet. Use the Wallet tab to connect MetaMask or paste your address. You can still walk through the wizard to preview the flow.
                </div>
              </div>
            </div>
          )}
          <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 8, fontWeight: 600 }}>Amount to deposit ({posPayToken})</div>
          <input
            type="number"
            inputMode="decimal"
            value={posLiquidity}
            onChange={(e) => setPosLiquidity(e.target.value)}
            placeholder="e.g. 1000"
            style={{
              width: "100%", padding: "12px 14px", borderRadius: 12,
              border: "0.5px solid rgba(0,200,150,0.30)",
              background: "rgba(0,200,150,0.04)",
              fontSize: 18, fontWeight: 700, color: "#00C896",
              outline: "none", boxSizing: "border-box",
            }}
          />
          {/* Quick amounts */}
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {["100", "500", "1000", "5000", "10000"].map((amt) => (
              <button
                key={amt}
                onClick={() => { haptic.selectionChanged(); setPosLiquidity(amt); }}
                style={{
                  padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 700,
                  background: posLiquidity === amt ? "#00C896" : "rgba(0,200,150,0.10)",
                  color: posLiquidity === amt ? "#FFFFFF" : "#00C896",
                  transition: "all 0.15s ease",
                }}
              >{amt}</button>
            ))}
          </div>
          {/* What taker receives */}
          {posLiqNum > 0 && posRateNum > 0 && (
            <div style={{
              marginTop: 14, background: "rgba(0,200,150,0.06)",
              border: "0.5px solid rgba(0,200,150,0.20)",
              borderRadius: 12, padding: "12px 14px",
            }}>
              <div style={{ fontSize: 11, color: "#8E8E93", marginBottom: 6 }}>Position capacity</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E" }}>
                {posLiqNum.toLocaleString()} {posPayToken} → {(posLiqNum * posRateNum).toLocaleString(undefined, { maximumFractionDigits: 2 })} {posWantToken}
              </div>
            </div>
          )}
          {/* Optional terms */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 8, fontWeight: 600 }}>Terms (optional)</div>
            <textarea
              value={posTerms}
              onChange={(e) => setPosTerms(e.target.value)}
              placeholder="e.g. High volume preferred. Instant settlement."
              rows={2}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 10,
                border: "0.5px solid rgba(60,60,67,0.15)",
                background: "#FFFFFF", fontSize: 13, color: "#1C1C1E",
                outline: "none", resize: "none", boxSizing: "border-box",
                fontFamily: "inherit",
              }}
            />
          </div>
        </div>
      ),
    },
    {
      title: "Review & Confirm",
      icon: "📣",
      desc: "Your position will be live in the FX marketplace. Takers can swap against it at your rate.",
      content: (
        <div style={{ marginTop: 14 }}>
          <div style={{
            background: "rgba(0,200,150,0.06)", border: "0.5px solid rgba(0,200,150,0.20)",
            borderRadius: 12, padding: "14px 16px",
          }}>
            {[
              { label: "I Pay",      value: `${posLiqNum > 0 ? posLiqNum.toLocaleString() : "—"} ${posPayToken}` },
              { label: "I Want",     value: posWantToken },
              { label: "My Rate",    value: posRate ? `1 ${posPayToken} = ${posRate} ${posWantToken}` : "—" },
              { label: "Liquidity",  value: posLiqNum > 0 ? `${posLiqNum.toLocaleString()} ${posPayToken}` : "—" },
              { label: "vs Market",  value: rateVsMarket !== null && posRate ? `${rateVsMarket > 0 ? "+" : ""}${rateVsMarket.toFixed(2)}%` : "—" },
              { label: "Status",     value: "Ready to go live ✓" },
            ].map((row) => (
              <div key={row.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: "#8E8E93" }}>{row.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#1C1C1E" }}>{row.value}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#AEAEB2", marginTop: 10, lineHeight: 1.5 }}>
            By going live, you agree to lock {posLiqNum > 0 ? posLiqNum.toLocaleString() : "your"} {posPayToken} as liquidity. You can cancel your position and withdraw at any time.
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="tab-page">

      {/* Page Header */}
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 16,
            background: "rgba(0,200,150,0.10)", border: "0.5px solid rgba(0,200,150,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26,
          }}>
            {lvl.emoji}
          </div>
          <div>
            <div className="page-title" style={{ marginBottom: 2 }}>{displayName}</div>
            <div className="page-subtitle">the app Member</div>
          </div>
        </div>
      </div>

      <div className="tab-content">

        {/* Import-wallet banner — top of the Me tab until they import their OWN
            funded testnet wallet (shows for legacy auto-generated wallets too). */}
        {!walletData?.isImported && !isMainnetActive() && (
          <button
            onClick={() => { haptic.impact("medium"); setShowPrivateKeyFlow(true); }}
            style={{
              width: "100%", marginBottom: 14, padding: "16px", borderRadius: 16, border: "none",
              background: "linear-gradient(135deg,#00C896,#00A87A)", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 12, textAlign: "left",
              boxShadow: "0 6px 20px rgba(0,200,150,0.30)",
            }}
          >
            <span style={{ fontSize: 26 }}>🔐</span>
            <div style={{ flex: 1 }}>
              <div data-tour="me-import" style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>Import your wallet to start</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 2 }}>Paste the private key of the testnet wallet you already funded (Sepolia ETH + the venue tokens).</div>
            </div>
            <span style={{ color: "rgba(255,255,255,0.8)", fontSize: 18 }}>›</span>
          </button>
        )}

        {/* XP / Level Card */}
        <div className="glass-card" style={{ padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 30 }}>{lvl.emoji}</span>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: lvl.color, letterSpacing: "-0.01em" }}>{lvl.label}</div>
                <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>{realXP.toLocaleString()} XP</div>
              </div>
            </div>
            {nextLvl && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#AEAEB2", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>NEXT</div>
                <div style={{ fontSize: 14, color: nextLvl.color, fontWeight: 600 }}>{nextLvl.emoji} {nextLvl.label}</div>
              </div>
            )}
          </div>
          {nextLvl && (
            <>
              <div className="xp-bar-track">
                <div className="xp-bar-fill" style={{ width: `${Math.min(xpProgress * 100, 100)}%` }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#AEAEB2", marginTop: 6 }}>
                <span>{realXP.toLocaleString()} XP</span>
                <span>{nextLvl.xpNeeded.toLocaleString()} XP to {nextLvl.label}</span>
              </div>
            </>
          )}
        </div>

        {/* Section Tabs */}
        <div style={{ display: "flex", background: "rgba(118,118,128,0.12)", borderRadius: 10, padding: 2 }}>
          {(["profile", "wallet", "changer", "earn", "history"] as MeSection[]).map((s) => (
            <button
              key={s}
              onClick={() => { haptic.selectionChanged(); setSection(s); }}
              style={{
                flex: 1, height: 34, border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 600, borderRadius: 8,
                background: section === s ? "#FFFFFF" : "transparent",
                color: section === s ? "#1C1C1E" : "#8E8E93",
                boxShadow: section === s ? "0 1px 4px rgba(0,0,0,0.10)" : "none",
                transition: "all 0.15s ease",
              }}
            >
              {s === "profile" ? "Profile" : s === "wallet" ? "Wallet" : s === "changer" ? "FX" : s === "earn" ? "Earn" : "History"}
            </button>
          ))}
        </div>

        {/* ── Profile Section ── */}
        {section === "profile" && (
          <>
            {/* Badges */}
            <div>
              <div className="section-title" style={{ marginBottom: 6 }}>My Badges</div>
              <div style={{ fontSize: 11, color: "#AEAEB2", marginBottom: 10 }}>Earn badges by trading, posting offers, and hitting milestones. Tap one to see how.</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {allBadges.filter(b => b.earned).map((b) => (
                  <div key={b.name} style={{
                    padding: "8px 12px", display: "flex", alignItems: "center", gap: 8,
                    background: "rgba(0,200,150,0.06)", border: "0.5px solid rgba(0,200,150,0.25)",
                    borderRadius: 12, boxShadow: "0 2px 8px rgba(0,200,150,0.08)",
                  }}>
                    <span style={{ fontSize: 18 }}>{b.emoji}</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#1C1C1E" }}>{b.name}</div>
                      <div style={{ fontSize: 10, color: "#8E8E93" }}>{b.desc}</div>
                    </div>
                  </div>
                ))}
                {allBadges.filter(b => !b.earned).slice(0, 4).map((b) => (
                  <div
                    key={b.name}
                    onClick={() => handleBadgeTap(b)}
                    style={{
                      background: "rgba(118,118,128,0.06)", border: "0.5px dashed rgba(60,60,67,0.20)",
                      borderRadius: 12, padding: "8px 12px",
                      display: "flex", alignItems: "center", gap: 8,
                      opacity: 0.55, cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span style={{ fontSize: 18, filter: "grayscale(1)" }}>{b.emoji}</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#3C3C43" }}>{b.name}</div>
                      <div style={{ fontSize: 10, color: "#AEAEB2" }}>{b.desc}</div>
                    </div>
                  </div>
                ))}
                {allBadges.filter(b => !b.earned).length > 4 && (
                  <div style={{
                    background: "rgba(118,118,128,0.06)", border: "0.5px dashed rgba(60,60,67,0.20)",
                    borderRadius: 12, padding: "8px 14px", fontSize: 12, color: "#AEAEB2",
                    display: "flex", alignItems: "center",
                  }}>
                    +{allBadges.filter(b => !b.earned).length - 4} locked
                  </div>
                )}
              </div>
            </div>

            {/* Stats */}
            <div>
              <div className="section-title" style={{ marginBottom: 10 }}>Stats</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { label: "Swaps",     value: String(dbUser?.totalTrades ?? 0) },
                  { label: "Volume",    value: `$${Number(dbUser?.totalVolumeUsd ?? 0).toLocaleString()}` },
                  { label: "Referrals", value: String(referralStats?.totalReferrals ?? 0) },
                  { label: "Points",    value: String(pointsBalance) },
                ].map((stat) => (
                  <div key={stat.label} style={{
                    background: "#FFFFFF", borderRadius: 14,
                    border: "0.5px solid rgba(60,60,67,0.12)",
                    boxShadow: "0 2px 12px rgba(0,0,0,0.05)",
                    padding: "16px 14px", textAlign: "center",
                  }}>
                    <div style={{ fontSize: 26, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.03em" }}>{stat.value}</div>
                    <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 4 }}>{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Referral Card */}
            <div style={{
              background: "#FFFFFF",
              borderRadius: 20,
              border: "0.5px solid rgba(0,200,150,0.20)",
              boxShadow: "0 4px 20px rgba(0,200,150,0.08)",
              overflow: "hidden",
            }}>
              {/* Header */}
              <div style={{
                background: "linear-gradient(135deg, rgba(0,200,150,0.08), rgba(0,229,172,0.04))",
                borderBottom: "0.5px solid rgba(0,200,150,0.15)",
                padding: "14px 16px",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>Invite Friends</div>
                  <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>
                    Earn <span style={{ color: "#00C896", fontWeight: 700 }}>100 pts</span> per signup
                    {!referralEnabled && (
                      <span style={{
                        marginLeft: 8, fontSize: 10, fontWeight: 700,
                        background: "rgba(255,149,0,0.10)",
                        border: "0.5px solid rgba(255,149,0,0.30)",
                        color: "#FF9500", padding: "1px 7px", borderRadius: 10,
                      }}>Coming Soon</span>
                    )}
                  </div>
                </div>
                {/* Points balance pill */}
                <div style={{
                  background: "rgba(0,200,150,0.10)",
                  border: "0.5px solid rgba(0,200,150,0.28)",
                  color: "#00C896",
                  fontSize: 13, fontWeight: 700,
                  padding: "5px 12px", borderRadius: 20,
                }}>
                  {pointsBalance} pts
                </div>
              </div>

              {/* QR code + link section */}
              <div style={{ padding: "16px" }}>
                {/* Referral code display */}
                {referralCode && (
                  <div style={{
                    background: "rgba(0,200,150,0.06)",
                    border: "0.5px solid rgba(0,200,150,0.20)",
                    borderRadius: 12, padding: "10px 14px",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    marginBottom: 12,
                  }}>
                    <div>
                      <div style={{ fontSize: 10, color: "#8E8E93", marginBottom: 2 }}>Your referral code</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "#00C896", letterSpacing: "0.08em", fontFamily: "monospace" }}>
                        {referralCode}
                      </div>
                    </div>
                    <button
                      onClick={handleCopyReferralLink}
                      style={{
                        background: "rgba(0,200,150,0.10)",
                        border: "0.5px solid rgba(0,200,150,0.28)",
                        color: "#00C896", fontSize: 12, fontWeight: 700,
                        padding: "6px 14px", borderRadius: 20, cursor: "pointer",
                      }}
                    >
                      {referralCopied ? "✓ Copied" : "Copy Link"}
                    </button>
                  </div>
                )}

                {/* QR code toggle */}
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={handleReferral}
                    style={{
                      flex: 1,
                      background: "linear-gradient(135deg, #00C896, #00A87A)",
                      color: "#FFFFFF", fontSize: 14, fontWeight: 700,
                      padding: "12px", borderRadius: 14, border: "none", cursor: "pointer",
                    }}
                  >
                    🔗 Share Link
                  </button>
                  <button
                    onClick={() => setShowQr(!showQr)}
                    style={{
                      background: showQr ? "rgba(0,200,150,0.10)" : "rgba(118,118,128,0.08)",
                      border: showQr ? "0.5px solid rgba(0,200,150,0.30)" : "0.5px solid rgba(60,60,67,0.15)",
                      color: showQr ? "#00C896" : "#8E8E93",
                      fontSize: 14, fontWeight: 700,
                      padding: "12px 16px", borderRadius: 14, cursor: "pointer",
                    }}
                  >
                    QR
                  </button>
                </div>

                {/* QR code image */}
                {showQr && qrDataUrl && (
                  <div style={{ textAlign: "center", marginTop: 14 }}>
                    <img
                      src={qrDataUrl}
                      alt="Referral QR Code"
                      style={{
                        width: 160, height: 160, borderRadius: 12,
                        border: "0.5px solid rgba(60,60,67,0.12)",
                        boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
                      }}
                    />
                    <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 8 }}>
                      Scan to join the app
                    </div>
                  </div>
                )}

                {/* Referral stats */}
                {(referralStats?.totalReferrals ?? 0) > 0 && (
                  <div style={{
                    marginTop: 12,
                    background: "rgba(0,200,150,0.04)",
                    borderRadius: 12, padding: "10px 14px",
                    display: "flex", alignItems: "center", gap: 16,
                  }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: "#00C896" }}>{referralStats?.totalReferrals ?? 0}</div>
                      <div style={{ fontSize: 11, color: "#8E8E93" }}>Friends joined</div>
                    </div>
                    <div style={{ width: 1, height: 30, background: "rgba(60,60,67,0.10)" }} />
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: "#00C896" }}>{referralStats?.totalPointsFromReferrals ?? 0}</div>
                      <div style={{ fontSize: 11, color: "#8E8E93" }}>Points earned</div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Partner Promo Cards */}
            <div>
              <div className="section-title" style={{ marginBottom: 10 }}>the venue Partners</div>

              {/* Asktian */}
              <div
                onClick={() => openLink("https://asktian.com")}
                style={{
                  background: "#FFFFFF", border: "0.5px solid rgba(138,43,226,0.20)",
                  borderRadius: 18, boxShadow: "0 4px 20px rgba(138,43,226,0.08)",
                  padding: 18, cursor: "pointer", position: "relative", overflow: "hidden",
                  transition: "all 0.15s ease", marginBottom: 12,
                }}
              >
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #8B5CF6, #C084FC)", borderRadius: "18px 18px 0 0" }} />
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginTop: 6 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 14, background: "rgba(139,92,246,0.10)", border: "0.5px solid rgba(139,92,246,0.20)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>☯️</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.01em" }}>asktian</span>
                      <span style={{ background: "rgba(139,92,246,0.10)", border: "0.5px solid rgba(139,92,246,0.25)", color: "#8B5CF6", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, letterSpacing: "0.04em" }}>WEB3</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.55, marginBottom: 12 }}>
                      First web3 spiritual destiny &amp; soul growth platform. Daily fortune, soul summary, and auspicious timing - powered by Tian Protocol.
                    </div>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(139,92,246,0.08)", border: "0.5px solid rgba(139,92,246,0.20)", color: "#8B5CF6", fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 20 }}>
                      🎁 the app members get early access →
                    </div>
                  </div>
                </div>
              </div>

              {/* YouApp */}
              <div
                onClick={() => openLink("https://youapp.ai/en-us")}
                style={{
                  background: "#FFFFFF", border: "0.5px solid rgba(0,200,150,0.20)",
                  borderRadius: 18, boxShadow: "0 4px 20px rgba(0,200,150,0.08)",
                  padding: 18, cursor: "pointer", position: "relative", overflow: "hidden",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #00C896, #00A87A)", borderRadius: "18px 18px 0 0" }} />
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginTop: 6 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 14, background: "rgba(0,200,150,0.08)", border: "0.5px solid rgba(0,200,150,0.20)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>🌍</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.01em" }}>YouApp</span>
                      <span style={{ background: "rgba(0,200,150,0.10)", border: "0.5px solid rgba(0,200,150,0.25)", color: "#00C896", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, letterSpacing: "0.04em" }}>PARTNER</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.55, marginBottom: 12 }}>
                      Discover the world through local eyes. Book authentic experiences with certified local hosts - cooking, adventure, culture and more.
                    </div>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(0,200,150,0.08)", border: "0.5px solid rgba(0,200,150,0.20)", color: "#00C896", fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 20 }}>
                      🎁 Exclusive discount for the app users →
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Social Links Section ── */}
            {(() => {
              const SOCIAL_PLATFORMS = [
                { id: "x" as const,         label: "X (Twitter)",  emoji: "𝕏",  placeholder: "@yourhandle",       xp: 100, pts: 50,  color: "#000000", bg: "rgba(0,0,0,0.06)" },
                { id: "whatsapp" as const,  label: "WhatsApp",    emoji: "💬", placeholder: "+65 9123 4567",      xp: 75,  pts: 40,  color: "#25D366", bg: "rgba(37,211,102,0.08)" },
                { id: "gmail" as const,     label: "Gmail",       emoji: "✉️", placeholder: "you@gmail.com",      xp: 75,  pts: 40,  color: "#EA4335", bg: "rgba(234,67,53,0.08)" },
                { id: "instagram" as const, label: "Instagram",   emoji: "📸", placeholder: "@yourhandle",       xp: 50,  pts: 25,  color: "#E1306C", bg: "rgba(225,48,108,0.08)" },
                { id: "linkedin" as const,  label: "LinkedIn",    emoji: "💼", placeholder: "linkedin.com/in/you", xp: 50,  pts: 25,  color: "#0A66C2", bg: "rgba(10,102,194,0.08)" },
              ];
              const linkedMap = new Map((socialLinksQuery.data ?? []).map((l: any) => [l.platform, l]));
              const unlinkedCount = SOCIAL_PLATFORMS.filter(p => !linkedMap.has(p.id)).length;
              const totalXpAvailable = SOCIAL_PLATFORMS.filter(p => !linkedMap.has(p.id)).reduce((s, p) => s + p.xp, 0);

              return (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div className="section-title" style={{ marginBottom: 0 }}>Connected Accounts</div>
                    {unlinkedCount > 0 && (
                      <div style={{
                        background: "rgba(255,149,0,0.12)", border: "0.5px solid rgba(255,149,0,0.35)",
                        color: "#FF9500", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20,
                      }}>
                        +{totalXpAvailable} XP available
                      </div>
                    )}
                  </div>

                  {/* Nudge banner — shown when accounts are unlinked */}
                  {unlinkedCount > 0 && (
                    <div style={{
                      background: "linear-gradient(135deg, rgba(255,149,0,0.08), rgba(255,204,0,0.06))",
                      border: "0.5px solid rgba(255,149,0,0.25)",
                      borderRadius: 14, padding: "12px 14px",
                      marginBottom: 12,
                      display: "flex", alignItems: "center", gap: 12,
                    }}>
                      <div style={{ fontSize: 24, flexShrink: 0 }}>🔔</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E", marginBottom: 2 }}>
                          Boost your trust score
                        </div>
                        <div style={{ fontSize: 12, color: "#8E8E93", lineHeight: 1.5 }}>
                          Link {unlinkedCount} more account{unlinkedCount > 1 ? "s" : ""} to earn
                          {" "}<span style={{ color: "#FF9500", fontWeight: 700 }}>+{totalXpAvailable} XP</span> and
                          show counterparties you're real.
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Platform rows */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {SOCIAL_PLATFORMS.map((p) => {
                      const linked = linkedMap.get(p.id);
                      return (
                        <div
                          key={p.id}
                          onClick={() => {
                            haptic.impact("light");
                            setActiveSocialPlatform(p.id);
                            setSocialHandleInput(linked?.handle ?? "");
                            setShowSocialSheet(true);
                          }}
                          style={{
                            background: linked ? p.bg : "#FFFFFF",
                            border: linked ? `0.5px solid ${p.color}40` : "0.5px solid rgba(60,60,67,0.12)",
                            borderRadius: 14, padding: "12px 14px",
                            display: "flex", alignItems: "center", gap: 12,
                            cursor: "pointer",
                            boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <div style={{
                            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                            background: linked ? `${p.color}18` : "rgba(118,118,128,0.08)",
                            border: `0.5px solid ${linked ? p.color + "40" : "rgba(60,60,67,0.12)"}`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: p.id === "x" ? 14 : 18, fontWeight: 900, color: linked ? p.color : "#8E8E93",
                          }}>
                            {p.emoji}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: linked ? "#1C1C1E" : "#3C3C43" }}>{p.label}</div>
                            {linked ? (
                              <div style={{ fontSize: 12, color: p.color, marginTop: 2, fontWeight: 500 }}>{linked.handle}</div>
                            ) : (
                              <div style={{ fontSize: 12, color: "#AEAEB2", marginTop: 2 }}>+{p.xp} XP · {p.pts} pts · Tap to link</div>
                            )}
                          </div>
                          {linked ? (
                            <div style={{
                              background: `${p.color}18`, border: `0.5px solid ${p.color}40`,
                              color: p.color, fontSize: 10, fontWeight: 700,
                              padding: "3px 8px", borderRadius: 20, flexShrink: 0,
                            }}>✓ Linked</div>
                          ) : (
                            <div style={{
                              background: "rgba(0,200,150,0.10)", border: "0.5px solid rgba(0,200,150,0.30)",
                              color: "#00C896", fontSize: 11, fontWeight: 700,
                              padding: "4px 10px", borderRadius: 20, flexShrink: 0,
                            }}>Link →</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {/* ── Wallet Section ── */}
        {section === "wallet" && (
          <>
            {/* Wallet Card */}
            <div style={{
              background: walletAddress ? "linear-gradient(135deg, #1C1C1E 0%, #2C2C2E 100%)" : "#FFFFFF",
              borderRadius: 20, padding: 20,
              border: walletAddress ? "none" : "0.5px solid rgba(60,60,67,0.12)",
              boxShadow: walletAddress ? "0 8px 32px rgba(0,0,0,0.20)" : "0 2px 12px rgba(0,0,0,0.05)",
              position: "relative", overflow: "hidden",
            }}>
              {walletAddress && (
                <>
                  <div style={{ position: "absolute", top: -30, right: -30, width: 120, height: 120, borderRadius: "50%", background: "radial-gradient(circle, rgba(0,200,150,0.25) 0%, transparent 70%)", pointerEvents: "none" }} />
                  <div style={{ position: "absolute", bottom: -20, left: -20, width: 80, height: 80, borderRadius: "50%", background: "radial-gradient(circle, rgba(0,200,150,0.12) 0%, transparent 70%)", pointerEvents: "none" }} />
                </>
              )}

              {walletAddress ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(0,200,150,0.15)", border: "0.5px solid rgba(0,200,150,0.30)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>💎</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#FFFFFF", letterSpacing: "0.02em" }}>the venue Wallet</div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.50)", marginTop: 1 }}>{walletData?.isImported ? "Imported" : "Auto-generated"}</div>
                      </div>
                    </div>
                    <div style={{ background: "rgba(0,200,150,0.15)", border: "0.5px solid rgba(0,200,150,0.30)", borderRadius: 20, padding: "4px 10px", fontSize: 10, fontWeight: 700, color: "#00C896", letterSpacing: "0.04em" }}>ACTIVE</div>
                  </div>

                  <div style={{ background: "rgba(255,255,255,0.06)", border: "0.5px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: "12px 14px", marginBottom: 16 }}>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.40)", marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase" }}>Wallet Address</div>
                    <div style={{ fontSize: 13, fontFamily: "monospace", color: "#FFFFFF", letterSpacing: "0.02em", wordBreak: "break-all" }}>{walletAddress}</div>
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      onClick={handleCopyAddress}
                      style={{
                        flex: 1, padding: "10px 0", borderRadius: 10,
                        border: copiedAddress ? "0.5px solid rgba(0,200,150,0.60)" : "0.5px solid rgba(0,200,150,0.40)",
                        background: copiedAddress ? "rgba(0,200,150,0.25)" : "rgba(0,200,150,0.12)",
                        color: "#00C896", fontSize: 13, fontWeight: 700, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        transition: "all 0.20s ease",
                      }}
                    >
                      {copiedAddress ? "✓ Copied!" : "📋 Copy Address"}
                    </button>
                    <button
                      onClick={() => {
                        haptic.impact("light");
                        const url = `https://sepolia.etherscan.io/address/${walletAddress}`;
                        if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(url);
                        else window.open(url, "_blank");
                      }}
                      style={{
                        padding: "10px 14px", borderRadius: 10,
                        border: "0.5px solid rgba(255,255,255,0.15)",
                        background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.60)",
                        fontSize: 13, fontWeight: 700, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        transition: "all 0.15s ease",
                      }}
                    >
                      ↗
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>💎</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", marginBottom: 8 }}>
                    {walletQuery.isLoading ? "Setting up your wallet..." : "No wallet yet"}
                  </div>
                  <div style={{ fontSize: 13, color: "#8E8E93" }}>
                    {walletQuery.isLoading ? "Generating your app wallet address..." : "Log in to auto-generate your app wallet."}
                  </div>
                </div>
              )}
            </div>

            {/* the venue API key provisioning — required for balances, deposit,
                withdraw, fiat-leg release, and promotion payments. Pure swap
                takers don't need this (POST /swap is signature-only). */}
            {venueLiveMode && hasVenueKeyQuery.data === false && (
              <div style={{
                background: "linear-gradient(135deg, rgba(0,200,150,0.10) 0%, rgba(0,200,150,0.04) 100%)",
                border: "0.5px solid rgba(0,200,150,0.30)",
                borderRadius: 14, padding: 14, marginTop: 8,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E", marginBottom: 6 }}>
                  Connect to the venue
                </div>
                <div style={{ fontSize: 12, color: "#3C3C43", marginBottom: 10, lineHeight: 1.45 }}>
                  Sign once with your wallet to create a per-account the venue API key.
                  Required for viewing balances, depositing liquidity, withdrawing
                  from vault, and releasing fiat-leg trades.
                </div>
                <button
                  onClick={handleProvisionVenueKey}
                  disabled={provisionLoading}
                  style={{
                    width: "100%", padding: "11px 0", borderRadius: 10,
                    border: "none",
                    background: provisionLoading
                      ? "rgba(60,60,67,0.10)"
                      : "linear-gradient(135deg, #00C896 0%, #00A07A 100%)",
                    color: provisionLoading ? "#8E8E93" : "#FFFFFF",
                    fontSize: 13, fontWeight: 700,
                    cursor: provisionLoading ? "not-allowed" : "pointer",
                  }}
                >
                  {provisionLoading ? "Signing & creating…" : "Connect to the venue"}
                </button>
              </div>
            )}

            {/* Token Balances */}
            {walletAddress && (
              <div>
                <div data-tour="me-balances" className="section-title" style={{ marginBottom: 10 }}>Token Balances</div>
                <div style={{ background: "#FFFFFF", borderRadius: 16, border: "0.5px solid rgba(60,60,67,0.12)", boxShadow: "0 2px 20px rgba(0,0,0,0.06)", overflow: "hidden" }}>
                  {(() => {
                    const rows = (meBalancesQuery.data?.balances ?? []).filter(
                      (b: any) => b.vault_available !== "0" || b.vault_frozen !== "0" || b.wallet_balance !== "0",
                    );
                    if (rows.length === 0) {
                      return (
                        <div style={{ padding: "18px 16px", textAlign: "center", color: "#8E8E93", fontSize: 13 }}>
                          {meBalancesQuery.isLoading
                            ? "Loading balances…"
                            : meBalancesQuery.data?.linked === false
                            ? "Connect to the venue (above) to see your balances."
                            : "No balances yet — fund your wallet to get started."}
                        </div>
                      );
                    }
                    return rows.map((b: any, i: number, arr: any[]) => {
                      const dec = b.decimals ?? 6;
                      const vault = (Number(b.vault_available) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: 2 });
                      const wallet = (Number(b.wallet_balance) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: 2 });
                      return (
                        <div key={b.symbol} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: i < arr.length - 1 ? "0.5px solid rgba(60,60,67,0.08)" : "none" }}>
                          <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(0,200,150,0.08)", border: "0.5px solid rgba(0,200,150,0.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#00A07A", flexShrink: 0 }}>{b.symbol.slice(0, 4)}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E" }}>{b.symbol}</div>
                            <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 1 }}>Wallet {wallet}</div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E" }}>{vault}</div>
                            <div style={{ fontSize: 10, color: "#8E8E93" }}>in vault</div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}

            {/* Withdraw from Vault — Phase 8 dual-sig instant withdraw */}
            {walletAddress && (
              <div>
                <div data-tour="me-withdraw" className="section-title" style={{ marginBottom: 10 }}>Withdraw from Vault</div>
                <div style={{ background: "#FFFFFF", borderRadius: 16, padding: 16, border: "0.5px solid rgba(60,60,67,0.12)", boxShadow: "0 2px 12px rgba(0,0,0,0.05)" }}>
                  <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 8, fontWeight: 600 }}>Token</div>
                  <select
                    value={withdrawToken}
                    onChange={(e) => setWithdrawToken(e.target.value)}
                    disabled={withdrawLoading}
                    style={{ width: "100%", padding: "11px 12px", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.20)", background: "rgba(118,118,128,0.04)", fontSize: 14, fontWeight: 600, color: "#1C1C1E", outline: "none", marginBottom: 12, boxSizing: "border-box" }}
                  >
                    {["USDT", "USDC", "XSGD", "TNSGD", "MYRC", "IDRX", "IDRT", "XIDR"].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>

                  <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 8, fontWeight: 600 }}>Amount</div>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder={`e.g. 100`}
                    disabled={withdrawLoading}
                    style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.20)", background: "rgba(118,118,128,0.04)", fontSize: 18, fontWeight: 700, color: "#1C1C1E", outline: "none", boxSizing: "border-box", marginBottom: 12 }}
                  />

                  <button
                    onClick={handleWithdraw}
                    disabled={withdrawLoading || !withdrawAmount}
                    style={{
                      width: "100%", padding: "12px 0", borderRadius: 12,
                      border: "none",
                      background: withdrawLoading
                        ? "rgba(60,60,67,0.10)"
                        : "linear-gradient(135deg, #00C896 0%, #00A07A 100%)",
                      color: withdrawLoading ? "#8E8E93" : "#FFFFFF",
                      fontSize: 14, fontWeight: 700,
                      cursor: withdrawLoading ? "not-allowed" : "pointer",
                    }}
                  >
                    {withdrawLoading ? "Signing & broadcasting…" : "Withdraw to Wallet"}
                  </button>

                  {withdrawTxHash && (
                    <div style={{ marginTop: 12, padding: "10px 12px", background: "rgba(0,200,150,0.08)", borderRadius: 10, fontSize: 12, color: "#00A07A", wordBreak: "break-all" }}>
                      ✓ Tx: {withdrawTxHash.slice(0, 12)}…{withdrawTxHash.slice(-8)}
                      {" "}
                      <a
                        href={`https://sepolia.etherscan.io/tx/${withdrawTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "#00A07A", fontWeight: 700 }}
                      >
                        View ↗
                      </a>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "#AEAEB2", marginTop: 10, lineHeight: 1.5 }}>
                    If the API is unavailable you can withdraw on-chain via{" "}
                    <code style={{ background: "rgba(60,60,67,0.08)", padding: "1px 4px", borderRadius: 4 }}>emergencyWithdraw()</code>{" "}
                    — see the the venue docs.
                  </div>
                </div>
              </div>
            )}

            {/* PRIMARY wallet action: import your own ALREADY-FUNDED testnet
                wallet via private key (the tester brings Sepolia ETH + claimed
                the venue tokens — we do NOT and cannot fund it; faucets are dead and
                we'd just generate a wallet if we could). Key is stored encrypted
                and used only to sign trades. MetaMask connect + read-only address
                paste removed — useless on mobile Telegram / can't sign. */}
            {!isMainnetActive() && (
              <div>
                <div className="section-title" style={{ marginBottom: 10 }}>{walletData?.isImported ? "Your wallet" : "Import your wallet"}</div>
                <button
                  onClick={() => { haptic.impact("medium"); setShowPrivateKeyFlow(true); }}
                  style={{
                    width: "100%", padding: "16px", borderRadius: 14, border: "none",
                    background: "linear-gradient(135deg, #00C896, #00A87A)",
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                    boxShadow: "0 4px 16px rgba(0,200,150,0.28)",
                  }}
                >
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>🔐</div>
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{walletData?.isImported ? "Import a different wallet" : "Import your wallet"}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 2 }}>Paste the private key of the testnet wallet you already funded (Sepolia ETH + the venue tokens).</div>
                  </div>
                  <span style={{ marginLeft: "auto", color: "rgba(255,255,255,0.7)", fontSize: 16 }}>›</span>
                </button>
              </div>
            )}

            {/* Security note */}
            <div style={{ background: "rgba(255,204,0,0.06)", border: "0.5px solid rgba(255,204,0,0.25)", borderRadius: 12, padding: "12px 14px", display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
              <div style={{ fontSize: 11, color: "#8E8E93", lineHeight: 1.55 }}>
                {isMainnetActive()
                  ? "Mainnet active. Trades settle on Ethereum mainnet with real funds — never share your seed phrase, and double-check every signature before approving."
                  : "Sepolia testnet active. Tokens have no real monetary value. Switching to mainnet flips this app to real funds."}
              </div>
            </div>
          </>
        )}

        {/* ── My P2P Section ── */}
        {section === "changer" && (
          <>
            {/* Beta / Sepolia preview banner */}
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
                You're previewing the future of P2P FX on the venue. Open a position with testnet liquidity to see exactly how it will work; real funds are enabled the moment we cut over to mainnet.
              </div>
            </div>
            <div className="glass-card" style={{ padding: 20 }}>
              <div data-tour="me-changer" style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.01em", marginBottom: 8 }}>Become a Market Maker</div>
              <div style={{ fontSize: 14, color: "#3C3C43", lineHeight: 1.65, marginBottom: 18 }}>
                Set your own rate, deposit liquidity, and go live in the Shop. Takers swap directly against your position. Earn on every fill. Build your reputation.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
                {[
                  { icon: "⚡", title: "Set your rate",       desc: "Choose an absolute rate (e.g. 1 USDT = 1.3621 XSGD)" },
                  { icon: "🔒", title: "Deposit liquidity",  desc: "Lock tokens so takers can fill your position instantly" },
                  { icon: "📣", title: "Go live",             desc: "Appear in the FX marketplace for all users to find you" },
                  { icon: "⭐", title: "Earn ratings",        desc: "Build reputation with every completed trade" },
                ].map((step, i) => (
                  <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(118,118,128,0.10)", border: "0.5px solid rgba(60,60,67,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{step.icon}</div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E", marginBottom: 2 }}>{step.title}</div>
                      <div style={{ fontSize: 12, color: "#8E8E93" }}>{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn-primary" onClick={handleChangerSetup}>⚡ Create Position →</button>
              <button
                onClick={() => setShowShopVideo(true)}
                style={{ width: "100%", marginTop: 10, padding: "12px", borderRadius: 12, border: "0.5px solid rgba(0,200,150,0.35)", background: "rgba(0,200,150,0.08)", color: "#00936F", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
              >
                ▶ Watch how it works
              </button>
            </div>

            {PROMOTIONS_ENABLED && (
            <div>
              <div className="section-title" style={{ marginBottom: 10 }}>Promote Your Shop</div>
              <div style={{ background: "#FFFFFF", borderRadius: 16, border: "0.5px solid rgba(60,60,67,0.12)", boxShadow: "0 2px 20px rgba(0,0,0,0.06)", overflow: "hidden" }}>
                {PROMO_TIERS.map((p, i) => (
                  <div key={p.tier} style={{ padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < 2 ? "0.5px solid rgba(60,60,67,0.10)" : "none" }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(118,118,128,0.10)", border: "0.5px solid rgba(60,60,67,0.10)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{p.emoji}</div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>{p.tier}</div>
                        <div style={{ fontSize: 12, color: "#8E8E93" }}>{p.desc}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: p.color }}>{p.price}</div>
                      <button
                        style={{ fontSize: 12, color: "#00C896", background: "none", border: "none", cursor: "pointer", padding: 0, marginTop: 2, fontWeight: 600 }}
                        onClick={() => handlePromoActivate(p)}
                      >
                        Activate →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            )}
          </>
        )}

        {/* ── Earn Section ── */}
        {section === "earn" && <EarnSection />}

        {/* ── History Section ── */}
        {section === "history" && (
          <>
            {history.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📋</div>
                <div className="empty-title">No transactions yet</div>
                <div className="empty-desc">Your completed swaps and sends will appear here.</div>
              </div>
            ) : (
              <div style={{ background: "#FFFFFF", borderRadius: 16, border: "0.5px solid rgba(60,60,67,0.12)", boxShadow: "0 2px 20px rgba(0,0,0,0.06)", overflow: "hidden" }}>
                {history.map((tx, i) => (
                  <div
                    key={tx.id}
                    onClick={() => {
                      haptic.impact("light");
                      toast.info(`Transaction details`, { description: `${tx.from} → ${tx.to} · ${tx.status}` });
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: i < history.length - 1 ? "0.5px solid rgba(60,60,67,0.10)" : "none", cursor: "pointer" }}
                  >
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: tx.type === "swap" ? "rgba(0,200,150,0.10)" : "rgba(74,144,217,0.10)", border: tx.type === "swap" ? "0.5px solid rgba(0,200,150,0.20)" : "0.5px solid rgba(74,144,217,0.20)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: tx.type === "swap" ? "#00C896" : "#4A90D9", fontWeight: 700, flexShrink: 0 }}>
                      {tx.type === "swap" ? "⇄" : "↗"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tx.from} → {tx.to}</div>
                      <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>{tx.type.toUpperCase()} · {tx.time}</div>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#00C896", background: "rgba(0,200,150,0.08)", border: "0.5px solid rgba(0,200,150,0.20)", padding: "3px 10px", borderRadius: 20 }}>{tx.status}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

      </div>

      {/* ── Changer Setup Modal ── */}
      {showChangerModal && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setShowChangerModal(false)}
            style={{
              position: "fixed", inset: 0, zIndex: 9000,
              background: "rgba(0,0,0,0.50)", backdropFilter: "blur(4px)",
              WebkitBackdropFilter: "blur(4px)",
              animation: "fadeIn 0.15s ease",
            }}
          />
          {/* Sheet - anchored above nav bar */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              bottom: "var(--nav-height, 64px)",
              left: 0, right: 0,
              zIndex: 9001,
              maxWidth: 480,
              margin: "0 auto",
              background: "#FFFFFF",
              borderRadius: "24px 24px 0 0",
              maxHeight: "calc(88vh - var(--nav-height, 64px))",
              display: "flex",
              flexDirection: "column",
              animation: "slideUp 0.25s cubic-bezier(0.32,0.72,0,1)",
            }}
          >
            {/* Drag handle */}
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(60,60,67,0.18)", margin: "14px auto 0", flexShrink: 0 }} />
            {/* Scrollable content area */}
            <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch" as any }}>
            {changerDone ? (
              <div style={{ textAlign: "center", padding: "24px 20px" }}>
                <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#1C1C1E", letterSpacing: "-0.02em", marginBottom: 8 }}>Position is Live!</div>
                <div style={{ fontSize: 14, color: "#8E8E93", lineHeight: 1.6, marginBottom: 24 }}>
                  Your liquidity position is now visible in the FX marketplace. Takers can swap against your rate instantly.
                </div>
                <div style={{ background: "rgba(0,200,150,0.06)", border: "0.5px solid rgba(0,200,150,0.20)", borderRadius: 14, padding: "14px 16px", marginBottom: 24 }}>
                  {[
                    { label: "Pair",       value: `${posPayToken} → ${posWantToken}` },
                    { label: "My Rate",    value: posRate ? `1 ${posPayToken} = ${posRate} ${posWantToken}` : "—" },
                    { label: "Liquidity",  value: `${posLiqNum > 0 ? posLiqNum.toLocaleString() : "—"} ${posPayToken} locked` },
                    { label: "Status",     value: "🟢 Live" },
                  ].map((r) => (
                    <div key={r.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: "#8E8E93" }}>{r.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E" }}>{r.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div style={{ padding: "0 20px 0" }}>
                {/* Step indicator */}
                <div style={{ display: "flex", gap: 6, marginBottom: 20, justifyContent: "center" }}>
                  {CHANGER_STEPS.map((_, i) => (
                    <div key={i} style={{
                      height: 4, flex: 1, borderRadius: 2,
                      background: i <= changerStep ? "#00C896" : "rgba(60,60,67,0.12)",
                      transition: "background 0.3s ease",
                    }} />
                  ))}
                </div>

                <div style={{ fontSize: 11, color: "#AEAEB2", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  Step {changerStep + 1} of {CHANGER_STEPS.length}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  <span style={{ fontSize: 28 }}>{CHANGER_STEPS[changerStep].icon}</span>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "#1C1C1E", letterSpacing: "-0.02em" }}>
                    {CHANGER_STEPS[changerStep].title}
                  </div>
                </div>
                <div style={{ fontSize: 14, color: "#8E8E93", lineHeight: 1.6, marginBottom: 4 }}>
                  {CHANGER_STEPS[changerStep].desc}
                </div>
                {CHANGER_STEPS[changerStep].content}
                </div>
              </>
            )}
            </div>
            {/* Sticky button row */}
            <div style={{ flexShrink: 0, padding: "12px 20px 24px", borderTop: "0.5px solid rgba(60,60,67,0.08)", background: "#FFFFFF", display: "flex", gap: 10 }}>
              {changerDone ? (
                <button
                  className="btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => setShowChangerModal(false)}
                >
                  Awesome! 🚀
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (changerStep === 0) { setShowChangerModal(false); }
                      else { haptic.selectionChanged(); setChangerStep((s) => s - 1); }
                    }}
                    style={{ flex: 1, padding: "13px 0", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.20)", background: "transparent", color: "#8E8E93", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                  >
                    {changerStep === 0 ? "Cancel" : "← Back"}
                  </button>
                  <button
                    onClick={handleChangerNext}
                    disabled={changerLoading}
                    style={{
                      flex: 2, padding: "13px 0", borderRadius: 12, border: "none",
                      background: changerLoading ? "rgba(0,200,150,0.40)" : "linear-gradient(135deg, #00C896, #00A87A)",
                      color: "#FFFFFF", fontSize: 14, fontWeight: 700, cursor: changerLoading ? "default" : "pointer",
                      boxShadow: changerLoading ? "none" : "0 4px 16px rgba(0,200,150,0.30)",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      transition: "all 0.15s ease",
                    }}
                  >
                    {changerLoading ? (
                      <>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ animation: "spin 1s linear infinite" }}>
                          <circle cx="7" cy="7" r="5" stroke="#fff" strokeWidth="2" strokeDasharray="16 8"/>
                        </svg>
                        {venueLiveMode
                          ? (makerStep === "checking-allowance" ? "Checking allowance…"
                            : makerStep === "approving" ? "Approving token…"
                            : makerStep === "depositing" ? "Depositing to Vault…"
                            : makerStep === "placing-order" ? "Placing order on the venue…"
                            : "Going live…")
                          : "Creating position…"}
                      </>
                    ) : changerStep < 2 ? "Continue →" : "🚀 Go Live!"}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Promo Activation Confirm Sheet */}
      <ConfirmSheet
        open={!!promoTier}
        onClose={() => setPromoTier(null)}
        onConfirm={handlePromoConfirm}
        loading={promoLoading}
        title={`Activate ${promoTier?.tier}`}
        emoji={promoTier?.emoji ?? "✨"}
        subtitle={`${promoTier?.desc}. Your shop will be promoted immediately after activation.`}
        confirmLabel={promoLoading ? "Activating…" : `Activate ${promoTier?.tier} - ${promoTier?.price}`}
        details={[
          { label: "Tier",     value: promoTier?.tier ?? "" },
          { label: "Price",    value: promoTier?.price ?? "" },
          { label: "Duration", value: "1 day" },
          { label: "Effect",   value: promoTier?.desc ?? "" },
        ]}
      />

      {/* Promo Success Modal */}
      <SuccessModal
        open={!!promoSuccess}
        onClose={() => setPromoSuccess(null)}
        title="Promotion Active!"
        subtitle={promoSuccess?.desc ?? ""}
        emoji={promoSuccess?.emoji ?? "✨"}
        details={[
          { label: "Tier",    value: promoSuccess?.tier ?? "" },
          { label: "Price",   value: promoSuccess?.price ?? "" },
          { label: "Status",  value: "🟢 Active for 24h" },
        ]}
        ctaLabel="Great!"
        onCta={() => setPromoSuccess(null)}
      />

      {/* Wallet Import Success Modal */}
      <SuccessModal
        open={showImportSuccess}
        onClose={() => setShowImportSuccess(false)}
        title="Wallet Imported!"
        subtitle="Your wallet is connected. Make sure it already holds Sepolia ETH and claimed the venue testnet tokens — that's what you'll trade with."
        emoji="🔑"
        details={[
          { label: "Wallet",  value: "Connected ✓" },
          { label: "Network", value: "Test network (Sepolia)" },
        ]}
        ctaLabel="View Wallet"
        onCta={() => setShowImportSuccess(false)}
      />

      {/* Badge detail modal — reflects REAL earned state (no fake unlock) */}
      <SuccessModal
        open={!!unlockedBadge}
        onClose={() => setUnlockedBadge(null)}
        title={unlockedBadge?.earned ? "Badge Earned" : "Badge — not yet earned"}
        subtitle={unlockedBadge?.desc ?? ""}
        emoji={unlockedBadge?.emoji ?? "🏆"}
        details={[
          { label: "Badge",      value: unlockedBadge?.name ?? "" },
          { label: "How to earn", value: unlockedBadge?.desc ?? "" },
          { label: "Status",     value: unlockedBadge?.earned ? "Earned ✓" : "Locked — keep going" },
        ]}
        ctaLabel={unlockedBadge?.earned ? "Nice!" : "Got it"}
        onCta={() => setUnlockedBadge(null)}
      />

      {/* Import-wallet modal — opens from the banner / popup / Wallet CTA, no matter
          which Me sub-section is showing (was an inline form on the Wallet sub-tab,
          so the banner/popup appeared to do nothing). */}
      {showPrivateKeyFlow && !isMainnetActive() && (
        <div
          onClick={() => { setShowPrivateKeyFlow(false); setPrivateKeyError(""); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 380, background: "#FFFFFF", borderRadius: 20, padding: 20 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#1C1C1E", marginBottom: 8 }}>Import your wallet</div>
            <div style={{ background: "rgba(255,59,48,0.06)", border: "0.5px solid rgba(255,59,48,0.30)", borderRadius: 10, padding: "10px 12px", marginBottom: 12, fontSize: 11, color: "#1C1C1E", lineHeight: 1.5 }}>
              <strong style={{ color: "#FF3B30" }}>⚠ TESTNET ONLY.</strong> Paste the Sepolia private key of the wallet you already funded (Sepolia ETH + claimed the venue tokens). It travels to our backend, stored encrypted, and is used only to sign your testnet trades.
            </div>
            <div style={{ background: "rgba(118,118,128,0.06)", border: privateKeyError ? "0.5px solid rgba(224,82,82,0.40)" : "0.5px solid rgba(60,60,67,0.15)", borderRadius: 10, padding: "12px 14px", marginBottom: privateKeyError ? 6 : 12 }}>
              <input
                type="password"
                value={importPrivateKey}
                onChange={(e) => { setImportPrivateKey(e.target.value); setPrivateKeyError(""); }}
                placeholder="0x… (64 hex chars)"
                autoComplete="off"
                spellCheck={false}
                style={{ width: "100%", background: "transparent", border: "none", outline: "none", fontSize: 14, fontFamily: "monospace", color: "#1C1C1E" }}
              />
            </div>
            {privateKeyError && <div style={{ fontSize: 11, color: "#E05252", marginBottom: 12, lineHeight: 1.4 }}>{privateKeyError}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setShowPrivateKeyFlow(false); setImportPrivateKey(""); setPrivateKeyError(""); }}
                style={{ flex: 1, padding: "13px 0", borderRadius: 12, border: "0.5px solid rgba(60,60,67,0.20)", background: "transparent", color: "#8E8E93", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handlePrivateKeySubmit}
                disabled={importPrivateKeyMutation.isPending || !importPrivateKey}
                style={{ flex: 2, padding: "13px 0", borderRadius: 12, border: "none", background: importPrivateKey ? "linear-gradient(135deg,#00C896,#00A87A)" : "rgba(118,118,128,0.15)", color: importPrivateKey ? "#fff" : "#AEAEB2", fontSize: 14, fontWeight: 700, cursor: importPrivateKey ? "pointer" : "default" }}
              >
                {importPrivateKeyMutation.isPending ? "Importing…" : "Import wallet"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Social Link Bottom Sheet ── */}
      {showSocialSheet && activeSocialPlatform && (() => {
        const SOCIAL_PLATFORMS = [
          { id: "x" as const,         label: "X (Twitter)",  emoji: "𝕏",  placeholder: "@yourhandle",        xp: 100, pts: 50,  color: "#000000" },
          { id: "whatsapp" as const,  label: "WhatsApp",    emoji: "💬", placeholder: "+65 9123 4567",       xp: 75,  pts: 40,  color: "#25D366" },
          { id: "gmail" as const,     label: "Gmail",       emoji: "✉️", placeholder: "you@gmail.com",       xp: 75,  pts: 40,  color: "#EA4335" },
          { id: "instagram" as const, label: "Instagram",   emoji: "📸", placeholder: "@yourhandle",        xp: 50,  pts: 25,  color: "#E1306C" },
          { id: "linkedin" as const,  label: "LinkedIn",    emoji: "💼", placeholder: "linkedin.com/in/you", xp: 50,  pts: 25,  color: "#0A66C2" },
        ];
        const p = SOCIAL_PLATFORMS.find(x => x.id === activeSocialPlatform)!;
        const linkedMap = new Map((socialLinksQuery.data ?? []).map((l: any) => [l.platform, l]));
        const isAlreadyLinked = linkedMap.has(p.id);
        return (
          <>
            {/* Overlay */}
            <div
              onClick={() => { setShowSocialSheet(false); setSocialHandleInput(""); setActiveSocialPlatform(null); }}
              style={{
                position: "fixed", inset: 0,
                background: "rgba(0,0,0,0.45)",
                zIndex: 1000,
                animation: "fadeIn 0.18s ease",
              }}
            />
            {/* Sheet */}
            <div style={{
              position: "fixed",
              left: 0, right: 0,
              bottom: "var(--nav-height, 64px)",
              zIndex: 1001,
              background: "#FFFFFF",
              borderRadius: "20px 20px 0 0",
              padding: "20px 20px 28px",
              boxShadow: "0 -8px 40px rgba(0,0,0,0.18)",
              animation: "slideUp 0.25s cubic-bezier(0.32,0.72,0,1)",
            }}>
              {/* Handle */}
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(60,60,67,0.18)", margin: "0 auto 18px" }} />

              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: `${p.color}18`, border: `0.5px solid ${p.color}40`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: p.id === "x" ? 16 : 22,
                }}>{p.emoji}</div>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E" }}>Link {p.label}</div>
                  {!isAlreadyLinked && (
                    <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>
                      Earn <span style={{ color: p.color, fontWeight: 700 }}>+{p.xp} XP</span> and <span style={{ color: "#FF9500", fontWeight: 700 }}>{p.pts} pts</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Input */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 6, fontWeight: 500 }}>Your {p.label} handle</div>
                <input
                  autoFocus
                  value={socialHandleInput}
                  onChange={(e) => setSocialHandleInput(e.target.value)}
                  placeholder={p.placeholder}
                  style={{
                    width: "100%", padding: "12px 14px",
                    border: `1px solid ${p.color}50`,
                    borderRadius: 12, fontSize: 15,
                    background: `${p.color}06`,
                    color: "#1C1C1E", outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              {/* Trust note */}
              <div style={{
                background: "rgba(0,200,150,0.06)", border: "0.5px solid rgba(0,200,150,0.20)",
                borderRadius: 10, padding: "8px 12px", marginBottom: 18,
                fontSize: 11, color: "#8E8E93", lineHeight: 1.5,
              }}>
                🔒 Your handle is only visible to counterparties after you accept a trade.
                It helps build trust and speeds up settlement.
              </div>

              {/* Buttons */}
              <div style={{ display: "flex", gap: 10 }}>
                {isAlreadyLinked && (
                  <button
                    onClick={() => {
                      haptic.impact("medium");
                      socialUnlinkMutation.mutate({ platform: activeSocialPlatform });
                      setShowSocialSheet(false);
                      setSocialHandleInput("");
                      setActiveSocialPlatform(null);
                    }}
                    style={{
                      flex: 1, padding: "13px 0", borderRadius: 12,
                      border: "0.5px solid rgba(255,59,48,0.35)",
                      background: "rgba(255,59,48,0.06)",
                      color: "#FF3B30", fontSize: 14, fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    Unlink
                  </button>
                )}
                <button
                  onClick={() => {
                    if (!socialHandleInput.trim()) return;
                    haptic.impact("medium");
                    setSocialLinkLoading(true);
                    socialLinkMutation.mutate({ platform: activeSocialPlatform, handle: socialHandleInput.trim() });
                  }}
                  disabled={!socialHandleInput.trim() || socialLinkLoading}
                  style={{
                    flex: 2, padding: "13px 0", borderRadius: 12,
                    border: "none",
                    background: !socialHandleInput.trim() ? "rgba(0,200,150,0.30)" : `linear-gradient(135deg, ${p.color}, ${p.color}CC)`,
                    color: "#FFFFFF", fontSize: 14, fontWeight: 700, cursor: socialHandleInput.trim() ? "pointer" : "default",
                    boxShadow: socialHandleInput.trim() ? `0 4px 16px ${p.color}40` : "none",
                    transition: "all 0.15s ease",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}
                >
                  {socialLinkLoading ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ animation: "spin 1s linear infinite" }}>
                      <circle cx="7" cy="7" r="5" stroke="#fff" strokeWidth="2" strokeDasharray="16 8"/>
                    </svg>
                  ) : null}
                  {isAlreadyLinked ? "Update" : `Link ${p.label}`}
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {/* Social Link XP Reward Modal */}
      {socialXpReward && (() => {
        const SOCIAL_PLATFORMS = [
          { id: "x",         label: "X (Twitter)",  emoji: "𝕏",  color: "#000000" },
          { id: "whatsapp",  label: "WhatsApp",    emoji: "💬", color: "#25D366" },
          { id: "gmail",     label: "Gmail",       emoji: "✉️", color: "#EA4335" },
          { id: "instagram", label: "Instagram",   emoji: "📸", color: "#E1306C" },
          { id: "linkedin",  label: "LinkedIn",    emoji: "💼", color: "#0A66C2" },
        ];
        const p = SOCIAL_PLATFORMS.find(x => x.id === socialXpReward.platform)!;
        return (
          <SuccessModal
            open={true}
            onClose={() => setSocialXpReward(null)}
            title="Account Linked!"
            subtitle={`Your ${p?.label ?? socialXpReward.platform} is now connected to your the app profile.`}
            emoji={p?.emoji ?? "✅"}
            details={[
              { label: "XP Earned",     value: `+${socialXpReward.xp} XP` },
              { label: "Points Earned", value: `+${socialXpReward.points} pts` },
              { label: "Trust Score",   value: "Improved ↑" },
            ]}
            ctaLabel="Awesome!"
            onCta={() => setSocialXpReward(null)}
          />
        );
      })()}

      {/* Set-up-shop explainer video (lazy — MP4 loads only when opened). */}
      {showShopVideo && (
        <VideoTour src="/embeds/shop.mp4" title="How to open your shop" onClose={() => setShowShopVideo(false)} />
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function ConnectMetaMaskPanel({
  walletAddress,
  importWalletMutation,
}: {
  walletAddress: string | null | undefined;
  importWalletMutation: { mutate: (input: { address: string }) => void; isPending: boolean };
}) {
  const wallet = useWallet();
  const networkLabel = isMainnetActive() ? "Ethereum Mainnet" : "Sepolia testnet";
  const sameAddressAlreadyImported =
    walletAddress && wallet.address &&
    walletAddress.toLowerCase() === wallet.address.toLowerCase();

  const handleConnect = async () => {
    await wallet.connectMetaMask();
    if (wallet.address) {
      const imported = wallet.address;
      if (!walletAddress || walletAddress.toLowerCase() !== imported.toLowerCase()) {
        importWalletMutation.mutate({ address: imported });
      }
    }
  };

  const handleAttach = () => {
    if (wallet.address) importWalletMutation.mutate({ address: wallet.address });
  };

  return (
    <div>
      <div className="section-title" style={{ marginBottom: 10 }}>
        Connect a wallet
      </div>
      <div style={{
        background: "#FFFFFF", borderRadius: 16,
        border: "0.5px solid rgba(60,60,67,0.12)",
        boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
        padding: 16,
      }}>
        <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 12, lineHeight: 1.5 }}>
          Connect MetaMask to sign real the venue trades from this app. Targeting <strong style={{ color: "#1C1C1E" }}>{networkLabel}</strong>.
        </div>
        {wallet.address ? (
          <>
            <div style={{
              background: "rgba(0,200,150,0.06)",
              border: "0.5px solid rgba(0,200,150,0.30)",
              borderRadius: 10, padding: "10px 12px", marginBottom: 10,
              fontSize: 12, color: "#1C1C1E",
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {wallet.chainId === wallet.expectedChainId ? "✓ Connected" : "⚠ Wrong network"}
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#8E8E93" }}>
                {wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}
              </div>
              {wallet.error && (
                <div style={{ fontSize: 11, color: "#E05252", marginTop: 6 }}>{wallet.error}</div>
              )}
            </div>
            {wallet.chainId !== wallet.expectedChainId && (
              <button
                onClick={wallet.switchToExpectedChain}
                style={{
                  width: "100%", padding: "10px 0", borderRadius: 10, border: "none",
                  background: "#FF9500", color: "#FFFFFF",
                  fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 8,
                }}
              >
                Switch to {networkLabel}
              </button>
            )}
            {!sameAddressAlreadyImported && (
              <button
                onClick={handleAttach}
                disabled={importWalletMutation.isPending}
                style={{
                  width: "100%", padding: "10px 0", borderRadius: 10, border: "none",
                  background: "linear-gradient(135deg, #00C896, #00A87A)", color: "#FFFFFF",
                  fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 8,
                }}
              >
                {importWalletMutation.isPending ? "Saving…" : "Use this wallet for trading"}
              </button>
            )}
            <button
              onClick={wallet.disconnect}
              style={{
                width: "100%", padding: "10px 0", borderRadius: 10,
                border: "0.5px solid rgba(60,60,67,0.20)",
                background: "transparent", color: "#8E8E93",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              Disconnect
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleConnect}
              disabled={wallet.isConnecting}
              style={{
                width: "100%", padding: "12px 0", borderRadius: 12, border: "none",
                background: wallet.isConnecting ? "rgba(0,200,150,0.40)" : "linear-gradient(135deg, #00C896, #00A87A)",
                color: "#FFFFFF",
                fontSize: 14, fontWeight: 700, cursor: wallet.isConnecting ? "default" : "pointer",
                boxShadow: wallet.isConnecting ? "none" : "0 4px 12px rgba(0,200,150,0.25)",
              }}
            >
              {wallet.isConnecting ? "Connecting…" : "🦊 Connect MetaMask"}
            </button>
            {wallet.error && (
              <div style={{ fontSize: 11, color: "#E05252", marginTop: 8, lineHeight: 1.4 }}>
                {wallet.error}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
