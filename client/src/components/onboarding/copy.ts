/**
 * ─── Onboarding Copy ────────────────────────────────────────────────────────
 *
 * Single source of truth for every InfoChip / ExplainerDrawer body and every
 * first-run card in the app. Pure data — no JSX, no hooks — so a future i18n
 * swap is one wrapper away (t(topic).title etc.).
 *
 * Topic keys are namespaced flat so they double as localStorage flag keys
 * (app:onboarding:explainer:<topic>:v1).
 */

export type TopicKey =
  | "swap"
  | "send"
  | "p2p"
  | "signals"
  | "quests"
  | "news"
  | "wallet"
  | "yield"
  | "changer";

export interface ExplainerSubSection {
  label: string;
  body: string;
}

export interface ExplainerContent {
  /** Short label shown on the InfoChip itself, e.g. "How signals work". */
  chipLabel: string;
  /** Drawer header title. */
  title: string;
  /** One-paragraph drawer body. Markdown not supported — keep it plain. */
  body: string;
  /** Optional emoji shown as the drawer's hero glyph. */
  emoji?: string;
  /** Optional list of named sub-sections rendered below the body. */
  subSections?: ExplainerSubSection[];
  /** One-sentence summary used for the first-run carousel card. */
  firstRunCard?: string;
}

export const EXPLAINERS: Record<TopicKey, ExplainerContent> = {
  swap: {
    chipLabel: "How swap works",
    title: "Instant token swaps",
    body:
      "Trade between USDC, ETH and other supported tokens at the venue's live oracle rate. No counterparty needed — the swap settles in one tap.",
    emoji: "⇄",
    firstRunCard: "Swap any supported token in one tap at the live oracle rate.",
  },
  send: {
    chipLabel: "How send works",
    title: "Send to anyone",
    body:
      "Send tokens to a wallet address or a Telegram @handle. If they aren't on the app yet, the funds wait safely in escrow until they open the app.",
    emoji: "↗",
    firstRunCard:
      "Send to a wallet or a Telegram @handle — escrowed if they're new.",
  },
  p2p: {
    chipLabel: "How FX works",
    title: "Peer-to-peer trades",
    body:
      "Post an ad to buy or sell stablecoins for cash, mobile money or bank transfer. Funds are held in escrow until both sides confirm. Disputes go to a human.",
    emoji: "∞",
    subSections: [
      {
        label: "Browse",
        body: "Tap a listing to take the offer. Escrow locks instantly.",
      },
      {
        label: "Position",
        body: "Post your own ad as a maker. Set rate, limits, payment methods.",
      },
      {
        label: "Escrow & disputes",
        body: "Crypto sits in escrow until both sides mark complete. A real human handles disputes.",
      },
    ],
    firstRunCard:
      "Trade crypto for cash, M-Pesa or bank — escrow protected on both sides.",
  },
  signals: {
    chipLabel: "How signals work",
    title: "Live opportunities, scanned every 60 seconds",
    body:
      "Our bot watches every FX ad and oracle rate. When something looks better than the market, you see it here and (optionally) get a Telegram ping.",
    emoji: "✦",
    subSections: [
      {
        label: "Better-than-market rate",
        body: "An ad is priced meaningfully better than the oracle midpoint.",
      },
      {
        label: "Your offer needs attention",
        body: "An ad you've posted is now mispriced vs. the market — may need a tweak.",
      },
      {
        label: "Wide-spread market",
        body: "Buy and sell sides are far apart — room for a quick round-trip.",
      },
    ],
    firstRunCard:
      "Live trade opportunities scanned every 60s. Pings you on Telegram.",
  },
  quests: {
    chipLabel: "How quests work",
    title: "Earn XP, climb the leaderboard",
    body:
      "Daily and one-time tasks reward XP and points. XP unlocks new levels (Trader → Dealer → Broker…) and points convert to perks like fee rebates and promo credit.",
    emoji: "★",
    firstRunCard:
      "Daily tasks reward XP and points — level up from Novice to Legend.",
  },
  news: {
    chipLabel: "What's news for?",
    title: "Market context",
    body:
      "Curated stories about FX, stablecoins and the regions the app supports. Tap any story to read on the source.",
    emoji: "✉",
    firstRunCard: "Market news that actually affects the rates you trade at.",
  },
  wallet: {
    chipLabel: "About your wallet",
    title: "Your wallet, your keys",
    body:
      "The app never custodies your funds. Connect a wallet or generate one — the recovery phrase only ever lives on your device.",
    emoji: "◈",
    firstRunCard: "The app never holds your funds. Your keys stay on your device.",
  },
  yield: {
    chipLabel: "How earn works",
    title: "Pooled yield bot",
    body:
      "Deposit USDC into a pooled bot strategy. NAV updates every cycle (visible below the chart). Withdraw on the next cycle — no lock-up.",
    emoji: "%",
  },
  changer: {
    chipLabel: "About changers",
    title: "Run an FX shop",
    body:
      "Changers are verified makers. Manage ads, fund your float, track payouts and ratings — all in one place.",
    emoji: "⌂",
  },
};

/** Topic order for the first-run carousel. */
export const FIRST_RUN_TOPICS: TopicKey[] = [
  "swap",
  "p2p",
  "signals",
  "quests",
  "wallet",
];
