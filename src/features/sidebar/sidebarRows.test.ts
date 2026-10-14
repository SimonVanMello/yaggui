import { describe, expect, it } from 'vitest';

import type { LocalBranch, RepoRefs } from '../../ipc';
import { buildSidebarRows, matchAll, stashTitle, type SidebarRow } from './sidebarRows';

function local(name: string, extra: Partial<LocalBranch> = {}): LocalBranch {
  return {
    name,
    fullName: `refs/heads/${name}`,
    sha: `sha-${name}`,
    isHead: false,
    upstream: null,
    row: 1,
    ...extra,
  };
}

function refs(patch: Partial<RepoRefs> = {}): RepoRefs {
  return {
    graphVersion: 1,
    head: { kind: 'branch', name: 'main', oid: 'sha-main' },
    local: [
      local('feat/graph/lanes'),
      local('feat/tabs'),
      local('fix/stash'),
      local('main', { isHead: true }),
    ],
    remotes: [
      {
        name: 'origin',
        url: 'git@example.com:x.git',
        pushUrl: null,
        branches: [
          { name: 'origin/feat/tabs', fullName: 'refs/remotes/origin/feat/tabs', sha: 'a', row: 2 },
          { name: 'origin/main', fullName: 'refs/remotes/origin/main', sha: 'b', row: 0 },
        ],
      },
    ],
    tags: [
      {
        name: 'v1.0.0',
        fullName: 'refs/tags/v1.0.0',
        sha: 'c',
        annotated: true,
        message: 'First',
        row: 9,
      },
    ],
    stashes: [
      {
        index: 0,
        name: 'stash@{0}',
        message: 'On main: try palette',
        sha: 'd',
        baseSha: 'e',
        untrackedSha: null,
        row: 3,
      },
    ],
    submodules: [],
    worktrees: [],
    ...patch,
  };
}

/** Compact picture of the rows: indentation by level, `+`/`-` for expanded/collapsed. */
function outline(rows: SidebarRow[]): string[] {
  return rows.map((row) => {
    const indent = '  '.repeat(row.level - 1);
    switch (row.type) {
      case 'section':
        return `${indent}${row.expanded ? '-' : '+'} ${row.section} (${String(row.count)})`;
      case 'folder':
        return `${indent}${row.expanded ? '-' : '+'} ${row.label}/ (${String(row.count)})`;
      case 'ref':
        return `${indent}${row.label}`;
      case 'empty':
        return `${indent}∅`;
    }
  });
}

const NO_UI = { open: {}, flat: false, filter: '' };

describe('buildSidebarRows', () => {
  it('groups branches by prefix, leaves first, with default expansion', () => {
    expect(outline(buildSidebarRows(refs(), NO_UI).rows)).toEqual([
      '- local (4)',
      '  main',
      '  - feat/ (2)',
      '    tabs',
      '    - graph/ (1)',
      '      lanes',
      '  - fix/ (1)',
      '    stash',
      '- remote (2)',
      '  - origin/ (2)',
      '    main',
      '    - feat/ (1)',
      '      tabs',
      '+ tags (1)',
      '- stashes (1)',
      '  try palette',
      '+ submodules (0)',
      '+ worktrees (0)',
    ]);
  });

  it('lists full names in flat mode', () => {
    const rows = buildSidebarRows(refs(), { ...NO_UI, flat: true }).rows;
    expect(outline(rows).slice(0, 5)).toEqual([
      '- local (4)',
      '  feat/graph/lanes',
      '  feat/tabs',
      '  fix/stash',
      '  main',
    ]);
  });

  it('honors collapsed folders and sections, and shows empty expanded sections', () => {
    const rows = buildSidebarRows(refs(), {
      ...NO_UI,
      open: { 'f:local:feat': false, 's:remote': false, 's:worktrees': true },
    }).rows;
    const lines = outline(rows);
    expect(lines).toContain('  + feat/ (2)');
    expect(lines).not.toContain('    tabs');
    expect(lines).toContain('+ remote (2)');
    expect(lines.slice(-2)).toEqual(['- worktrees (0)', '  ∅']);
  });

  it('computes ARIA positions among siblings', () => {
    const rows = buildSidebarRows(refs(), NO_UI).rows;
    const fix = rows.find((r) => r.key === 'f:local:fix');
    expect(fix).toMatchObject({ level: 2, posInSet: 3, setSize: 3, parent: 's:local' });
    const lanes = rows.find((r) => r.type === 'ref' && r.label === 'lanes');
    expect(lanes).toMatchObject({
      level: 4,
      posInSet: 1,
      setSize: 1,
      parent: 'f:local:feat/graph',
    });
  });

  it('filters every section, expands matches and highlights them', () => {
    const tree = buildSidebarRows(refs(), { ...NO_UI, filter: 'TABS' });
    expect(outline(tree.rows)).toEqual([
      '- local (1)',
      '  - feat/ (1)',
      '    tabs',
      '- remote (1)',
      '  - origin/ (1)',
      '    - feat/ (1)',
      '      tabs',
    ]);
    expect(tree.matches).toBe(2);
    const leaf = tree.rows[2];
    expect(leaf?.type === 'ref' && leaf.highlight).toEqual([0, 1, 2, 3]);
  });

  it('requires every token, in any order, and maps highlights onto the leaf', () => {
    const tree = buildSidebarRows(refs(), { ...NO_UI, filter: 'lanes feat' });
    expect(outline(tree.rows)).toEqual([
      '- local (1)',
      '  - feat/ (1)',
      '    - graph/ (1)',
      '      lanes',
    ]);
    const folder = tree.rows[1];
    expect(folder?.type === 'folder' && folder.highlight).toEqual([0, 1, 2, 3]);
  });

  it('opens collapsed sections while filtering, unless collapsed during the filter', () => {
    const tree = buildSidebarRows(refs(), { ...NO_UI, filter: 'v1' });
    expect(outline(tree.rows)).toEqual(['- tags (1)', '  v1.0.0']);
    const closed = buildSidebarRows(refs(), {
      open: { 's:tags': false },
      flat: false,
      filter: 'v1',
    });
    expect(outline(closed.rows)).toEqual(['+ tags (1)']);
  });

  it('matches stash messages and keeps all branches of a matching remote', () => {
    expect(outline(buildSidebarRows(refs(), { ...NO_UI, filter: 'palette' }).rows)).toEqual([
      '- stashes (1)',
      '  try palette',
    ]);
    const remote = buildSidebarRows(refs(), { ...NO_UI, filter: 'origin' });
    expect(remote.rows.find((r) => r.key === 'f:remote:origin')).toMatchObject({ count: 2 });
  });

  it('returns no rows when nothing matches', () => {
    expect(buildSidebarRows(refs(), { ...NO_UI, filter: 'zzz' })).toMatchObject({
      rows: [],
      matches: 0,
    });
  });

  it('shows a detached or unborn HEAD in Local', () => {
    const detached = buildSidebarRows(
      refs({ head: { kind: 'detached', oid: 'abc1234' }, local: [] }),
      NO_UI,
    );
    expect(outline(detached.rows).slice(0, 2)).toEqual(['- local (1)', '  HEAD']);
    const unborn = buildSidebarRows(
      refs({
        head: { kind: 'unborn', name: 'main' },
        local: [],
        remotes: [],
        tags: [],
        stashes: [],
      }),
      NO_UI,
    );
    expect(outline(unborn.rows).slice(0, 4)).toEqual([
      '- local (1)',
      '  main',
      '- remote (0)',
      '  ∅',
    ]);
  });

  it('builds 8 000 refs quickly', () => {
    const many = Array.from({ length: 5_000 }, (_, i) =>
      local(`team${String(i % 20)}/feat/${String(i % 7)}/b${String(i)}`),
    );
    const tags = Array.from({ length: 3_000 }, (_, i) => ({
      name: `v${String(i)}`,
      fullName: `refs/tags/v${String(i)}`,
      sha: 'x',
      annotated: false,
      message: null,
      row: null,
    }));
    const big = refs({ local: many, tags });
    const start = performance.now();
    const tree = buildSidebarRows(big, { ...NO_UI, open: { 's:tags': true } });
    buildSidebarRows(big, { ...NO_UI, filter: 'feat/3 b4' });
    expect(tree.rows.length).toBeGreaterThan(8_000);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('helpers', () => {
  it('matchAll needs every token', () => {
    expect(matchAll('feat/graph', ['gr', 'fe'])).toEqual([0, 1, 5, 6]);
    expect(matchAll('feat/graph', ['gr', 'x'])).toBeNull();
  });

  it('stashTitle drops the Git prefix', () => {
    expect(stashTitle('WIP on main: 3f9c2a1 fix: x')).toBe('3f9c2a1 fix: x');
    expect(stashTitle('On feat/a: try')).toBe('try');
    expect(stashTitle('custom')).toBe('custom');
  });
});
