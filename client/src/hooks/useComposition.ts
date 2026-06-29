/**
 * ─── useComposition ──────────────────────────────────────────────────────────
 *
 * Handles IME (Input Method Editor) composition events for CJK language input
 * (Chinese, Japanese, Korean). Used by the Textarea UI component to prevent
 * premature form submission while the user is still composing a character.
 *
 * This is a UI infrastructure hook — do not remove.
 */

import { useRef, useCallback } from "react";
import type { CompositionEvent, KeyboardEvent } from "react";

interface UseCompositionOptions<T extends HTMLElement> {
  onKeyDown?: (e: KeyboardEvent<T>) => void;
  onCompositionStart?: (e: CompositionEvent<T>) => void;
  onCompositionEnd?: (e: CompositionEvent<T>) => void;
}

export function useComposition<T extends HTMLElement>(
  options: UseCompositionOptions<T> = {}
) {
  const isComposing = useRef(false);

  const onCompositionStart = useCallback(
    (e: CompositionEvent<T>) => {
      isComposing.current = true;
      options.onCompositionStart?.(e);
    },
    [options.onCompositionStart]
  );

  const onCompositionEnd = useCallback(
    (e: CompositionEvent<T>) => {
      isComposing.current = false;
      options.onCompositionEnd?.(e);
    },
    [options.onCompositionEnd]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<T>) => {
      if (isComposing.current) return;
      options.onKeyDown?.(e);
    },
    [options.onKeyDown]
  );

  return { onCompositionStart, onCompositionEnd, onKeyDown };
}
