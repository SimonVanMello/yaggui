import { describe, expect, it } from 'vitest';

import type { RepoRefs, WorktreeRef } from '../../ipc';
import { otherWorktreeOf, suggestWorktreePath } from './worktreeOps';

function worktree(path: string, branch: string | null, extra: Partial<WorktreeRef> = {}) {
  return {
    path,
    head: branch ? { kind: 'branch', name: branch, oid: 'a'.repeat(40) } : null,
    isMain: false,
    isCurrent: false,
    locked: false,
    prunable: false,
    ...extra,
  } satisfies WorktreeRef;
}

describe('worktree helpers', () => {
  it('proposes a folder next to the repository, named after the branch', () => {
    expect(suggestWorktreePath('/Users/me/dev/yaggui', 'feat/graph lanes')).toBe(
      '/Users/me/dev/yaggui-feat-graph-lanes',
    );
    expect(suggestWorktreePath('C:\\dev\\yaggui\\', 'fix/x')).toBe('C:\\dev\\yaggui-fix-x');
    expect(suggestWorktreePath('/r', '///')).toBe('/r-worktree');
  });

  it('finds the other worktree holding a branch, ignoring this one and missing ones', () => {
    const refs = {
      worktrees: [
        worktree('/r', 'main', { isMain: true, isCurrent: true }),
        worktree('/r-review', 'review'),
        worktree('/r-gone', 'gone', { prunable: true }),
      ],
    } as Pick<RepoRefs, 'worktrees'> as RepoRefs;
    expect(otherWorktreeOf(refs, 'review')?.path).toBe('/r-review');
    expect(otherWorktreeOf(refs, 'main')).toBeNull();
    expect(otherWorktreeOf(refs, 'gone')).toBeNull();
    expect(otherWorktreeOf(undefined, 'review')).toBeNull();
  });
});
