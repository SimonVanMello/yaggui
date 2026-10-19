import { describe, expect, it } from 'vitest';

import type { ChangelogEntry } from '../../ipc';
import { formatReleaseDate, groupEntries, splitCode } from './changelog';

describe('groupEntries', () => {
  it('groups by kind in display order and drops empty groups', () => {
    const entries: ChangelogEntry[] = [
      { kind: 'other', text: 'o' },
      { kind: 'feature', text: 'f1' },
      { kind: 'feature', text: 'f2' },
    ];
    expect(groupEntries(entries)).toEqual([
      { kind: 'feature', entries: [entries[1], entries[2]] },
      { kind: 'other', entries: [entries[0]] },
    ]);
  });
});

describe('splitCode', () => {
  it('splits code spans', () => {
    expect(splitCode('Press `Mod+S` to save')).toEqual([
      { text: 'Press ', code: false },
      { text: 'Mod+S', code: true },
      { text: ' to save', code: false },
    ]);
  });

  it('keeps an unpaired backtick as text', () => {
    expect(splitCode('`a` and ` alone')).toEqual([
      { text: 'a', code: true },
      { text: ' and ` alone', code: false },
    ]);
  });

  it('handles plain text and empty spans', () => {
    expect(splitCode('plain')).toEqual([{ text: 'plain', code: false }]);
    expect(splitCode('``x')).toEqual([{ text: 'x', code: false }]);
  });
});

describe('formatReleaseDate', () => {
  it('formats the calendar date in the UI language', () => {
    expect(formatReleaseDate('2026-10-16', 'en')).toBe('October 16, 2026');
    expect(formatReleaseDate('2026-10-16', 'fr')).toBe('16 octobre 2026');
  });

  it('returns what it cannot read unchanged', () => {
    expect(formatReleaseDate('soon', 'en')).toBe('soon');
  });
});
