import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { isValidRefName } from './refs';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

async function openYaggui(): Promise<number> {
  return (await unwrap(mock.openRepo('/Users/alex/dev/yaggui'))).id;
}

describe('mock refs operations', () => {
  it('validates ref names like check-ref-format', () => {
    for (const name of ['main', 'feat/x', 'v1.2.0', 'a-b_c'])
      expect(isValidRefName(name)).toBe(true);
    for (const name of ['', '-x', 'a..b', 'a b', 'x.lock', 'x/', '.x', 'a~1', 'a@{1}']) {
      expect(isValidRefName(name)).toBe(false);
    }
  });

  it('refuses an existing branch name', async () => {
    const id = await openYaggui();
    const result = await mock.validateRefName(id, 'branch', 'main');
    expect(result).toMatchObject({ status: 'error', error: { code: 'refExists' } });
    await expect(unwrap(mock.validateRefName(id, 'branch', 'feat/new'))).resolves.toBeNull();
  });

  it('refuses a checkout over local changes in clean mode, carries them otherwise', async () => {
    const id = await openYaggui();
    const refused = await mock.checkout(id, { kind: 'branch', name: 'main' }, 'clean');
    expect(refused).toMatchObject({
      status: 'error',
      error: { code: 'dirtyWorktree', payload: { kind: 'dirtyWorktree', canCarry: true } },
    });
    await unwrap(mock.checkout(id, { kind: 'branch', name: 'main' }, 'carry'));
    expect((await unwrap(mock.repoState(id))).head).toMatchObject({ kind: 'branch', name: 'main' });
  });

  it('creates a tracking branch from a remote branch', async () => {
    const id = await openYaggui();
    const refs = await unwrap(mock.listRefs(id));
    const remote = refs.remotes[0]?.branches.find(
      (b) => !refs.local.some((l) => `origin/${l.name}` === b.name),
    );
    expect(remote).toBeDefined();
    if (!remote) return;
    const result = await unwrap(
      mock.checkout(id, { kind: 'remote', name: remote.name }, 'stashAndPop'),
    );
    expect(result.created).toBe(true);
    const after = await unwrap(mock.listRefs(id));
    expect(after.local.find((b) => b.name === result.branch)?.upstream?.name).toBe(remote.name);
  });

  it('stashes, renames and pops', async () => {
    const id = await openYaggui();
    const pushed = await unwrap(
      mock.stashPush(id, { message: 'wip', includeUntracked: true, keepIndex: false }),
    );
    expect((await unwrap(mock.repoState(id))).dirty.unstaged).toBe(0);
    // The yaggui showcase has an untracked file: like Git, the stash gets a third parent.
    const listed = (await unwrap(mock.listRefs(id))).stashes[0];
    expect(listed?.sha).toBe(pushed.sha);
    expect(listed?.untrackedSha).toMatch(/^[0-9a-f]{40}$/);
    const renamed = await unwrap(mock.stashRename(id, { index: 0, sha: pushed.sha }, 'renamed'));
    expect(renamed).toEqual({ sha: pushed.sha, message: 'renamed' });
    const stale = await mock.stashDrop(id, { index: 0, sha: 'deadbeef' });
    expect(stale).toMatchObject({ status: 'error', error: { code: 'staleRefs' } });
    await unwrap(mock.stashPop(id, { index: 0, sha: pushed.sha }));
    expect((await unwrap(mock.repoState(id))).dirty.unstaged).toBeGreaterThan(0);
  });

  it('refuses to delete the current branch and an unmerged one', async () => {
    const id = await openYaggui();
    const current = await mock.deleteBranch(id, {
      name: 'feat/graph-lanes',
      force: false,
      deleteRemote: false,
    });
    expect(current).toMatchObject({ status: 'error', error: { code: 'currentBranch' } });
    await unwrap(mock.createBranch(id, 'topic', { kind: 'head' }, false));
    await unwrap(mock.checkout(id, { kind: 'branch', name: 'main' }, 'carry'));
    const unmerged = await mock.deleteBranch(id, {
      name: 'topic',
      force: false,
      deleteRemote: false,
    });
    expect(unmerged).toMatchObject({
      status: 'error',
      error: { code: 'branchNotMerged', action: { kind: 'forceDelete' } },
    });
    const deleted = await unwrap(
      mock.deleteBranch(id, { name: 'topic', force: true, deleteRemote: false }),
    );
    expect(deleted.local.fullName).toBe('refs/heads/topic');
  });

  it('creates an annotated tag', async () => {
    const id = await openYaggui();
    await unwrap(
      mock.createTag(id, {
        name: 'v9.0.0',
        target: 'HEAD',
        message: 'Release\n\nNotes',
        sign: false,
      }),
    );
    const tag = (await unwrap(mock.listRefs(id))).tags.find((t) => t.name === 'v9.0.0');
    expect(tag).toMatchObject({ annotated: true, message: 'Release' });
  });
});
