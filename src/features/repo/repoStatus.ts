import type { RepoOperation, RepoState } from '../../ipc';

export function changedFiles(state: RepoState): number {
  const { staged, unstaged, untracked, conflicted } = state.dirty;
  return staged + unstaged + untracked + conflicted;
}

/**
 * Branch the user is working on: the checked-out branch, or during a rebase (HEAD detached on
 * the commit being replayed) the branch being rebased. `null` for a plain detached HEAD.
 */
export function workingBranch(state: RepoState): string | null {
  if (state.head.kind !== 'detached') return state.head.name;
  return state.operation?.kind === 'rebase' ? state.operation.headName : null;
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

export type OperationKind = RepoOperation['kind'];
