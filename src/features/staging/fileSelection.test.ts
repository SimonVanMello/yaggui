import { describe, expect, it } from 'vitest';

import {
  actionTargets,
  closesOpenDiff,
  effectivePaths,
  nextAfter,
  NO_PICKS,
  pick,
} from './fileSelection';

const order = ['a', 'b', 'c', 'd', 'e'];
const none = { shift: false, toggle: false };

describe('file picks', () => {
  it('picks one file, then extends a range from the anchor', () => {
    const first = pick(order, new Set(), null, 'b', none, 'b');
    expect([...first.paths]).toEqual(['b']);
    const range = pick(order, first.paths, first.anchor, 'd', { shift: true, toggle: false }, 'b');
    expect([...range.paths]).toEqual(['b', 'c', 'd']);
    expect(range.anchor).toBe('b');
    const back = pick(order, range.paths, range.anchor, 'a', { shift: true, toggle: false }, 'b');
    expect([...back.paths]).toEqual(['a', 'b']);
  });

  it('toggles single files with ⌘/Ctrl, keeping the others', () => {
    const base = pick(order, new Set(['a']), 'a', 'c', { shift: false, toggle: true }, 'a');
    expect([...base.paths].sort()).toEqual(['a', 'c']);
    const off = pick(order, base.paths, base.anchor, 'a', { shift: false, toggle: true }, 'a');
    expect([...off.paths]).toEqual(['c']);
  });

  it('falls back to the open file when picks are stale or gone', () => {
    const present = new Set(order);
    const picked = pick(order, new Set(), null, 'b', { shift: false, toggle: true }, 'a');
    expect([...effectivePaths(picked, 'a', present)]).toEqual(['b']);
    // The open file changed (j/k in the diff): the old picks no longer apply.
    expect([...effectivePaths(picked, 'c', present)]).toEqual(['c']);
    // A picked file that left the list is dropped.
    expect([...effectivePaths(picked, 'a', new Set(['a']))]).toEqual([]);
    expect([...effectivePaths(NO_PICKS, null, present)]).toEqual([]);
  });
});

describe('action targets', () => {
  const files = order.map((path) => ({ path }));

  it('acts on the whole selection when the clicked file is part of it', () => {
    expect(actionTargets(files, new Set(['a', 'c']), 'c').map((f) => f.path)).toEqual(['a', 'c']);
  });

  it('acts on the clicked file only when it is outside the selection', () => {
    expect(actionTargets(files, new Set(['a', 'c']), 'e').map((f) => f.path)).toEqual(['e']);
  });
});

describe('next file after an action', () => {
  it('moves below the last acted file, else above', () => {
    expect(nextAfter(order, new Set(['b', 'c']))).toBe('d');
    expect(nextAfter(order, new Set(['d', 'e']))).toBe('c');
    expect(nextAfter(['a'], new Set(['a']))).toBeNull();
    expect(nextAfter(order, new Set())).toBeNull();
  });
});

describe('click on the open file', () => {
  it('closes the diff on a plain click on the open file', () => {
    expect(closesOpenDiff('a', none, 'a', new Set(['a']))).toBe(true);
  });

  it('opens another file', () => {
    expect(closesOpenDiff('b', none, 'a', new Set(['a']))).toBe(false);
    expect(closesOpenDiff('a', none, null, new Set())).toBe(false);
  });

  it('keeps Shift and ⌘/Ctrl clicks for the multi-selection', () => {
    expect(closesOpenDiff('a', { shift: true, toggle: false }, 'a', new Set(['a']))).toBe(false);
    expect(closesOpenDiff('a', { shift: false, toggle: true }, 'a', new Set(['a']))).toBe(false);
  });

  it('narrows a multi-selection to the open file instead of closing it', () => {
    expect(closesOpenDiff('a', none, 'a', new Set(['a', 'b']))).toBe(false);
  });
});
