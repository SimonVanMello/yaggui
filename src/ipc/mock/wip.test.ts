import { beforeEach, describe, expect, it } from 'vitest';

import type { DiffOptions, FileDiff, HunkChange } from '../bindings';
import { mockBackend } from '../mockClient';
import { textDiff } from './lineDiff';
import { blobId, MockWip } from './wip';

const OPTIONS: DiffOptions = {
  ignoreWhitespace: false,
  contextLines: 3,
  fullFile: false,
  force: false,
};

const numbered = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${String(i + 1)}\n`).join('');

function wipWith(index: string, worktree: string): MockWip {
  return MockWip.fromChanges(
    [],
    [
      {
        path: 'f.txt',
        status: 'modified',
        oldMode: 'regular',
        newMode: 'regular',
        old: index,
        new: worktree,
      },
    ],
  );
}

function diffOf(wip: MockWip, list: 'staged' | 'unstaged') {
  const change = wip.changes(list).find((c) => c.path === 'f.txt');
  if (!change) throw new Error('no change');
  return change;
}

describe('mock working state', () => {
  it('stages, unstages and discards single lines like Git', () => {
    const index = numbered(10);
    const worktree = index.replace('line 4\n', 'four\n').replace('line 6\n', 'six\n');
    const wip = wipWith(index, worktree);
    const hunks = textDiff(index, worktree, OPTIONS).hunks;
    const hunk = hunks[0];
    if (!hunk) throw new Error('no hunk');
    expect(hunk.kinds).toBe('   -+ -+   ');
    const change = (oldId: string | null, newId: string | null, lines: number[]): HunkChange => ({
      path: 'f.txt',
      oldPath: null,
      oldId,
      newId,
      options: OPTIONS,
      hunks: [{ id: hunk.id, lines }],
    });
    // `-line 6` / `+six` only (indexes 6 and 7).
    expect(wip.applyHunks('stage', change(blobId(index), blobId(worktree), [6, 7]))).toEqual({
      ok: null,
    });
    expect(diffOf(wip, 'staged').new).toBe(index.replace('line 6\n', 'six\n'));
    expect(diffOf(wip, 'unstaged').old).toBe(index.replace('line 6\n', 'six\n'));
    // Discard `+four` alone from the working tree: `line 4` is gone from both sides.
    const staged = index.replace('line 6\n', 'six\n');
    const rest = textDiff(staged, worktree, OPTIONS).hunks[0];
    if (!rest) throw new Error('no hunk');
    const plus = rest.kinds.indexOf('+');
    expect(
      wip.applyHunks('discard', {
        ...change(blobId(staged), blobId(worktree), [plus]),
        hunks: [{ id: rest.id, lines: [plus] }],
      }),
    ).toEqual({ ok: null });
    expect(diffOf(wip, 'unstaged').new).toBe(staged.replace('line 4\n', ''));
    // A selection made on a diff that no longer exists is refused.
    expect(wip.applyHunks('stage', change(blobId(index), blobId(worktree), [3]))).toMatchObject({
      error: { code: 'staleDiff' },
    });
  });

  it('keeps a line picked from a block of replaced lines in place', () => {
    const index = numbered(10);
    const worktree = index
      .replace('line 4\n', 'FOUR\n')
      .replace('line 5\n', 'FIVE\n')
      .replace('line 6\n', 'SIX\n');
    const wip = wipWith(index, worktree);
    const hunk = textDiff(index, worktree, OPTIONS).hunks[0];
    if (!hunk) throw new Error('no hunk');
    expect(hunk.kinds).toBe('   ---+++   ');
    // `-line 5` / `+FIVE` (indexes 4 and 7).
    expect(
      wip.applyHunks('stage', {
        path: 'f.txt',
        oldPath: null,
        oldId: blobId(index),
        newId: blobId(worktree),
        options: OPTIONS,
        hunks: [{ id: hunk.id, lines: [4, 7] }],
      }),
    ).toEqual({ ok: null });
    expect(diffOf(wip, 'staged').new).toBe(index.replace('line 5\n', 'FIVE\n'));
  });
});

describe('mock write commands', () => {
  beforeEach(() => {
    mockBackend.reset();
  });

  async function open(): Promise<number> {
    const result = await mockBackend.commands.openRepo('/Users/alex/dev/yaggui');
    if (result.status !== 'ok') throw new Error('open failed');
    return result.data.id;
  }

  async function fileDiff(repoId: number, kind: 'staged' | 'unstaged', path: string) {
    const result = await mockBackend.commands.fileDiff(repoId, { kind }, path, null, OPTIONS);
    if (result.status !== 'ok') throw new Error('diff failed');
    return result.data;
  }

  function selection(diff: FileDiff, lines: number[] | null): HunkChange {
    if (diff.content.kind !== 'text') throw new Error('not text');
    const hunk = diff.content.hunks[0];
    if (!hunk) throw new Error('no hunk');
    return {
      path: diff.path,
      oldPath: diff.oldPath,
      oldId: diff.oldId,
      newId: diff.newId,
      options: OPTIONS,
      hunks: [{ id: hunk.id, lines }],
    };
  }

  async function paths(repoId: number, kind: 'staged' | 'unstaged') {
    const result = await mockBackend.commands.changedFiles(repoId, { kind });
    if (result.status !== 'ok') throw new Error('list failed');
    return result.data.files.map((f) => `${f.status}:${f.path}`);
  }

  it('stages and unstages whole files, with the operation events', async () => {
    const repoId = await open();
    const kinds: string[] = [];
    const off = mockBackend.events.subscribe('opFinished', (e) => kinds.push(e.kind));
    expect(await paths(repoId, 'unstaged')).toContain('untracked:notes/todo.md');
    await mockBackend.commands.stagePaths(repoId, { kind: 'paths', paths: ['notes/todo.md'] });
    expect(await paths(repoId, 'staged')).toContain('added:notes/todo.md');
    await mockBackend.commands.unstagePaths(repoId, { kind: 'all' });
    expect(await paths(repoId, 'staged')).toEqual([]);
    await mockBackend.commands.stagePaths(repoId, { kind: 'all' });
    expect(await paths(repoId, 'unstaged')).toEqual([]);
    off();
    expect(kinds).toEqual(['stage', 'stage', 'stage']);
    const state = await mockBackend.commands.repoState(repoId);
    expect(state.status === 'ok' && state.data.dirty.unstaged).toBe(0);
  });

  it('stages one line of a hunk and refuses a stale selection', async () => {
    const repoId = await open();
    const diff = await fileDiff(repoId, 'unstaged', 'src/ui/Icon.tsx');
    if (diff.content.kind !== 'text') throw new Error('not text');
    const plus = diff.content.hunks[0]?.kinds.indexOf('+') ?? -1;
    const staged = await mockBackend.commands.stageHunks(repoId, selection(diff, [plus]));
    expect(staged.status).toBe('ok');
    const after = await fileDiff(repoId, 'staged', 'src/ui/Icon.tsx');
    expect(after.content.kind === 'text' && after.content.additions).toBe(1);
    // Same selection again: the index moved, the ids no longer match.
    const again = await mockBackend.commands.stageHunks(repoId, selection(diff, [plus]));
    expect(again).toMatchObject({ status: 'error', error: { code: 'staleDiff' } });
  });

  it('discards hunks and files with a backup id', async () => {
    const repoId = await open();
    const diff = await fileDiff(repoId, 'unstaged', 'README.md');
    const discarded = await mockBackend.commands.discardHunks(repoId, selection(diff, null));
    expect(discarded.status === 'ok' && discarded.data.backupId).toMatch(/^mock-/);
    expect(await paths(repoId, 'unstaged')).not.toContain('modified:README.md');
    const all = await mockBackend.commands.discardPaths(repoId, { kind: 'all' }, false);
    expect(all.status).toBe('ok');
    expect(await paths(repoId, 'unstaged')).toEqual([]);
    expect(await paths(repoId, 'staged')).toHaveLength(2);
  });

  it('commits, amends and reports hook failures', async () => {
    const repoId = await open();
    const empty = { summary: 'feat: x', description: '', amend: false, skipHooks: false };
    const hook = await mockBackend.commands.commit(repoId, { ...empty, summary: 'x [hook-fail]' });
    expect(hook).toMatchObject({
      status: 'error',
      error: { code: 'hookFailed', payload: { kind: 'hook', hook: 'pre-commit' } },
    });
    const done = await mockBackend.commands.commit(repoId, { ...empty, description: 'body' });
    expect(done.status).toBe('ok');
    expect(await paths(repoId, 'staged')).toEqual([]);
    const message = await mockBackend.commands.lastCommitMessage(repoId);
    expect(message).toMatchObject({ data: { summary: 'feat: x', description: 'body' } });
    const nothing = await mockBackend.commands.commit(repoId, empty);
    expect(nothing).toMatchObject({ error: { code: 'nothingToCommit' } });
    const amend = await mockBackend.commands.commit(repoId, {
      ...empty,
      summary: 'feat: y',
      amend: true,
    });
    expect(amend.status).toBe('ok');
    expect(await mockBackend.commands.lastCommitMessage(repoId)).toMatchObject({
      data: { summary: 'feat: y' },
    });
  });

  it('cancels a running commit', async () => {
    const repoId = await open();
    let opId = -1;
    const off = mockBackend.events.subscribe('opStarted', (e) => (opId = e.opId));
    const pending = mockBackend.commands.commit(repoId, {
      summary: 'feat: slow',
      description: '',
      amend: false,
      skipHooks: false,
    });
    off();
    await mockBackend.commands.cancelOp(opId);
    expect(await pending).toMatchObject({ status: 'error', error: { code: 'cancelled' } });
    expect(await paths(repoId, 'staged')).toHaveLength(2);
  });

  it('asks for an identity when none is configured', async () => {
    const opened = await mockBackend.commands.openRepo('/tmp/no-identity');
    if (opened.status !== 'ok') throw new Error('open failed');
    const repoId = opened.data.id;
    await mockBackend.commands.stagePaths(repoId, { kind: 'all' });
    const request = { summary: 'x', description: '', amend: false, skipHooks: true };
    expect(await mockBackend.commands.commit(repoId, request)).toMatchObject({
      error: { code: 'identityUnknown', action: { kind: 'configureIdentity', repoId } },
    });
    await mockBackend.commands.setGitIdentity(repoId, 'Ada', 'ada@example.com', 'repo');
    expect(await mockBackend.commands.gitIdentity(repoId)).toMatchObject({
      data: { name: 'Ada', email: 'ada@example.com' },
    });
  });
});
