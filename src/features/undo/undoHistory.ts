import type { JournalEntry, UndoBlock } from '../../ipc';

/** The history split by session: this one first, then the entries reloaded from `yaggui.db`. */
export interface HistoryGroups {
  current: JournalEntry[];
  earlier: JournalEntry[];
}

/** Keeps the backend's newest-first order inside each group (F-244). */
export function groupHistory(entries: readonly JournalEntry[]): HistoryGroups {
  const current: JournalEntry[] = [];
  const earlier: JournalEntry[] = [];
  for (const entry of entries) (entry.restored ? earlier : current).push(entry);
  return { current, earlier };
}

/**
 * Reasons that come from the time spent closed (objects pruned by `git gc`, an entry another
 * version wrote, refs moved meanwhile), as opposed to operations that are never undoable.
 */
export function isUnrestorable(block: UndoBlock | null): boolean {
  return (
    block !== null &&
    (block.kind === 'objectsMissing' || block.kind === 'unreadable' || block.kind === 'diverged')
  );
}

/** Same calendar day in the local time zone. */
export function isSameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(locale: string, withDate: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${withDate}`;
  let found = formats.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(
      locale,
      withDate ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'medium' },
    );
    formats.set(key, found);
  }
  return found;
}

/** "14:32:07" today, "Oct 18, 2026, 14:32" another day, in the UI language. */
export function formatWhen(at: number, now: number, locale: string): string {
  return format(locale, !isSameDay(at, now)).format(at);
}
