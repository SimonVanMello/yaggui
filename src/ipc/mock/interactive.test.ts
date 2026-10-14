import { beforeEach, describe, expect, it } from 'vitest';

import type { RebaseAction, RebaseTodoEntry } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';

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
