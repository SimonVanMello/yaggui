import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

async function openYaggui(): Promise<number> {
  const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
  return id;
}

async function allRows(id: number): Promise<{ total: number; shas: string[]; labels: string[] }> {
  const page = await unwrap(mock.graphPage(id, 0, 500));
  return { total: page.totalRows, shas: page.shas, labels: page.refs.map((r) => r.label.name) };
}

/** Local branches the cleanup may delete: not checked out, not protected by default. */
const deletable = (b: { name: string; isHead: boolean }) =>
  !b.isHead &&
  !['main', 'develop', 'fix/stale-review'].includes(b.name) &&
  !b.name.startsWith('release/');

const EMPTY = { hidden: [], solo: null, hideRemotes: false, hideStashes: false };

describe('mock graph filter', () => {
  it('hides a branch, solos one and shows everything again', async () => {
    const id = await openYaggui();
    const all = await allRows(id);
    expect(all.labels).toContain('main');
    const refs = await unwrap(mock.listRefs(id));
    const branch = refs.local.find((b) => !b.isHead && b.name !== 'main');
    expect(branch).toBeDefined();
    if (!branch) return;

    const stored = await unwrap(
      mock.setGraphFilter(id, { ...EMPTY, hidden: [branch.fullName, branch.fullName] }),
    );
    expect(stored.hidden).toEqual([branch.fullName]);
    const hidden = await allRows(id);
    expect(hidden.labels).not.toContain(branch.name);
    expect(await unwrap(mock.graphFilter(id))).toEqual(stored);

    await unwrap(mock.setGraphFilter(id, { ...EMPTY, solo: 'refs/heads/main' }));
    const solo = await allRows(id);
    expect(solo.total).toBeLessThan(all.total);
    expect(solo.labels).toContain('main');

    await unwrap(mock.setGraphFilter(id, { ...EMPTY, hideRemotes: true }));
    expect((await allRows(id)).labels.some((l) => l.startsWith('origin/'))).toBe(false);

    await unwrap(mock.setGraphFilter(id, EMPTY));
    expect((await allRows(id)).shas).toEqual(all.shas);
  });

  it('refuses names that are not branches or tags', async () => {
    const id = await openYaggui();
    for (const bad of ['HEAD', 'main', 'refs/stash', 'refs/heads/../x']) {
      const result = await mock.setGraphFilter(id, { ...EMPTY, hidden: [bad] });
      expect(result).toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
    }
  });
});

describe('mock merge-base and comparison', () => {
  it('finds the merge-base and the commits of each side', async () => {
    const id = await openYaggui();
    const refs = await unwrap(mock.listRefs(id));
    const head = refs.local.find((b) => b.isHead);
    expect(head).toBeDefined();
    if (!head) return;
    const base = await unwrap(mock.mergeBase(id, head.name, 'main'));
    expect(base?.sha).toMatch(/^[0-9a-f]{40}$/);
    const cmp = await unwrap(mock.compareRevisions(id, head.name, 'main'));
    expect(cmp.mergeBase).toBe(base?.sha);
    expect(cmp.onlyACount).toBe(cmp.onlyA.length);
    expect(cmp.onlyA.length).toBeGreaterThan(0);
    const same = await unwrap(mock.compareRevisions(id, 'main', 'main'));
    expect(same.onlyA).toEqual([]);
    expect(await mock.mergeBase(id, 'main', 'nope')).toMatchObject({
      status: 'error',
      error: { code: 'revisionNotFound' },
    });
  });
});

describe('mock branch cleanup', () => {
  it('lists gone and merged branches, never the protected or checked out ones', async () => {
    const id = await openYaggui();
    const cleanup = await unwrap(mock.branchCleanup(id));
    expect(cleanup.into).toBe('feat/graph-lanes');
    const names = cleanup.branches.map((b) => b.name);
    expect(names).not.toContain('feat/graph-lanes');
    expect(names).not.toContain('main');
    expect([...cleanup.protected, ...cleanup.checkedOut, ...names]).toContain('fix/stale-review');
    for (const b of cleanup.branches) expect(b.merged || b.gone).toBe(true);
  });

  it('deletes the chosen branches in one undoable operation', async () => {
    const id = await openYaggui();
    const refs = await unwrap(mock.listRefs(id));
    const victims = refs.local
      .filter(deletable)
      .slice(0, 2)
      .map((b) => b.name);
    expect(victims).toHaveLength(2);
    const result = await unwrap(mock.deleteBranches(id, victims));
    expect(result.deleted.map((d) => d.fullName)).toEqual(victims.map((v) => `refs/heads/${v}`));
    const after = (await unwrap(mock.listRefs(id))).local.map((b) => b.name);
    for (const v of victims) expect(after).not.toContain(v);
    const history = await unwrap(mock.opHistory(id));
    expect(history[0]?.op).toEqual({ kind: 'deleteBranches', names: victims, count: 2 });
    await unwrap(mock.undo(id));
    const restored = (await unwrap(mock.listRefs(id))).local.map((b) => b.name);
    for (const v of victims) expect(restored).toContain(v);
  });

  it('refuses the current, protected and missing branches without deleting anything', async () => {
    const id = await openYaggui();
    const refs = await unwrap(mock.listRefs(id));
    const other = refs.local.find(deletable);
    if (!other) throw new Error('no branch');
    for (const [name, code] of [
      ['feat/graph-lanes', 'currentBranch'],
      ['main', 'protectedBranchDelete'],
      ['nope', 'revisionNotFound'],
    ] as const) {
      const result = await mock.deleteBranches(id, [other.name, name]);
      expect(result).toMatchObject({ status: 'error', error: { code } });
    }
    expect((await unwrap(mock.listRefs(id))).local.map((b) => b.name)).toContain(other.name);
  });
});

describe('mock image diff and external tools', () => {
  it('serves images as data URLs, nothing for other files', async () => {
    const id = await openYaggui();
    const target = { kind: 'commits' as const, from: null, to: 'HEAD' };
    const old = await unwrap(mock.diffImage(id, target, 'assets/screenshot.png', null, 'old'));
    const now = await unwrap(mock.diffImage(id, target, 'assets/screenshot.png', null, 'new'));
    expect(old).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(now).not.toBe(old);
    expect(await unwrap(mock.diffImage(id, target, 'docs/diff.md', null, 'new'))).toBeNull();
    expect(await mock.diffImage(id, target, '../x.png', null, 'new')).toMatchObject({
      status: 'error',
    });
  });

  it('runs the diff tool of the preferences, refuses when none is set', async () => {
    const id = await openYaggui();
    const target = { kind: 'commits' as const, from: null, to: 'HEAD' };
    expect(await mock.runDiffTool(id, target, 'docs/diff.md', null)).toMatchObject({
      status: 'error',
      error: { code: 'diffToolMissing' },
    });
    const prefs = await unwrap(mock.getPreferences());
    await unwrap(mock.setPreferences({ ...prefs, diffTool: 'meld' }));
    expect(await unwrap(mock.runDiffTool(id, target, 'docs/diff.md', null))).toBe('meld');
    expect(mockBackend.externalDiffs).toContainEqual({
      repoId: id,
      path: 'docs/diff.md',
      tool: 'meld',
    });
    await unwrap(mock.revealPath(id, 'docs/diff.md'));
    expect(mockBackend.revealed).toContainEqual({ repoId: id, path: 'docs/diff.md' });
  });
});
