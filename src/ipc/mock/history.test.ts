import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import type { OpOutcome } from '../bindings';
import { unwrap } from '../result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

/** Opens a repository and returns its id, the current branch and another local branch. */
async function open(path: string): Promise<{ id: number; current: string; other: string }> {
  const { id } = await unwrap(mock.openRepo(path));
  const refs = await unwrap(mock.listRefs(id));
  const current = refs.local.find((b) => b.isHead)?.name ?? '';
  const head = refs.local.find((b) => b.isHead)?.sha;
  const other = refs.local.find((b) => !b.isHead && b.sha !== head)?.name ?? '';
  return { id, current, other };
}

describe('mock history operations', () => {
  it('merges a branch with a merge commit', async () => {
    const { id, other } = await open('/Users/alex/dev/blog');
    const before = await unwrap(mock.repoState(id));
    const result = await unwrap(
      mock.merge(id, { source: other, mode: 'noFastForward', message: null }),
    );
    expect(result.effect).toBe('commits');
    expect(result.previousHead).toBe(before.head.kind === 'branch' ? before.head.oid : null);
    const detail = await unwrap(mock.commitDetail(id, result.head));
    expect(detail.parents).toHaveLength(2);
    expect(detail.summary).toBe(`Merge branch '${other}'`);
  });

  it('stops a merge on typed conflicts in a repository named conflict, then continues', async () => {
    const { id, other } = await open('/Users/alex/dev/conflict-demo');
    const stopped = await mock.merge(id, { source: other, mode: 'fastForward', message: null });
    expect(stopped).toMatchObject({
      status: 'error',
      error: {
        code: 'conflicts',
        payload: { kind: 'conflicts', operation: { kind: 'merge', squash: false } },
      },
    });
    const state = await unwrap(mock.repoState(id));
    expect(state.operation).toEqual({ kind: 'merge', squash: false });
    expect(state.dirty.conflicted).toBe(4);

    const list = await unwrap(mock.listConflicts(id));
    expect(list.files.map((f) => [f.path, f.kind, f.binary])).toEqual([
      ['assets/logo.png', 'content', true],
      ['docs/legacy.md', 'deletedByThem', false],
      ['src/app/App.tsx', 'content', false],
      ['src/theme/colors.ts', 'bothAdded', false],
    ]);
    expect(list.labels.theirs.branch).toBe(other);

    const versions = await unwrap(mock.conflictVersions(id, 'src/app/App.tsx'));
    expect(versions.base?.text).toContain('useState(0)');
    expect(versions.ours?.text).toContain('useState(1)');
    expect(versions.theirs?.text).toContain('useState(10)');
    expect(versions.merged?.text).toContain(`>>>>>>> ${other}`);

    await expect(mock.continueOperation(id, null)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'unresolvedConflicts' },
    });
    await unwrap(
      mock.resolveConflicts(id, ['assets/logo.png', 'docs/legacy.md'], { kind: 'ours' }),
    );
    await unwrap(mock.resolveConflicts(id, ['src/theme/colors.ts'], { kind: 'theirs' }));
    await unwrap(
      mock.resolveConflicts(id, ['src/app/App.tsx'], { kind: 'content', content: 'merged\n' }),
    );
    const detail = await unwrap(mock.operationDetail(id));
    expect(detail).toMatchObject({ unresolved: 0, canContinue: true, canSkip: false });
    expect((await unwrap(mock.listConflicts(id))).files.every((f) => f.resolved)).toBe(true);

    const done = await unwrap(mock.continueOperation(id, 'Merge it'));
    expect(done.effect).toBe('commits');
    expect((await unwrap(mock.commitDetail(id, done.head))).summary).toBe('Merge it');
    expect((await unwrap(mock.repoState(id))).operation).toBeNull();
    await expect(mock.continueOperation(id, null)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'noOperation' },
    });
  });

  it('refuses a fast-forward-only merge of diverged branches', async () => {
    const { id, other } = await open('/Users/alex/dev/blog');
    await expect(
      mock.merge(id, { source: other, mode: 'fastForwardOnly', message: null }),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'notFastForward' } });
  });

  it('fast-forwards a branch that is not checked out, without touching HEAD', async () => {
    const { id, current } = await open('/Users/alex/dev/yaggui');
    expect(await unwrap(mock.revisionRelation(id, 'feat/palette-31', 'main'))).toBe('behind');
    expect(await unwrap(mock.revisionRelation(id, 'main', 'feat/palette-31'))).toBe('ahead');
    expect(await unwrap(mock.revisionRelation(id, 'develop', 'main'))).toBe('diverged');
    const main = (await unwrap(mock.listRefs(id))).local.find((b) => b.name === 'main')?.sha;

    const result = await unwrap(mock.fastForward(id, { branch: 'feat/palette-31', to: 'main' }));
    expect(result).toMatchObject({ upToDate: false, sha: main });
    const refs = await unwrap(mock.listRefs(id));
    expect(refs.local.find((b) => b.name === 'feat/palette-31')?.sha).toBe(main);
    expect(refs.local.find((b) => b.isHead)?.name).toBe(current);
    expect((await unwrap(mock.undoState(id))).undo?.entry.op).toMatchObject({
      kind: 'fastForward',
      branch: 'feat/palette-31',
    });

    expect(
      await unwrap(mock.fastForward(id, { branch: 'main', to: 'feat/palette-31' })),
    ).toMatchObject({ upToDate: true });
    await expect(mock.fastForward(id, { branch: 'develop', to: 'main' })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'notFastForward' },
    });
  });

  it('simulates a rebase stopped at 3/7 that skips and stops again', async () => {
    const { id } = await open('/Users/alex/dev/blog');
    expect(mockBackend.simulateOperation(id, 'rebase', { step: 3, total: 7, stopsAgain: 1 })).toBe(
      true,
    );
    expect((await unwrap(mock.repoState(id))).operation).toMatchObject({
      kind: 'rebase',
      step: 3,
      total: 7,
    });
    await expect(
      mock.merge(id, { source: 'main', mode: 'fastForward', message: null }),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'operationInProgress' } });
    await expect(mock.skipOperation(id)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'conflicts' },
    });
    expect((await unwrap(mock.repoState(id))).operation).toMatchObject({ step: 4 });
    await unwrap(mock.skipOperation(id));
    expect((await unwrap(mock.repoState(id))).operation).toBeNull();
  });

  it('aborts an operation and restores the files', async () => {
    const { id } = await open('/Users/alex/dev/blog');
    mockBackend.simulateOperation(id, 'cherryPick');
    expect((await unwrap(mock.repoState(id))).dirty.conflicted).toBe(4);
    const outcomes: OpOutcome[] = [];
    const off = mockClient.events.subscribe('opFinished', (e) => outcomes.push(e.outcome));
    await unwrap(mock.abortOperation(id));
    off();
    // Like the backend: the abort is a success that reads "aborted", not "completed".
    expect(outcomes).toEqual([{ kind: 'success', note: 'aborted' }]);
    const state = await unwrap(mock.repoState(id));
    expect(state.operation).toBeNull();
    expect(state.dirty.conflicted).toBe(0);
  });

  it('adopts the rebase of the linux fixture', async () => {
    const { id } = await open('/Users/alex/dev/linux');
    const detail = await unwrap(mock.operationDetail(id));
    expect(detail).toMatchObject({
      operation: { kind: 'rebase', step: 3, total: 7 },
      labels: { theirs: { branch: 'sched/eevdf-fixes' } },
      unresolved: 1,
      canSkip: true,
    });
  });

  it('cherry-picks commits in graph order and asks a parent for merges', async () => {
    const { id, other } = await open('/Users/alex/dev/blog');
    const page = await unwrap(mock.graphPage(id, 0, 500));
    const merge = page.shas.find((_, i) => (page.parents[i]?.length ?? 0) > 1);
    if (merge) {
      await expect(
        mock.cherryPick(id, { commits: [merge], mainline: null }),
      ).resolves.toMatchObject({ status: 'error', error: { code: 'mainlineRequired' } });
    }
    const refs = await unwrap(mock.listRefs(id));
    const tip = refs.local.find((b) => b.name === other)?.sha ?? '';
    const parent = (await unwrap(mock.commitDetail(id, tip))).parents[0] ?? '';
    const result = await unwrap(mock.cherryPick(id, { commits: [tip, parent], mainline: null }));
    const head = await unwrap(mock.commitDetail(id, result.head));
    expect(head.summary).toBe((await unwrap(mock.commitDetail(id, tip))).summary);
  });

  it('previews and backs up a hard reset', async () => {
    const { id } = await open('/Users/alex/dev/yaggui');
    const preview = await unwrap(mock.resetPreview(id, 'HEAD~2'));
    expect(preview.commitsLeftBehind).toBe(2);
    expect(preview.hardLost.length).toBeGreaterThan(0);
    const result = await unwrap(mock.reset(id, { target: 'HEAD~2', mode: 'hard' }));
    expect(result.backupId).toMatch(/^mock-reset-/);
    expect(result.head).toBe(preview.target);
    const state = await unwrap(mock.repoState(id));
    expect(state.dirty).toMatchObject({ staged: 0, unstaged: 0, conflicted: 0 });
  });

  it('asks a parent to revert a merge and refuses one for a plain commit', async () => {
    const { id } = await open('/Users/alex/dev/blog');
    const head = (await unwrap(mock.repoState(id))).head;
    const sha = head.kind === 'branch' ? head.oid : '';
    await expect(mock.revert(id, { commit: sha, mainline: 2 })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    const result = await unwrap(mock.revert(id, { commit: sha, mainline: null }));
    expect((await unwrap(mock.commitDetail(id, result.head))).summary).toMatch(/^Revert "/);
  });
});
