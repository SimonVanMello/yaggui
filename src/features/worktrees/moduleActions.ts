import { queryClient, queryKeys } from '../../app/queryClient';
import type { RepoRefs } from '../../ipc';
import { registerActions } from '../palette/actionRegistry';
import { useLfsTrackDialog, lfsPull } from '../lfs/lfsOps';
import { activeRepoId } from '../repo/repoSessions';
import { updateSubmodules } from '../submodules/submoduleOps';
import { pruneWorktrees } from './worktreeOps';
import { openWorktreeDialog } from './worktreeStore';

const hasRepo = () => activeRepoId() !== null;

function refsOfActive(): RepoRefs | undefined {
  const repoId = activeRepoId();
  return repoId === null ? undefined : queryClient.getQueryData(queryKeys.repoRefs(repoId));
}

function onRepo(work: (repoId: number) => unknown): () => void {
  return () => {
    const repoId = activeRepoId();
    if (repoId !== null) void work(repoId);
  };
}

/**
 * Palette entries of submodules, worktrees and LFS (F-260 to F-262). The ids are public and
 * stable (recents, rebindable shortcuts). Returns the function removing them.
 */
export function registerModuleActions(): () => void {
  return registerActions([
    {
      id: 'submodule.update',
      title: 'palette.action.submodule.update',
      group: 'git',
      enabled: () => (refsOfActive()?.submodules.length ?? 0) > 0,
      run: onRepo((repoId) =>
        updateSubmodules(repoId, { paths: [], init: false, recursive: false }),
      ),
    },
    {
      id: 'submodule.initAll',
      title: 'palette.action.submodule.init',
      group: 'git',
      enabled: () => (refsOfActive()?.submodules.length ?? 0) > 0,
      run: onRepo((repoId) => updateSubmodules(repoId, { paths: [], init: true, recursive: true })),
    },
    {
      id: 'worktree.create',
      title: 'palette.action.worktree.create',
      group: 'git',
      enabled: hasRepo,
      run: onRepo((repoId) => {
        openWorktreeDialog({ kind: 'create', repoId, branch: null });
      }),
    },
    {
      id: 'worktree.prune',
      title: 'palette.action.worktree.prune',
      group: 'git',
      enabled: () => refsOfActive()?.worktrees.some((w) => w.prunable) ?? false,
      run: onRepo(pruneWorktrees),
    },
    {
      id: 'lfs.pull',
      title: 'palette.action.lfs.pull',
      group: 'git',
      enabled: hasRepo,
      run: onRepo(lfsPull),
    },
    {
      id: 'lfs.track',
      title: 'palette.action.lfs.track',
      group: 'git',
      enabled: hasRepo,
      run: onRepo((repoId) => {
        useLfsTrackDialog.getState().open(repoId);
      }),
    },
  ]);
}
