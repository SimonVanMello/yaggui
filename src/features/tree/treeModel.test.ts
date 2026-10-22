import { describe, expect, it } from 'vitest';

import type { TreeEntry, TreeEntryKind } from '../../ipc';
import {
  ancestorFolders,
  flattenTree,
  moveInTree,
  parentPath,
  resolveLinkTarget,
  rowKey,
  type Listing,
} from './treeModel';

function entry(name: string, kind: TreeEntryKind = 'file'): TreeEntry {
  return { name, kind, oid: name, size: kind === 'dir' ? null : 1 };
}

function listing(entries: TreeEntry[], total = entries.length): Listing {
  return { entries, total };
}

const LISTINGS = new Map<string, Listing>([
  ['', listing([entry('docs', 'dir'), entry('src', 'dir'), entry('README.md')])],
  ['docs', listing([entry('a.md'), entry('b.md')])],
  ['src', listing([entry('deep', 'dir'), entry('main.rs')])],
  ['src/deep', listing([entry('leaf.txt')])],
]);

const paths = (rows: ReturnType<typeof flattenTree>) =>
  rows.map((row) => (row.kind === 'entry' ? row.path : `…${row.path}`));

describe('flattenTree', () => {
  it('shows only the root while every folder is closed', () => {
    expect(paths(flattenTree(LISTINGS, new Set()))).toEqual(['docs', 'src', 'README.md']);
  });

  it('lists the children of the open folders, depth first, with their depth', () => {
    const rows = flattenTree(LISTINGS, new Set(['src', 'src/deep']));
    expect(paths(rows)).toEqual([
      'docs',
      'src',
      'src/deep',
      'src/deep/leaf.txt',
      'src/main.rs',
      'README.md',
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1, 2, 1, 0]);
    expect(rows.filter((row) => row.kind === 'entry' && row.expanded)).toHaveLength(2);
  });

  it('keeps a folder closed when its parent is closed', () => {
    expect(paths(flattenTree(LISTINGS, new Set(['src/deep'])))).toEqual([
      'docs',
      'src',
      'README.md',
    ]);
  });

  it('marks folders that are not loaded, or only partly, with a loading row', () => {
    expect(paths(flattenTree(LISTINGS, new Set(['missing'])))).toEqual(
      paths(flattenTree(LISTINGS, new Set())),
    );
    const partial = new Map(LISTINGS).set('docs', listing([entry('a.md')], 1200));
    const rows = flattenTree(partial, new Set(['docs']));
    expect(paths(rows).slice(0, 3)).toEqual(['docs', 'docs/a.md', '…docs']);
    const unloaded = new Map(LISTINGS);
    unloaded.delete('docs');
    expect(paths(flattenTree(unloaded, new Set(['docs'])))).toContain('…docs');
    expect(flattenTree(new Map(), new Set())).toEqual([{ kind: 'loading', path: '', depth: 0 }]);
  });

  it('marks an empty folder', () => {
    const empty = new Map(LISTINGS).set('docs', listing([]));
    expect(paths(flattenTree(empty, new Set(['docs'])))).toEqual([
      'docs',
      '…docs',
      'src',
      'README.md',
    ]);
    expect(flattenTree(empty, new Set(['docs']))[1]).toEqual({
      kind: 'empty',
      path: 'docs',
      depth: 1,
    });
  });

  it('gives every row a distinct key', () => {
    const partial = new Map(LISTINGS).set('docs', listing([entry('a.md')], 5));
    const keys = flattenTree(partial, new Set(['docs'])).map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('flattens a 100 000-entry folder quickly', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => entry(`f${String(i)}.txt`));
    const big = new Map([['', listing(many)]]);
    const start = performance.now();
    expect(flattenTree(big, new Set())).toHaveLength(100_000);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('moveInTree', () => {
  const rows = flattenTree(LISTINGS, new Set(['src']));
  // docs, src, src/deep, src/main.rs, README.md

  it('moves through the visible rows and stops at both ends', () => {
    expect(moveInTree(rows, 'docs', 'ArrowDown')).toEqual({ active: 'src' });
    expect(moveInTree(rows, 'src', 'ArrowUp')).toEqual({ active: 'docs' });
    expect(moveInTree(rows, 'docs', 'ArrowUp')).toBeNull();
    expect(moveInTree(rows, 'README.md', 'ArrowDown')).toBeNull();
    expect(moveInTree(rows, 'src', 'End')).toEqual({ active: 'README.md' });
    expect(moveInTree(rows, 'src', 'Home')).toEqual({ active: 'docs' });
  });

  it('reaches the first row when nothing is active', () => {
    expect(moveInTree(rows, null, 'ArrowDown')).toEqual({ active: 'docs' });
  });

  it('opens a closed folder, then enters it', () => {
    expect(moveInTree(rows, 'docs', 'ArrowRight')).toEqual({
      active: 'docs',
      toggle: { path: 'docs', open: true },
    });
    expect(moveInTree(rows, 'src', 'ArrowRight')).toEqual({ active: 'src/deep' });
    expect(moveInTree(rows, 'README.md', 'ArrowRight')).toBeNull();
  });

  it('closes an open folder, then goes to the parent', () => {
    expect(moveInTree(rows, 'src', 'ArrowLeft')).toEqual({
      active: 'src',
      toggle: { path: 'src', open: false },
    });
    expect(moveInTree(rows, 'src/main.rs', 'ArrowLeft')).toEqual({ active: 'src' });
    expect(moveInTree(rows, 'README.md', 'ArrowLeft')).toBeNull();
  });

  it('skips loading rows and handles an empty tree', () => {
    const partial = flattenTree(
      new Map(LISTINGS).set('docs', listing([entry('a.md')], 9)),
      new Set(['docs']),
    );
    expect(moveInTree(partial, 'docs/a.md', 'ArrowDown')).toEqual({ active: 'src' });
    expect(moveInTree([], null, 'ArrowDown')).toBeNull();
  });
});

describe('paths', () => {
  it('lists the folders to open to reach a path', () => {
    expect(ancestorFolders('a/b/c.txt')).toEqual(['a', 'a/b']);
    expect(ancestorFolders('c.txt')).toEqual([]);
    expect(parentPath('a/b/c.txt')).toBe('a/b');
    expect(parentPath('c.txt')).toBe('');
  });

  it('resolves the target of a symbolic link inside the repository', () => {
    expect(resolveLinkTarget('docs/link', '../README.md')).toBe('README.md');
    expect(resolveLinkTarget('docs/link', 'a/./b.md')).toBe('docs/a/b.md');
    expect(resolveLinkTarget('link', 'docs')).toBe('docs');
    expect(resolveLinkTarget('docs/link', '../../etc/passwd')).toBeNull();
    expect(resolveLinkTarget('docs/link', '/etc/passwd')).toBeNull();
    expect(resolveLinkTarget('docs/link', 'C:\\x')).toBeNull();
    expect(resolveLinkTarget('docs/link', '..')).toBeNull();
  });
});
