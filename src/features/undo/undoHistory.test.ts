import { describe, expect, it } from 'vitest';

import type { JournalEntry, UndoBlock } from '../../ipc';
import { formatWhen, groupHistory, isSameDay, isUnrestorable } from './undoHistory';

function entry(id: number, restored: boolean): JournalEntry {
  return {
    id,
    op: { kind: 'createBranch', name: `b${id}` },
    at: 0,
    undone: false,
    blocked: null,
    restored,
  };
}

describe('groupHistory', () => {
  it('puts this session first and keeps the newest-first order in each group', () => {
    // An undone restored entry can sit between session entries in the backend order.
    const { current, earlier } = groupHistory([
      entry(9, false),
      entry(5, true),
      entry(8, false),
      entry(4, true),
    ]);
    expect(current.map((e) => e.id)).toEqual([9, 8]);
    expect(earlier.map((e) => e.id)).toEqual([5, 4]);
  });

  it('handles a history with only one of the groups', () => {
    expect(groupHistory([entry(2, true), entry(1, true)]).current).toEqual([]);
    expect(groupHistory([entry(1, false)]).earlier).toEqual([]);
    expect(groupHistory([])).toEqual({ current: [], earlier: [] });
  });
});

describe('isUnrestorable', () => {
  it.each<[UndoBlock | null, boolean]>([
    [null, false],
    [{ kind: 'published' }, false],
    [{ kind: 'pulled' }, false],
    [{ kind: 'objectsMissing', count: 3 }, true],
    [{ kind: 'unreadable' }, true],
    [{ kind: 'diverged', refs: ['HEAD'] }, true],
  ])('%j → %s', (block, expected) => {
    expect(isUnrestorable(block)).toBe(expected);
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 9, 21, 15, 0, 0).getTime();

  it('shows only the time today, local midnight included', () => {
    expect(isSameDay(new Date(2026, 9, 21, 0, 0, 1).getTime(), now)).toBe(true);
    expect(formatWhen(new Date(2026, 9, 21, 9, 5, 7).getTime(), now, 'en')).toMatch(
      /^9:05:07\sAM$/,
    );
  });

  it('adds the date on another day', () => {
    const yesterday = new Date(2026, 9, 20, 23, 59, 0).getTime();
    expect(isSameDay(yesterday, now)).toBe(false);
    expect(formatWhen(yesterday, now, 'en')).toMatch(/^Oct 20, 2026, 11:59\sPM$/);
    expect(formatWhen(yesterday, now, 'fr')).toMatch(/^20 oct\. 2026,? 23:59$/);
  });
});
