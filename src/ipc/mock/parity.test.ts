import { beforeEach, describe, expect, it } from 'vitest';

import type { RebaseAction } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

/**
 * Where the M3-5 audit found the mock and the real backend apart. The reference is the real
 * backend (`src-tauri/tests/conflict_scenarios.rs`, `history.rs`, `interactive_rebase.rs`).
 */
describe('mock / backend parity (M3)', () => {
  it('a diverged pull stops with `conflicts` and resolves like a merge', async () => {
    // `blog` is behind origin/main: a local commit makes it diverge.
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    mockBackend.simulateCommit(id, 'local work');
    mockBackend.simulatePullConflict(id);

    const stopped = await mock.pull(id, 'merge');
    expect(stopped).toMatchObject({
      status: 'error',
      error: {
        code: 'conflicts',
        payload: { kind: 'conflicts', operation: { kind: 'merge', squash: false } },
      },
    });
    if (stopped.status !== 'error') return;
    expect(stopped.error.message.en).toMatch(/^The pull stopped on conflicts/);
    expect((await unwrap(mock.repoState(id))).operation).toEqual({ kind: 'merge', squash: false });

    const { files } = await unwrap(mock.listConflicts(id));
    await unwrap(
      mock.resolveConflicts(
        id,
        files.map((f) => f.path),
        { kind: 'ours' },
      ),
    );
    const done = await unwrap(mock.continueOperation(id, null));
    expect(done.effect).toBe('commits');
    expect((await unwrap(mock.commitDetail(id, done.head))).parents).toHaveLength(2);
    expect((await unwrap(mock.repoState(id))).operation).toBeNull();
  });

  it('a diverged rebase pull stops as a rebase of the branch onto its upstream', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    mockBackend.simulateCommit(id, 'local work');
    mockBackend.simulatePullConflict(id);
    const stopped = await mock.pull(id, 'rebase');
    expect(stopped).toMatchObject({
      status: 'error',
      error: { code: 'conflicts', payload: { operation: { kind: 'rebase', headName: 'main' } } },
    });
    const state = await unwrap(mock.repoState(id));
    expect(state.head.kind).toBe('detached');
    const detail = await unwrap(mock.operationDetail(id));
    expect(detail?.labels.ours.branch).toBe('origin/main');
    expect(detail?.labels.theirs.commit?.summary).toBe('local work');
  });

  it('an interactive rebase halts on each `edit`, continue after continue', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const plan = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~4'));
    const actions: RebaseAction[] = ['pick', 'edit', 'pick', 'edit'];
    const result = await unwrap(
      mock.interactiveRebase(
        id,
        'HEAD~4',
        plan.commits.map((c, i) => ({ sha: c.sha, action: actions[i] ?? 'pick', message: null })),
      ),
    );
    expect(result.stopped).toMatchObject({ step: 2, total: 4 });
    const first = await unwrap(mock.operationDetail(id));
    expect(first?.labels.ours.commit?.sha).toBe(plan.base.sha);
    expect(first?.message).toContain(plan.commits[1]?.summary ?? '?');

    await unwrap(mock.continueOperation(id, null));
    expect((await unwrap(mock.repoState(id))).operation).toMatchObject({
      kind: 'rebase',
      step: 4,
      total: 4,
    });
    await unwrap(mock.continueOperation(id, null));
    const state = await unwrap(mock.repoState(id));
    expect(state.operation).toBeNull();
    expect(state.head).toMatchObject({ kind: 'branch', name: 'main' });
  });

  it('a rebase stopped on conflicts shows HEAD detached', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/conflict-demo'));
    const refs = await unwrap(mock.listRefs(id));
    const head = refs.local.find((b) => b.isHead);
    const other = refs.local.find((b) => !b.isHead && b.sha !== head?.sha);
    await mock.rebase(id, { branch: null, onto: other?.sha ?? '' });
    expect((await unwrap(mock.repoState(id))).head.kind).toBe('detached');
  });

  it('validates the parent of a cherry-pick or revert like `check_mainline`', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const plan = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~4'));
    const head = { sha: plan.commits[2]?.sha ?? '' };
    const pick = (mainline: number) => mock.cherryPick(id, { commits: [head.sha], mainline });
    expect(await pick(0)).toMatchObject({ error: { code: 'invalidArgument' } });
    expect(await pick(2)).toMatchObject({
      error: { message: { en: `Parent 2 does not exist for ${head.sha.slice(0, 7)}.` } },
    });
    expect(await mock.revert(id, { commit: head.sha, mainline: 1 })).toMatchObject({
      error: { code: 'invalidArgument' },
    });
  });

  it('a commit already applied stops empty: continue needs a change, skip ends it', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/empty-pick'));
    const plan = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~2'));
    const head = { sha: plan.commits[0]?.sha ?? '' };
    expect(await mock.cherryPick(id, { commits: [head.sha], mainline: null })).toMatchObject({
      error: { code: 'emptyCommit' },
    });
    expect((await unwrap(mock.repoState(id))).operation).toEqual({ kind: 'cherryPick' });
    expect(await mock.continueOperation(id, null)).toMatchObject({
      error: { code: 'emptyCommit' },
    });
    const skipped = await unwrap(mock.skipOperation(id));
    expect(skipped.effect).toBe('upToDate');
    expect((await unwrap(mock.repoState(id))).operation).toBeNull();
  });

  it('a rebase with nothing to replay fast-forwards', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const result = await unwrap(mock.rebase(id, { branch: null, onto: 'origin/main' }));
    expect(result.effect).toBe('fastForward');
  });

  it('a resolved binary conflict is no longer reported as binary', async () => {
    const { id, other } = await openWithOther('/Users/alex/dev/conflict-demo');
    await mock.merge(id, { source: other, mode: 'noFastForward', message: null });
    await unwrap(mock.resolveConflicts(id, ['assets/logo.png'], { kind: 'theirs' }));
    const logo = (await unwrap(mock.listConflicts(id))).files.find(
      (f) => f.path === 'assets/logo.png',
    );
    expect(logo).toEqual({ path: 'assets/logo.png', kind: null, binary: false, resolved: true });
  });
});

async function openWithOther(path: string): Promise<{ id: number; other: string }> {
  const { id } = await unwrap(mock.openRepo(path));
  const refs = await unwrap(mock.listRefs(id));
  const head = refs.local.find((b) => b.isHead)?.sha;
  return { id, other: refs.local.find((b) => !b.isHead && b.sha !== head)?.name ?? '' };
}

/**
 * Where the M4-8 audit found the mock and the real backend apart (reference: the Rust tests
 * named in each case).
 */
describe('mock / backend parity (M4)', () => {
  it('an undo that would overwrite files changed since is refused (`undo.rs`)', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    await unwrap(mock.discardPaths(id, { kind: 'paths', paths: ['README.md'] }, true));
    expect(mockBackend.simulateEdit(id, 'README.md', 'edited since\n')).toBe(true);
    expect(await mock.undo(id)).toMatchObject({
      status: 'error',
      error: { code: 'undoWouldOverwrite', payload: { kind: 'undoChanges', paths: ['README.md'] } },
    });
  });

  it('a reset during an operation follows Git (`history.rs`, reset_during_…)', async () => {
    const merge = await openWithOther('/Users/alex/dev/conflict-reset');
    await mock.merge(merge.id, { source: merge.other, mode: 'noFastForward', message: null });
    const reset = (id: number, mode: 'soft' | 'mixed' | 'hard') =>
      mock.reset(id, { target: 'HEAD', mode });
    expect(await reset(merge.id, 'soft')).toMatchObject({
      error: { code: 'operationInProgress' },
    });
    expect((await unwrap(mock.repoState(merge.id))).operation?.kind).toBe('merge');
    await unwrap(reset(merge.id, 'mixed'));
    expect((await unwrap(mock.repoState(merge.id))).operation).toBeNull();

    // A cherry-pick of several commits stays in progress after a hard reset.
    const pick = await unwrap(mock.openRepo('/Users/alex/dev/conflict-picks'));
    const plan = await unwrap(mock.interactiveRebasePlan(pick.id, 'HEAD~3'));
    const shas = plan.commits.slice(0, 2).map((c) => c.sha);
    expect(await mock.cherryPick(pick.id, { commits: shas, mainline: null })).toMatchObject({
      error: { code: 'conflicts' },
    });
    await unwrap(reset(pick.id, 'hard'));
    expect((await unwrap(mock.repoState(pick.id))).operation).toEqual({ kind: 'cherryPick' });
  });

  it('the hard reset preview lists untracked files the target tracks', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    // Commits made by the mock touch `README.md`.
    mockBackend.simulateCommit(id, 'tracks README');
    mockBackend.simulateEdit(id, 'README.md', 'untracked copy\n');
    const preview = await unwrap(mock.resetPreview(id, 'HEAD'));
    expect(preview.hardLost).toContainEqual({ path: 'README.md', change: 'untracked' });
  });

  it('the external merge tool can fail or be closed without saving (`history.rs`)', async () => {
    for (const [path, expected] of [
      ['/Users/alex/dev/conflict-mergetool-fails', { error: { code: 'mergeToolFailed' } }],
      ['/Users/alex/dev/conflict-mergetool-unsaved', { data: { resolved: false } }],
    ] as const) {
      const { id, other } = await openWithOther(path);
      await mock.merge(id, { source: other, mode: 'noFastForward', message: null });
      expect(await mock.runMergeTool(id, 'src/app/App.tsx')).toMatchObject(expected);
      expect((await unwrap(mock.listConflicts(id))).unresolved).toBe(4);
    }
  });
});
