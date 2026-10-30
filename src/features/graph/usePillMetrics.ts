import { useSyncExternalStore } from 'react';

import type { Measure } from './pillFit';
import styles from './RefPills.module.css';

/** What the ref pills of a row need to lay themselves out without reading the row's layout. */
export interface PillMetrics {
  /** Width of a name in the pill font; `bold` for the checked-out branch. */
  measure: (text: string, bold: boolean) => number;
  /** `0` in the pill font, px. */
  ch: number;
  /** Width of a commit summary in the row font. */
  measureMessage: (text: string) => number;
  /** `0` in the summary font, px. */
  messageCh: number;
  /** Gap between pills and inside a pill (`--space-1`). */
  gap: number;
  /** Gap between the items of the message column (`--space-2`). */
  messageGap: number;
  /** Horizontal padding plus border of a pill. */
  padding: number;
  /** Pill icon (`--icon-size-sm`). */
  icon: number;
  /** HEAD dot (`--space-2`). */
  dot: number;
  /** Right padding of a row (`--space-3`). */
  rowPadding: number;
}

const MEASURE_CACHE_LIMIT = 20_000;

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function context(): Context | null {
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1).getContext('2d');
    return document.createElement('canvas').getContext('2d');
  } catch {
    return null;
  }
}

function px(value: string, fallback: number): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Reads the tokens through a hidden probe: custom properties hold unresolved `calc()`
 * (`--text-xs` follows `--font-scale`), the computed style of a real box does not.
 */
function readMetrics(): PillMetrics {
  const probe = document.createElement('span');
  probe.className = styles.pill ?? '';
  probe.style.cssText =
    'display:block;position:absolute;visibility:hidden;pointer-events:none;contain:strict;';
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe);
  const token = (name: string, fallback: number) => {
    probe.style.width = `var(${name})`;
    return px(computed.width, fallback);
  };
  const fontSize = px(computed.fontSize, 11);
  const pillFont = `${computed.fontStyle} ${computed.fontWeight} ${String(fontSize)}px ${computed.fontFamily}`;
  probe.classList.add(styles.current ?? '');
  const headFont = `${computed.fontStyle} ${computed.fontWeight} ${String(fontSize)}px ${computed.fontFamily}`;
  probe.className = '';
  probe.style.fontSize = 'var(--text-md)';
  probe.style.fontFamily = 'var(--font-ui)';
  const messageFontSize = px(computed.fontSize, 13);
  const messageFont = `${String(messageFontSize)}px ${computed.fontFamily}`;
  const space1 = token('--space-1', 4);
  const space2 = token('--space-2', 6);
  const space3 = token('--space-3', 8);
  const border = token('--border-width', 1);
  const icon = token('--icon-size-sm', 14);
  probe.remove();

  const ctx = context();
  const cache = new Map<string, number>();
  const raw = (font: string, size: number, text: string) => {
    if (!ctx) return text.length * size * 0.6;
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  const measure = (text: string, bold: boolean) => {
    const key = (bold ? '\u0001' : '\u0000') + text;
    let width = cache.get(key);
    if (width === undefined) {
      if (cache.size >= MEASURE_CACHE_LIMIT) cache.clear();
      width = raw(bold ? headFont : pillFont, fontSize, text);
      cache.set(key, width);
    }
    return width;
  };
  return {
    measure,
    ch: measure('0', false),
    measureMessage: (text) => raw(messageFont, messageFontSize, text),
    messageCh: raw(messageFont, messageFontSize, '0'),
    gap: space1,
    messageGap: space2,
    padding: 2 * space2 + 2 * border,
    icon,
    dot: space2,
    rowPadding: space3,
  };
}

/** `measure` bound to the regular or bold pill font. */
export function measureWith(metrics: PillMetrics, bold: boolean): Measure {
  return (text) => metrics.measure(text, bold);
}

let cached: PillMetrics | null = null;
const listeners = new Set<() => void>();
let watching = false;

function invalidate(): void {
  cached = null;
  for (const notify of listeners) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!watching) {
    watching = true;
    // For the app's lifetime: fonts, text size, density and theme are set on the root.
    new MutationObserver(invalidate).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-density', 'data-theme', 'data-style', 'data-contrast'],
    });
    // Widths measured with a fallback font before Inter is loaded would be wrong.
    document.fonts.addEventListener('loadingdone', invalidate);
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PillMetrics {
  cached ??= readMetrics();
  return cached;
}

/** Pill font and token sizes, read once and cached until the appearance changes. */
export function usePillMetrics(): PillMetrics {
  return useSyncExternalStore(subscribe, getSnapshot);
}
