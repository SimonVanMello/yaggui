import { beforeEach, describe, expect, it } from 'vitest';

import type { RebaseAction, RebaseTodoEntry } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { mockAutosquash } from './interactive';

const { commands: mock } = mockClient;

beforeEach(() => {
  mockBackend.reset();
});

/** Opens a clean repository and reads the plan of its last four commits. */
async function plan(path = '/Users/alex/dev/blog') {
  const { id } = await unwrap(mock.openRepo(path));
  const base = 'HEAD~4';
  const result = await unwrap(mock.interactiveRebasePlan(id, base));
  return { id, base, plan: result };
}

function todo(
  shas: string[],
  actions: RebaseAction[],
  messages: (string | null)[] = [],
): RebaseTodoEntry[] {
  return shas.map((sha, i) => ({
    sha,
    action: actions[i] ?? 'pick',
    message: messages[i] ?? null,
  }));
}

/** Subjects of the last `count` commits of HEAD, oldest first (first parents). */
async function subjects(id: number, count: number): Promise<string[]> {
  const state = await unwrap(mock.repoState(id));
  let sha: string | undefined = state.head.kind === 'unborn' ? undefined : state.head.oid;
  const out: string[] = [];
  while (sha && out.length < count) {
    const detail = await unwrap(mock.commitDetail(id, sha));
    out.unshift(detail.summary);
    sha = detail.parents[0];
  }
  return out;
}

describe('mock interactive rebase', () => {
  it('plans base..HEAD oldest first with pushed flags', async () => {
    const { plan: p } = await plan();
    expect(p.branch).toBe('main');
    expect(p.commits).toHaveLength(4);
    expect(p.hasMerges).toBe(false);
    expect(p.upstream).toBe('origin/main');
    expect(p.pushed).toBe(p.commits.filter((c) => c.pushed).length);
    expect(p.commits.at(-1)?.sha).toBe(p.head);
  });

  it('rewrites: reorder, reword, squash, fixup and drop', async () => {
    const { id, base, plan: p } = await plan();
    const [c1, c2, c3, c4] = p.commits.map((c) => c.sha) as [string, string, string, string];
    const result = await unwrap(
      mock.interactiveRebase(
        id,
        base,
        todo(
          [c2, c1, c4, c3],
          ['reword', 'squash', 'pick', 'drop'],
          ['Reworded\n\n# kept', 'Combined message'],
        ),
      ),
    );
    expect(result.stopped).toBeNull();
    expect(result.effect).toBe('commits');
    const state = await unwrap(mock.repoState(id));
    expect(state.operation).toBeNull();
    expect(state.head).toMatchObject({ kind: 'branch', name: 'main', oid: result.head });
    const last = await subjects(id, 2);
    expect(last).toEqual(['Combined message', p.commits[3]?.summary]);
  });

  it('refuses invalid todos like the backend', async () => {
    const { id, base, plan: p } = await plan();
    const shas = p.commits.map((c) => c.sha);
    const code = async (entries: RebaseTodoEntry[]) => {
      const result = await mock.interactiveRebase(id, base, entries);
      return result.status === 'error' ? result.error.code : 'ok';
    };
    expect(await code(todo(shas, ['fixup']))).toBe('invalidArgument');
    expect(await code(todo(shas, ['pick', 'squash']))).toBe('invalidArgument');
    expect(await code(todo(shas.slice(1), []))).toBe('invalidArgument');
    expect(await code(todo(shas, ['drop', 'drop', 'drop', 'drop']))).toBe('invalidArgument');
  });

  it('stops on edit, then continues', async () => {
    const { id, base, plan: p } = await plan();
    const shas = p.commits.map((c) => c.sha);
    const result = await unwrap(
      mock.interactiveRebase(id, base, todo(shas, ['pick', 'edit', 'pick', 'pick'])),
    );
    expect(result.stopped).toMatchObject({ step: 2, total: 4 });
    const state = await unwrap(mock.repoState(id));
    expect(state.operation).toMatchObject({ kind: 'rebase', step: 2, total: 4, headName: 'main' });
    const detail = await unwrap(mock.operationDetail(id));
    expect(detail?.canContinue).toBe(true);
    await unwrap(mock.continueOperation(id, null));
    const after = await unwrap(mock.repoState(id));
    expect(after.operation).toBeNull();
    expect(after.head).toMatchObject({ kind: 'branch', name: 'main' });
  });

  it('stops on conflicts when simulated, then aborts', async () => {
    const { id, base, plan: p } = await plan();
    const before = await unwrap(mock.repoState(id));
    mockBackend.simulateRebaseConflict(id);
    const shas = p.commits.map((c) => c.sha);
    const result = await mock.interactiveRebase(id, base, todo(shas, []));
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'conflicts', payload: { operation: { kind: 'rebase', step: 2, total: 4 } } },
    });
    await unwrap(mock.abortOperation(id));
    const after = await unwrap(mock.repoState(id));
    expect(after.operation).toBeNull();
    expect(after.head).toEqual(before.head);
  });

  it('refuses a dirty working tree', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    const p = await unwrap(mock.interactiveRebasePlan(id, 'HEAD~2'));
    const result = await mock.interactiveRebase(
      id,
      'HEAD~2',
      todo(
        p.commits.map((c) => c.sha),
        [],
      ),
    );
    expect(result).toMatchObject({ status: 'error', error: { code: 'dirtyWorktree' } });
  });
});

describe('mock reword', () => {
  it('amends HEAD with the new message', async () => {
    const { id, plan: p } = await plan();
    const head = p.head;
    const result = await unwrap(mock.rewordCommit(id, head, 'New summary\n\nBody'));
    const detail = await unwrap(mock.commitDetail(id, result.sha));
    expect(result.sha).not.toBe(head);
    expect(detail.summary).toBe('New summary');
    expect(detail.message).toBe('New summary\n\nBody');
    const state = await unwrap(mock.repoState(id));
    expect(state.head.kind === 'branch' && state.head.oid).toBe(result.sha);
  });

  it('rewords an older commit and replays the ones after it', async () => {
    const { id, plan: p } = await plan();
    const before = p.commits.map((c) => c.summary);
    const second = p.commits[1]?.sha ?? '';
    const result = await unwrap(mock.rewordCommit(id, second, 'Reworded'));
    expect(await subjects(id, 4)).toEqual([before[0], 'Reworded', before[2], before[3]]);
    expect((await unwrap(mock.commitDetail(id, result.sha))).summary).toBe('Reworded');
  });

  it('refuses an empty summary', async () => {
    const { id, plan: p } = await plan();
    const result = await mock.rewordCommit(id, p.head, '  \n\nbody');
    expect(result.status === 'error' && result.error.code).toBe('invalidArgument');
  });
});

describe('mock fixup and autosquash', () => {
  it('arranges like rebase_todo::autosquash', () => {
    const list = (summaries: string[]) =>
      summaries.map((summary, i) => ({ sha: `${String(i)}abc0000`, summary }));
    expect(
      mockAutosquash(
        list(['A', 'B', 'fixup! A', 'C', 'fixup! fixup! A', 'fixup! B', 'fixup! Gone']),
      ),
    ).toEqual({
      order: [
        { index: 0, action: 'pick' },
        { index: 2, action: 'fixup' },
        { index: 4, action: 'fixup' },
        { index: 1, action: 'pick' },
        { index: 5, action: 'fixup' },
        { index: 3, action: 'pick' },
        { index: 6, action: 'pick' },
      ],
      unmatched: [6],
    });
    // A name (SHA prefix, ref), then a summary prefix; an empty subject is no prefix at all.
    const bySha = (name: string) => (name === '0abc' ? '0abc0000' : null);
    expect(mockAutosquash(list(['A', 'fixup! 0abc']), bySha).order[1]?.action).toBe('fixup');
    expect(mockAutosquash(list(['Add x and y', 'fixup! Add x'])).order[1]?.action).toBe('fixup');
    expect(mockAutosquash(list(['A', 'fixup! '])).unmatched).toEqual([]);
  });

  it('arranges squash! and amend! commits like rebase_todo::autosquash', () => {
    const list = (summaries: string[]) =>
      summaries.map((summary, i) => ({ sha: `${String(i)}abc0000`, summary }));
    const order = mockAutosquash(
      list([
        'A',
        'B',
        'squash! A',
        'amend! B',
        'fixup! squash! A',
        'squash! fixup! B',
        'amend! A',
        'squash! A',
      ]),
    ).order.map(({ index, action }) => `${String(index)}:${action}`);
    expect(order).toEqual([
      '0:pick',
      '2:squash',
      '4:fixup',
      '6:amend',
      '7:squash',
      '1:pick',
      '3:amend',
      '5:squash',
    ]);
    // A fixup of a moved commit goes right after it (Git's chained list).
    const chained = mockAutosquash(list(['A', 'fixup! A', 'fixup! A', 'fixup! 1abc']), (name) =>
      name === '1abc' ? '1abc0000' : null,
    ).order.map(({ index }) => index);
    expect(chained).toEqual([0, 1, 3, 2]);
  });

  it('commits a fixup of the staged changes, then plans it under its target', async () => {
    const { id } = await unwrap(mock.openRepo('/Users/alex/dev/yaggui'));
    expect(await unwrap(mock.autosquashPlan(id, null))).toBeNull();
    await unwrap(mock.stagePaths(id, { kind: 'all' }));
    const target = (await unwrap(mock.interactiveRebasePlan(id, 'HEAD~3'))).commits[0];
    const fixup = await unwrap(mock.commitFixup(id, target?.sha ?? ''));
    const detail = await unwrap(mock.commitDetail(id, fixup.sha));
    expect(detail.summary).toBe(`fixup! ${target?.summary ?? ''}`);
    const undo = await unwrap(mock.undoState(id));
    expect(undo.undo?.entry.op).toMatchObject({ kind: 'commit', summary: detail.summary });

    const arranged = await unwrap(mock.autosquashPlan(id, null));
    expect(arranged?.plan.commits).toHaveLength(4);
    expect(arranged?.fixups).toBe(1);
    expect(arranged?.todo.map((e) => e.action)).toEqual(['pick', 'fixup', 'pick', 'pick']);
    expect(arranged?.todo[1]?.sha).toBe(fixup.sha);
  });

  it('refuses a fixup with nothing staged', async () => {
    const { id, plan: p } = await plan();
    const result = await mock.commitFixup(id, p.head);
    expect(result.status === 'error' && result.error.code).toBe('nothingToCommit');
  });
});
