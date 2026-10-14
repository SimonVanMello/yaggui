import { describe, expect, it } from 'vitest';

import type { ChangedFile } from '../../ipc';
import { splitPath, treeRows } from './fileTree';

const file = (path: string): ChangedFile => ({
  path,
  oldPath: null,
  status: 'modified',
  similarity: null,
  additions: 1,
  deletions: 1,
  binary: false,
  oldMode: 'regular',
  newMode: 'regular',
});

const files = ['README.md', 'src/features/diff/a.ts', 'src/features/diff/b.ts', 'src/main.ts'].map(
  file,
);

describe('file tree', () => {
  it('nests folders first and compresses single-child chains', () => {
    const rows = treeRows(files, new Set());
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual([
      'src',
      '  features/diff',
      '    a.ts',
      '    b.ts',
      '  main.ts',
      'README.md',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'folder', path: 'src', fileCount: 3 });
    expect(rows[1]).toMatchObject({ path: 'src/features/diff', fileCount: 2 });
  });

  it('hides the content of collapsed folders', () => {
    const rows = treeRows(files, new Set(['src/features/diff']));
    expect(rows.map((r) => r.name)).toEqual(['src', 'features/diff', 'main.ts', 'README.md']);
  });

  it('splits a path in folder and name', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' });
    expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' });
  });
});
