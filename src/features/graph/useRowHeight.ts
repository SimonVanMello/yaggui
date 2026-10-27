import { useSyncExternalStore } from 'react';

const TOKENS = {
  '--row-height': 28,
  '--control-height-md': 30,
} as const;

type HeightToken = keyof typeof TOKENS;

function readHeight(token: HeightToken): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token));
  return Number.isFinite(value) && value > 0 ? value : TOKENS[token];
}

/**
 * Read once and cached: `getComputedStyle` forces a style recalculation, which costs a whole
 * frame when a kept tab view is shown again (P-07). Only the density and the theme set it.
 */
const cached = new Map<HeightToken, number>();
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) {
    // One observer for the app's lifetime, so the cache never goes stale between subscribers.
    observer = new MutationObserver(() => {
      cached.clear();
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

function snapshotOf(token: HeightToken): number {
  let value = cached.get(token);
  if (value === undefined) {
    value = readHeight(token);
    cached.set(token, value);
  }
  return value;
}

const getRowHeight = () => snapshotOf('--row-height');
const getControlHeight = () => snapshotOf('--control-height-md');

/** `--row-height` in px; follows the comfortable/compact density switch and the theme. */
export function useRowHeight(): number {
  return useSyncExternalStore(subscribe, getRowHeight);
}

/** `--control-height-md` in px, for virtualized lists whose rows are control-sized. */
export function useControlHeight(): number {
  return useSyncExternalStore(subscribe, getControlHeight);
}
