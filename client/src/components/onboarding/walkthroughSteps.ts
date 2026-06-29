/**
 * Per-tab walkthrough content. Keyed by the MiniApp tab id. The first step of
 * each tour has no `target` (a centered intro card — always shows, even before
 * the page's elements render); the rest spotlight an element by data-tour key
 * and are skipped gracefully if that element isn't on screen.
 *
 * Copy rule: plain everyday words for SEA / non-native users — no jargon
 * (no "CLOB", "escrow", "slippage", "on-chain"). Keep each step short.
 */
import type { TourStep } from "./Walkthrough";

export type WalkthroughTab =
  | "swap" | "send" | "p2p" | "signals" | "quests" | "news" | "me";

export const WALKTHROUGHS: Record<WalkthroughTab, TourStep[]> = {
  swap: [
    { title: "Swap", body: "Trade one stablecoin for another at the best rate. Quick and simple — no shop needed." },
    { target: "swap-pair", title: "Pick your coins", body: "Choose what you have and what you want (for example USDT → XSGD)." },
    { target: "swap-amount", title: "Enter an amount", body: "Type how much you want to trade. We show what you'll get below." },
    { target: "swap-rate", title: "Live rate", body: "This is the current rate, updated for you. No hidden markup." },
    { target: "swap-cta", title: "Make the swap", body: "Tap here to trade. The coins move straight to your wallet." },
  ],
  send: [
    { title: "Send", body: "Send stablecoins to anyone — by wallet address or just their Telegram @username." },
    { target: "send-recipient", title: "Who gets it", body: "Paste a wallet address, or type @username to send to a friend on Telegram." },
    { target: "send-amount", title: "How much", body: "Enter the amount to send. Your balance shows above." },
    { target: "send-convert", title: "Convert on arrival", body: "Turn this on to send one coin and have them receive a different one." },
    { target: "send-cta", title: "Send it", body: "Tap to send. If they're not a user yet, we make a claim link you can share." },
  ],
  p2p: [
    { title: "Shops (FX)", body: "Trade with a real money changer's shop. Pick who you deal with — like choosing a stall, not a machine." },
    { target: "p2p-list", title: "Browse shops", body: "These are open shops and their rates. Tap one to see the offer and trade." },
    { target: "p2p-create", title: "Open your own shop", body: "Want to be the changer? Set your rate, add your coins, and earn on every trade." },
  ],
  signals: [
    { title: "Assistant", body: "Your the venue helper. Ask about rates, your balance, or how to make a trade — in plain words." },
    { target: "assistant-board", title: "Live rates", body: "See live shop rates here. Tap one to ask the Assistant about it." },
    { target: "assistant-input", title: "Ask anything", body: "Type a question like \"what's a good rate for SGD?\" and the Assistant answers." },
  ],
  quests: [
    { title: "Quests", body: "Do simple tasks to earn XP and level up. The more you use the app, the more you earn." },
    { target: "quests-list", title: "Your tasks", body: "Finish these to collect rewards. On test mode, rewards are saved for when we go live." },
  ],
  news: [
    { title: "News", body: "Stablecoin and FX news, kept fresh — so you know what's moving before you trade." },
    { target: "news-list", title: "Latest stories", body: "Tap any story to read more." },
  ],
  me: [
    { title: "Me", body: "Your wallet, balances, shop, and rewards — all in one place." },
    { target: "me-import", title: "Bring your wallet", body: "Import the testnet wallet you already funded. This is the only thing you need to do to start." },
    { target: "me-balances", title: "Your money", body: "See what you hold in your wallet and your venue vault." },
    { target: "me-changer", title: "Become a changer", body: "Open your own shop, set rates, and earn on trades — when you're ready." },
    { target: "me-withdraw", title: "Take money out", body: "Move coins from your vault back to your wallet anytime." },
  ],
};
