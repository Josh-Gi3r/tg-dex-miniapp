import { z } from "zod";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";

/**
 * Server-side onboarding "seen" state. Tracks which tutorial tabs + explainer
 * videos a user has already watched, keyed per user, so it survives across app
 * opens. The Telegram WebView does NOT reliably persist localStorage, so a
 * localStorage-only gate replayed the tutorials on every open ("doesn't it
 * remember me?"). This is the durable source of truth; the client still keeps a
 * localStorage fast-path for the current session.
 */
function parseSeen(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const onboardingRouter = router({
  /** The set of onboarding keys this user has already seen. */
  seen: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [] as string[];
    const row = (
      await db.select({ s: users.onboardingSeen }).from(users).where(eq(users.id, ctx.user.id)).limit(1)
    )[0];
    return parseSeen(row?.s);
  }),

  /** Mark one onboarding key as seen (idempotent — deduped set). */
  markSeen: protectedProcedure
    .input(z.object({ key: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { ok: false as const };
      const row = (
        await db.select({ s: users.onboardingSeen }).from(users).where(eq(users.id, ctx.user.id)).limit(1)
      )[0];
      const set = new Set(parseSeen(row?.s));
      set.add(input.key);
      await db
        .update(users)
        .set({ onboardingSeen: JSON.stringify([...set]) })
        .where(eq(users.id, ctx.user.id));
      return { ok: true as const };
    }),
});
