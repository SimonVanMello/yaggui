import { beforeEach, describe, expect, it } from 'vitest';

import {
  blameAnother,
  blameBack,
  closeInspect,
  inspectViewOf,
  openBlame,
  openFileHistory,
  openReflog,
  useInspectStore,
} from './inspectStore';

beforeEach(() => {
  useInspectStore.setState({ views: {} });
});

describe('inspect store', () => {
  it('keeps one view per repository', () => {
    openFileHistory(1, 'a.txt');
    openReflog(2);
    expect(inspectViewOf(1)).toEqual({ kind: 'fileHistory', path: 'a.txt', rev: null });
    expect(inspectViewOf(2)).toEqual({ kind: 'reflog', reference: 'HEAD' });
    openBlame(1, 'a.txt', 'abc');
    expect(inspectViewOf(1)?.kind).toBe('blame');
    closeInspect(1);
    expect(inspectViewOf(1)).toBeUndefined();
    expect(inspectViewOf(2)).toBeDefined();
  });

  it('walks back through the versions blamed', () => {
    openBlame(1, 'new.txt', null);
    blameAnother(1, { path: 'new.txt', rev: 'p1', line: 4 });
    blameAnother(1, { path: 'old.txt', rev: 'p2' });
    expect(inspectViewOf(1)).toMatchObject({
      target: { path: 'old.txt', rev: 'p2' },
      trail: [
        { path: 'new.txt', rev: null },
        { path: 'new.txt', rev: 'p1', line: 4 },
      ],
    });
    expect(blameBack(1)).toBe(true);
    expect(inspectViewOf(1)).toMatchObject({
      target: { rev: 'p1', line: 4 },
      trail: [{ rev: null }],
    });
    expect(blameBack(1)).toBe(true);
    expect(blameBack(1)).toBe(false);
    // A new blame starts a new trail.
    openBlame(1, 'x.txt');
    expect(inspectViewOf(1)).toMatchObject({ trail: [] });
  });
});
