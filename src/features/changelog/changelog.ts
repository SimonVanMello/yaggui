import type { ChangeKind, ChangelogEntry, ChangelogRelease } from '../../ipc';

/** Display order of the groups inside a release. */
export const CHANGE_KINDS: readonly ChangeKind[] = ['feature', 'fix', 'other'];

export interface ChangeGroup {
  kind: ChangeKind;
  entries: ChangelogEntry[];
}

/** The entries of a release by kind, in `CHANGE_KINDS` order; empty groups are left out. */
export function groupEntries(entries: readonly ChangelogEntry[]): ChangeGroup[] {
  return CHANGE_KINDS.map((kind) => ({
    kind,
    entries: entries.filter((entry) => entry.kind === kind),
  })).filter((group) => group.entries.length > 0);
}

export interface TextSegment {
  text: string;
  code: boolean;
}

/** Splits `` `code` `` spans out of an entry; an unpaired backtick stays plain text. */
export function splitCode(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf('`');
    const close = open === -1 ? -1 : rest.indexOf('`', open + 1);
    if (close === -1) break;
    if (open > 0) segments.push({ text: rest.slice(0, open), code: false });
    if (close > open + 1) segments.push({ text: rest.slice(open + 1, close), code: true });
    rest = rest.slice(close + 1);
  }
  if (rest) segments.push({ text: rest, code: false });
  return segments;
}

/** Stable key and anchor of a release. */
export function releaseKey(release: ChangelogRelease): string {
  return release.version ?? 'unreleased';
}

/** `2026-10-16` in the UI language, read as a calendar date (no time zone shift). */
export function formatReleaseDate(date: string, locale: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(value.getTime())) return date;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(value);
}
