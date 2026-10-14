import { useSyncExternalStore } from 'react';

const FALLBACK = 28;

function readRowHeight(): number {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--row-height'),
  );
  return Number.isFinite(value) && value > 0 ? value : FALLBACK;
}

/**
 * Read once and cached: `getComputedStyle` forces a style recalculation, which costs a whole
 * frame when a kept tab view is shown again (P-07). Only the density and the theme set it.
 */
let cached: number | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) {
    // One observer for the app's lifetime, so the cache never goes stale between subscribers.
    observer = new MutationObserver(() => {
      cached = null;
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-density', 'data-theme'],
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  cached ??= readRowHeight();
  return cached;
}

/** `--row-height` in px; follows the comfortable/compact density switch and the theme. */
export function useRowHeight(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
