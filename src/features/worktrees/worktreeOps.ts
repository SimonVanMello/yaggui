import {
  ipc,
  unwrap,
  type CreateWorktreeRequest,
  type RepoRefs,
  type WorktreeRef,
} from '../../ipc';
import { openRepoPath } from '../repo/repoSessions';
import { runModuleOp, type ModuleResult } from '../submodules/moduleOps';

/** `git worktree add` (F-261); opens the new worktree in a tab when asked. */
export async function createWorktree(
  repoId: number,
  request: CreateWorktreeRequest,
  open: boolean,
): Promise<ModuleResult<string>> {
  const result = await runModuleOp(
    repoId,
    () => unwrap(ipc.commands.createWorktree(repoId, request)),
    { success: 'worktree.created', report: false },
  );
  if (result.ok && open) await openRepoPath(result.data);
  return result;
}

/** `git worktree remove`; `worktreeDirty` comes back for the dialog to offer `force`. */
export function removeWorktree(
  repoId: number,
  path: string,
  force: boolean,
): Promise<ModuleResult<null>> {
  return runModuleOp(repoId, () => unwrap(ipc.commands.removeWorktree(repoId, path, force)), {
    success: 'worktree.removed',
    report: false,
  });
}

export async function pruneWorktrees(repoId: number): Promise<void> {
  await runModuleOp(repoId, () => unwrap(ipc.commands.pruneWorktrees(repoId)), {
    success: 'worktree.pruned',
  });
}

/** Branch checked out by a worktree, `null` when detached or unknown. */
export function worktreeBranch(worktree: WorktreeRef): string | null {
  const { head } = worktree;
  return head && head.kind !== 'detached' ? head.name : null;
}

/** The other worktree where `branch` is checked out (Git refuses a second checkout). */
export function otherWorktreeOf(refs: RepoRefs | undefined, branch: string): WorktreeRef | null {
  return (
    refs?.worktrees.find((w) => !w.isCurrent && !w.prunable && worktreeBranch(w) === branch) ?? null
  );
}

/** Folder proposed for a new worktree: next to the repository, `<repo>-<branch>`. */
export function suggestWorktreePath(repoPath: string, branch: string): string {
  const trimmed = repoPath.replace(/[\\/]+$/, '');
  const slug = branch
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${trimmed}-${slug}` : `${trimmed}-worktree`;
}
