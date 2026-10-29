import type { MessageKey } from '../../i18n/i18n';
import type { IconName } from '../../ui/Icon';
import { fuzzyMatch } from '../welcome/fuzzy';

export type ItemKind = 'action' | 'branch' | 'tag' | 'commit' | 'file' | 'tab';

export interface PaletteItem {
  /** Unique and stable across openings: the recents are stored by key. */
  key: string;
  kind: ItemKind;
  /** Text matched and displayed. */
  label: string;
  /** Secondary text, not matched (author, path, status…). */
  detail?: string;
  /** Shortcut in `Mod+K` notation (actions). */
  shortcut?: string;
  disabled?: boolean;
  /** Shown instead of `detail` while the item is disabled. */
  disabledReason?: MessageKey;
  /** Performs the item's effect; called once the palette has closed. */
  activate: () => void;
  /** `activate` runs with the palette still open: it shows another list in it. */
  keepsPaletteOpen?: boolean;
  /** Extra weight in ties: the active tab, the current branch. */
  boost?: number;
}

export interface RankedItem {
  item: PaletteItem;
  score: number;
  /** Matched character indices in `item.label`. */
  indices: number[];
}

export type PaletteMode = 'all' | ItemKind;

export interface ParsedQuery {
  mode: PaletteMode;
  text: string;
}

/** Optional prefixes narrowing the search to one kind: `>` actions, `@` refs, `#` commits, `/` files. */
const PREFIXES: Record<string, PaletteMode> = {
  '>': 'action',
  '@': 'branch',
  '#': 'commit',
  '/': 'file',
};

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trimStart();
  const mode = PREFIXES[trimmed.charAt(0)];
  return mode ? { mode, text: trimmed.slice(1).trim() } : { mode: 'all', text: trimmed.trim() };
}

/** Whether items of `kind` belong to results for `mode` (`@` covers branches and tags). */
export function kindMatchesMode(kind: ItemKind, mode: PaletteMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'branch') return kind === 'branch' || kind === 'tag';
  return kind === mode;
}

export const KIND_ICON: Record<ItemKind, IconName> = {
  action: 'chevronRight',
  branch: 'branch',
  tag: 'tag',
  commit: 'commit',
  file: 'file',
  tab: 'laptop',
};

export const KIND_LABEL: Record<ItemKind, MessageKey> = {
  action: 'palette.kind.action',
  branch: 'palette.kind.branch',
  tag: 'palette.kind.tag',
  commit: 'palette.kind.commit',
  file: 'palette.kind.file',
  tab: 'palette.kind.tab',
};

/** Most results rendered; the list is not virtualized, so it stays far below the 200 rule. */
export const MAX_RESULTS = 50;

/** Kinds listed first on a tie: what the user most likely typed a command or a name for. */
const KIND_ORDER: Record<ItemKind, number> = {
  action: 0,
  tab: 1,
  branch: 2,
  tag: 3,
  file: 4,
  commit: 5,
};

const RECENT_BOOST = 3;

/** Plain code-unit order: `localeCompare` is several times slower and this runs on 10k ties. */
function compareLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Results for a query over `pool`.
 * - Empty query: recents first (most recent first), then the other items in pool order.
 * - Otherwise: best fuzzy score first, recents slightly boosted, kind order on ties.
 * Commits are already filtered by the backend (message, author, SHA): they keep their order
 * and are not fuzzy-matched again, but follow the other matches.
 */
export function rankItems(
  pool: readonly PaletteItem[],
  text: string,
  recents: readonly string[],
  limit = MAX_RESULTS,
): { items: RankedItem[]; total: number } {
  const recentRank = new Map(recents.map((key, index) => [key, index]));
  if (text === '') {
    const recent: { entry: RankedItem; rank: number }[] = [];
    const rest: RankedItem[] = [];
    for (const item of pool) {
      const rank = recentRank.get(item.key);
      const entry = { item, score: 0, indices: [] };
      if (rank === undefined) rest.push(entry);
      else recent.push({ entry, rank });
    }
    recent.sort((a, b) => a.rank - b.rank);
    const all = [...recent.map(({ entry }) => entry), ...rest];
    return { items: all.slice(0, limit), total: all.length };
  }
  const scored: RankedItem[] = [];
  const commits: RankedItem[] = [];
  for (const item of pool) {
    if (item.kind === 'commit') {
      commits.push({ item, score: 0, indices: [] });
      continue;
    }
    const match = fuzzyMatch(text, item.label);
    if (!match) continue;
    const boost = (item.boost ?? 0) + (recentRank.has(item.key) ? RECENT_BOOST : 0);
    scored.push({ item, score: match.score + boost, indices: match.indices });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
      compareLabels(a.item.label, b.item.label),
  );
  const all = [...scored, ...commits];
  return { items: all.slice(0, limit), total: all.length };
}
