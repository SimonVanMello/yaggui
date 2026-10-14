import { describe, expect, it } from 'vitest';

import { myers, type Edit } from './myers';

/** Applies the edit script to `a`, which must give `b`. */
function apply<T>(a: T[], b: T[], edits: Edit[]): T[] {
  const out: T[] = [];
  let pos = 0;
  for (const e of edits) {
    out.push(...a.slice(pos, e.aStart), ...b.slice(e.bStart, e.bEnd));
    pos = e.aEnd;
  }
  return [...out, ...a.slice(pos)];
}

describe('myers', () => {
  it('returns nothing for equal inputs', () => {
    expect(myers(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('finds a minimal script', () => {
    const a = 'A,B,C,A,B,B,A'.split(',');
    const b = 'C,B,A,B,A,C'.split(',');
    const edits = myers(a, b);
    expect(apply(a, b, edits)).toEqual(b);
    const cost = edits.reduce((n, e) => n + e.aEnd - e.aStart + e.bEnd - e.bStart, 0);
    expect(cost).toBe(5);
  });

  it('handles insertions, deletions and replacements', () => {
    expect(myers(['a', 'c'], ['a', 'b', 'c'])).toEqual([
      { aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 },
    ]);
    expect(myers(['a', 'b', 'c'], ['a', 'c'])).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 },
    ]);
    expect(myers([], ['x'])).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
    const a = ['1', '2', '3', '4', '5'];
    const b = ['1', 'x', '3', '4', 'y', 'z'];
    expect(apply(a, b, myers(a, b))).toEqual(b);
  });

  it('falls back to one replacement above the cost limit', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${String(i)}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${String(i)}`);
    expect(myers(a, b, 10)).toEqual([{ aStart: 0, aEnd: 50, bStart: 0, bEnd: 50 }]);
  });
});
