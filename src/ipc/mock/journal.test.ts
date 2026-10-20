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

async function headSha(id: number): Promise<string> {
  const { head } = await unwrap(mock.repoState(id));
  return head.kind === 'unborn' ? '' : head.oid;
}

describe('mock undo journal', () => {
  it('undoes and redoes a commit, and lists it in the history', async () => {
    const id = await openYaggui();
    const before = await headSha(id);
    await unwrap(mock.stagePaths(id, { kind: 'all' }));
    const { sha } = await unwrap(
      mock.commit(id, { summary: 'feat: x', description: '', amend: false, skipHooks: true }),
    );

    const state = await unwrap(mock.undoState(id));
    expect(state.undo).toMatchObject({
      entry: { op: { kind: 'commit', sha, summary: 'feat: x' }, undone: false },
      blocked: null,
    });
    expect(state.redo).toBeNull();

    const undone = await unwrap(mock.undo(id));
    expect(undone).toMatchObject({ op: { kind: 'commit' }, undone: true });
    expect(await headSha(id)).toBe(before);
    expect((await unwrap(mock.undoState(id))).redo?.entry.id).toBe(undone.id);

    await unwrap(mock.redo(id));
    expect(await headSha(id)).toBe(sha);
    const history = await unwrap(mock.opHistory(id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ undone: false });
    expect((await mock.redo(id)).status === 'error').toBe(true);
  });

  it('refuses with nothingToUndo, then undoBlocked after a push', async () => {
    const id = await openYaggui();
    expect(await mock.undo(id)).toMatchObject({
      status: 'error',
      error: { code: 'nothingToUndo' },
    });
    await unwrap(mock.createBranch(id, 'topic', { kind: 'head' }, false));
    await unwrap(
      mock.push(id, {
        remote: 'origin',
        branch: 'topic',
        setUpstream: true,
        forceWithLease: false,
        expectedSha: null,
      }),
    );
    const state = await unwrap(mock.undoState(id));
    expect(state.undo).toMatchObject({
      entry: { op: { kind: 'push' } },
      blocked: { kind: 'published' },
    });
    expect(await mock.undo(id)).toMatchObject({
      status: 'error',
      error: {
        code: 'undoBlocked',
        payload: { kind: 'undoBlocked', reason: { kind: 'published' } },
      },
    });
  });

  it('refuses an undo once the refs moved elsewhere', async () => {
    const id = await openYaggui();
    await unwrap(mock.createBranch(id, 'topic', { kind: 'head' }, true));
    mockBackend.simulateCommit(id, 'from a terminal');
    const state = await unwrap(mock.undoState(id));
    expect(state.undo?.blocked).toEqual({ kind: 'diverged', refs: ['refs/heads/topic'] });
    expect(await mock.undo(id)).toMatchObject({
      status: 'error',
      error: { code: 'undoDiverged', payload: { refs: ['refs/heads/topic'] } },
    });
  });

  it('puts discarded changes back, and discards them again on redo', async () => {
    const id = await openYaggui();
    const unstaged = await unwrap(mock.changedFiles(id, { kind: 'unstaged' }));
    const path = unstaged.files[0]?.path ?? '';
    await unwrap(mock.discardPaths(id, { kind: 'paths', paths: [path] }, false));
    const paths = async () =>
      (await unwrap(mock.changedFiles(id, { kind: 'unstaged' }))).files.map((f) => f.path);
    expect(await paths()).not.toContain(path);
    expect((await unwrap(mock.undoState(id))).undo?.entry.op).toEqual({
      kind: 'discard',
      paths: [path],
      count: 1,
    });
    await unwrap(mock.undo(id));
    expect(await paths()).toContain(path);
    await unwrap(mock.redo(id));
    expect(await paths()).not.toContain(path);
  });

  it('undoes a branch rename and a checkout', async () => {
    const id = await openYaggui();
    await unwrap(mock.createBranch(id, 'topic', { kind: 'head' }, false));
    await unwrap(mock.renameBranch(id, 'topic', 'renamed'));
    await unwrap(mock.checkout(id, { kind: 'branch', name: 'renamed' }, 'carry'));
    expect((await unwrap(mock.repoState(id))).head).toMatchObject({ name: 'renamed' });

    await unwrap(mock.undo(id));
    expect((await unwrap(mock.repoState(id))).head).not.toMatchObject({ name: 'renamed' });
    await unwrap(mock.undo(id));
    const refs = await unwrap(mock.listRefs(id));
    expect(refs.local.map((b) => b.name)).toContain('topic');
    expect(refs.local.map((b) => b.name)).not.toContain('renamed');
    await unwrap(mock.undo(id));
    expect((await unwrap(mock.listRefs(id))).local.map((b) => b.name)).not.toContain('topic');
  });

  it('puts a dropped stash back on top, and drops it again on redo', async () => {
    const id = await openYaggui();
    const stash = await unwrap(
      mock.stashPush(id, { message: 'wip', includeUntracked: true, keepIndex: false }),
    );
    await unwrap(mock.stashDrop(id, { index: 0, sha: stash.sha }));
    const stashes = async () => (await unwrap(mock.listRefs(id))).stashes.map((s) => s.sha);
    expect(await stashes()).not.toContain(stash.sha);
    await unwrap(mock.undo(id));
    expect((await stashes())[0]).toBe(stash.sha);
    await unwrap(mock.redo(id));
    expect(await stashes()).not.toContain(stash.sha);
  });
  it('keeps the journal when the repository closes, flagged as restored', async () => {
    const id = await openYaggui();
    const before = await headSha(id);
    await unwrap(mock.stagePaths(id, { kind: 'all' }));
    await unwrap(
      mock.commit(id, { summary: 'feat: x', description: '', amend: false, skipHooks: true }),
    );
    await unwrap(mock.closeRepo(id));
    expect(await openYaggui()).toBe(id);

    const [entry] = await unwrap(mock.opHistory(id));
    expect(entry).toMatchObject({ op: { kind: 'commit' }, restored: true, blocked: null });
    await unwrap(mock.undo(id));
    expect(await headSha(id)).toBe(before);
  });

  it('refuses a restored entry whose objects were pruned, changing nothing', async () => {
    const id = await openYaggui();
    await unwrap(mock.stagePaths(id, { kind: 'all' }));
    const { sha } = await unwrap(
      mock.commit(id, { summary: 'feat: x', description: '', amend: false, skipHooks: true }),
    );
    mockBackend.simulateRestoredJournal(id, { pruned: true });

    const state = await unwrap(mock.undoState(id));
    expect(state.undo?.blocked).toEqual({ kind: 'objectsMissing', count: 1 });
    expect((await unwrap(mock.opHistory(id)))[0]?.blocked).toEqual({
      kind: 'objectsMissing',
      count: 1,
    });
    expect(await mock.undo(id)).toMatchObject({
      status: 'error',
      error: { code: 'undoObjectsMissing' },
    });
    expect(await headSha(id)).toBe(sha);
  });

  it('drops the journal with the repository', async () => {
    const id = await openYaggui();
    await unwrap(mock.createBranch(id, 'topic', { kind: 'head' }, false));
    await unwrap(mock.closeRepo(id));
    await unwrap(mock.forgetRepo(id));
    const again = await openYaggui();
    expect(await unwrap(mock.opHistory(again))).toEqual([]);
  });
});
