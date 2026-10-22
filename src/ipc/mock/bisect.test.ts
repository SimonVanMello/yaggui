import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend, mockClient } from '../mockClient';
import type { MockCommit } from '../mockGraph';
import { unwrap } from '../result';
import { bisectOutcome, estimateSteps, type MockBisect } from './bisect';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

/** `count` commits in a line, `0` the root. */
function line(count: number): MockCommit[] {
  return Array.from({ length: count }, (_, i) => ({
    sha: String(i).padStart(40, '0'),
    parents: i === 0 ? [] : [i - 1],
    summary: `c${String(i)}`,
    body: '',
    authorName: 'A',
    authorEmail: 'a@example.com',
    authorTime: i,
    commitTime: i,
    files: [],
    signature: null,
  }));
}

function bisect(marks: Partial<MockBisect>): MockBisect {
  return {
    bad: null,
    good: [],
    skipped: [],
    original: { kind: 'branch', name: 'main' },
    ...marks,
  };
}

describe('mock bisect', () => {
  it('estimates the steps like Git', () => {
    expect([0, 2, 3, 4, 5, 6, 9, 11, 100].map(estimateSteps)).toEqual([0, 0, 1, 1, 1, 2, 2, 3, 6]);
  });

  it('bisects a line down to the first bad commit, or the skipped candidates', () => {
    const commits = line(10);
    expect(bisectOutcome(commits, bisect({ bad: 9 })).next).toBeNull();
    const start = bisectOutcome(commits, bisect({ bad: 9, good: [0] }));
    expect(start).toMatchObject({ remaining: 8, steps: 2, result: null });
    // The middle of c1..c9.
    expect([4, 5]).toContain(start.next);
    expect(bisectOutcome(commits, bisect({ bad: 4, good: [3] }))).toMatchObject({
      remaining: 0,
      result: { kind: 'found', commit: 4 },
      next: null,
    });
    expect(bisectOutcome(commits, bisect({ bad: 5, good: [2], skipped: [3, 4] }))).toMatchObject({
      result: { kind: 'inconclusive', candidates: [5, 4, 3] },
    });
  });

  it('starts from a mark, steps to the result and resets to the branch', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/blog'));
    const before = await unwrap(mock.repoState(id));
    if (before.head.kind !== 'branch') throw new Error('blog is on a branch');
    const tip = before.head.oid;

    await expect(mock.bisectMark(id, null, 'skip')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    expect(await unwrap(mock.bisectState(id))).toBeNull();

    let state = await unwrap(mock.bisectMark(id, null, 'bad'));
    expect(state).toMatchObject({ bad: tip, good: [], remaining: null, original: 'main' });
    expect((await unwrap(mock.repoState(id))).operation).toEqual({ kind: 'bisect' });

    const page = await unwrap(mock.graphPage(id, 0, 40));
    const old = page.shas[page.shas.length - 1] ?? '';
    state = await unwrap(mock.bisectMark(id, old, 'good'));
    expect(state.remaining).toBeGreaterThan(0);
    expect(state.current?.sha).not.toBe(tip);
    expect((await unwrap(mock.repoState(id))).head.kind).toBe('detached');

    // Every commit tested is good: the bad tip is the first bad commit.
    for (let i = 0; i < 12 && state.result === null; i++) {
      state = await unwrap(mock.bisectMark(id, null, 'good'));
    }
    expect(state.result).toMatchObject({ kind: 'found', commit: { sha: tip } });

    await unwrap(mock.abortOperation(id));
    const after = await unwrap(mock.repoState(id));
    expect(after.operation).toBeNull();
    expect(after.head).toMatchObject({ kind: 'branch', name: 'main', oid: tip });
    expect(await unwrap(mock.bisectState(id))).toBeNull();
  });

  it('refuses local changes to tracked files', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const state = await unwrap(mock.repoState(id));
    expect(state.dirty.staged + state.dirty.unstaged).toBeGreaterThan(0);
    await expect(mock.bisectMark(id, null, 'bad')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'dirtyWorktree', payload: { kind: 'dirtyWorktree', canCarry: false } },
    });
    expect((await unwrap(mock.repoState(id))).operation).toBeNull();
  });
});
