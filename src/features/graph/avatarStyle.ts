import { GRAPH_COLORS } from '../../ipc';

// Rows re-render while scrolling and authors repeat: keep the results (bounded).
const MAX_CACHED = 5000;
const initialsCache = new Map<string, string>();

function cached(cache: Map<string, string>, key: string, compute: (key: string) => string) {
  let value = cache.get(key);
  if (value === undefined) {
    if (cache.size >= MAX_CACHED) cache.clear();
    value = compute(key);
    cache.set(key, value);
  }
  return value;
}

/** "Alex Martin" → "AM", "linus" → "LI", "" → "?". */
export function initials(name: string): string {
  return cached(initialsCache, name, computeInitials);
}

function computeInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter((w) => /\p{L}|\p{N}/u.test(w));
  const first = words[0];
  if (!first) return '?';
  const letters = (word: string) => Array.from(word.replace(/[^\p{L}\p{N}]/gu, ''));
  const second = words[1];
  if (!second) return letters(first).slice(0, 2).join('').toUpperCase() || '?';
  return `${letters(first)[0] ?? ''}${letters(second)[0] ?? ''}`.toUpperCase();
}

/** Stable color (0..GRAPH_COLORS-1, a `--lane-n` token) for an author, keyed on the email. */
export function avatarColor(key: string): number {
  let hash = 0x811c9dc5;
  const normalized = key.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % GRAPH_COLORS;
}
