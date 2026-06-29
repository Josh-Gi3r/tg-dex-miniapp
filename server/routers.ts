import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { swapRouter } from "./routers/swap";
import { shopRouter } from "./routers/changer";
import { sendRouter } from "./routers/send";
import { leaderboardRouter } from "./routers/leaderboard";
import { p2pRouter } from "./routers/p2p";
import { questsRouter } from "./routers/quests";
import { walletRouter } from "./routers/wallet";
import { newsRouter } from "./routers/news";
import { referralRouter } from "./routers/referral";
import { socialRouter } from "./routers/social";
import { dexRouter } from "./routers/dex";
import { signalsRouter } from "./routers/signals";
import { yieldRouter } from "./routers/yield";
import { shopSettlementRouter } from "./routers/shopSettlement";
import { assistantRouter } from "./routers/assistant";
import { onboardingRouter } from "./routers/onboarding";
import { peerRouter } from "./routers/peer";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  swap: swapRouter,
  shop: shopRouter,
  send: sendRouter,
  leaderboard: leaderboardRouter,
  p2p: p2pRouter,
  quests: questsRouter,
  wallet: walletRouter,
  onboarding: onboardingRouter,
  news: newsRouter,
  referral: referralRouter,
  social: socialRouter,
  dex: dexRouter,
  signals: signalsRouter,
  yield: yieldRouter,
  shopSettlement: shopSettlementRouter,
  assistant: assistantRouter,
  // Peer (zkP2P) fiat ⇄ crypto ramp. Always mounted so client types are stable;
  // reads return `config.enabled`, writes are guarded by ENV.peerEnabled.
  peer: peerRouter,
});

export type AppRouter = typeof appRouter;
