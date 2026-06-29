/**
 * ─── useOnboardingState ─────────────────────────────────────────────────────
 *
 * localStorage-backed flags for the onboarding/explainer system. Used by
 * the first-run modal, InfoChip ("seen" badges), and any future coach marks.
 *
 * All access is wrapped in try/catch — Telegram WebView in private mode
 * throws on storage access. Failures silently no-op (worst case: user sees
 * the explainer again).
 *
 * Keys are versioned (`:v1`) so a copy refresh can re-trigger the tour for
 * everyone by bumping the suffix.
 */

import { useCallback, useState } from "react";
import type { TopicKey } from "@/components/onboarding/copy";

const FIRST_RUN_KEY = "app:onboarding:firstRun:v1";
const explainerKey = (topic: TopicKey) =>
  `app:onboarding:explainer:${topic}:v1`;
const coachKey = (tab: string) => `app:onboarding:coach::v1`;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no-op */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* no-op */
  }
}

export function hasCompletedFirstRun(): boolean {
  return safeGet(FIRST_RUN_KEY) === "completed";
}

export function isExplainerSeen(topic: TopicKey): boolean {
  return safeGet(explainerKey(topic)) === "seen";
}

export function isCoachMarkSeen(tab: string): boolean {
  return safeGet(coachKey(tab)) === "seen";
}

export function useOnboardingState() {
  const [, force] = useState(0);
  const rerender = useCallback(() => force(n => n + 1), []);

  const markFirstRunComplete = useCallback(() => {
    safeSet(FIRST_RUN_KEY, "completed");
    rerender();
  }, [rerender]);

  const resetFirstRun = useCallback(() => {
    safeRemove(FIRST_RUN_KEY);
    rerender();
  }, [rerender]);

  const markExplainerSeen = useCallback(
    (topic: TopicKey) => {
      safeSet(explainerKey(topic), "seen");
      rerender();
    },
    [rerender],
  );

  const markCoachMarkSeen = useCallback(
    (tab: string) => {
      safeSet(coachKey(tab), "seen");
      rerender();
    },
    [rerender],
  );

  const resetAllCoachMarks = useCallback(() => {
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("app:onboarding:coach:")) toRemove.push(k);
      }
      toRemove.forEach(safeRemove);
    } catch {
      /* no-op */
    }
    rerender();
  }, [rerender]);

  return {
    hasCompletedFirstRun,
    markFirstRunComplete,
    resetFirstRun,
    isExplainerSeen,
    markExplainerSeen,
    isCoachMarkSeen,
    markCoachMarkSeen,
    resetAllCoachMarks,
  };
}
