import { desc } from "drizzle-orm";
import { z } from "zod";
import { yieldCycles } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  getLastSignalCycle,
  SIGNAL_CYCLE_INTERVAL_MS,
} from "../lib/signals/worker";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";

const YIELD_CYCLE_INTERVAL_MS = 60_000;

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  cronStatus: publicProcedure.query(async () => {
    const sig = getLastSignalCycle();
    const db = await getDb();
    const [yld] = db
      ? await db
          .select()
          .from(yieldCycles)
          .orderBy(desc(yieldCycles.createdAt))
          .limit(1)
      : [];

    return {
      serverNow: Date.now(),
      signals: sig
        ? {
            lastRunAt: sig.endedAt.getTime(),
            durationMs: sig.endedAt.getTime() - sig.startedAt.getTime(),
            intervalMs: SIGNAL_CYCLE_INTERVAL_MS,
            activeAds: sig.activeAds,
            candidatesEmitted: sig.candidatesEmitted,
            notificationsSent: sig.notificationsSent,
            errors: sig.errors,
          }
        : null,
      yield: yld
        ? {
            lastRunAt: yld.createdAt.getTime(),
            intervalMs: YIELD_CYCLE_INTERVAL_MS,
          }
        : null,
    };
  }),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
