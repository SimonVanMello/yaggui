import { queryClient, queryKeys } from '../../app/queryClient';
import type { MessageKey } from '../../i18n/i18n';
import type { RepoRefs, SubmoduleRef, SubmoduleStatus, WorktreeRef } from '../../ipc';
import type { IconName } from '../../ui/Icon';
import { openRepoPath } from '../repo/repoSessions';
import { openSubmodule, updateSubmodules } from '../submodules/submoduleOps';
import { submoduleKeys, submoduleStatusOf } from '../submodules/submoduleQueries';
import { otherWorktreeOf, pruneWorktrees } from './worktreeOps';
import { openWorktreeDialog } from './worktreeStore';

/** A sidebar menu entry, as `RefContextMenu` lists them (no `run`: disabled, with `why`). */
export interface ModuleMenuItem {
  key: MessageKey;
  icon?: IconName;
  danger?: boolean;
  run?: () => void;
  why?: MessageKey;
}

function cachedRefs(repoId: number): RepoRefs | undefined {
  return queryClient.getQueryData(queryKeys.repoRefs(repoId));
}

/** Open, initialize, update (F-260). */
export function submoduleMenu(repoId: number, submodule: SubmoduleRef): ModuleMenuItem[] {
  const statuses = queryClient.getQueryData<SubmoduleStatus[]>(submoduleKeys.status(repoId));
  const status = submoduleStatusOf(statuses, submodule.path);
  const update = (init: boolean, recursive: boolean) => () => {
    void updateSubmodules(repoId, { paths: [submodule.path], init, recursive });
  };
  return [
    {
      key: 'sidebar.menu.openTab',
      icon: 'folderOpen',
      why: 'sidebar.why.notInitialized',
      run:
        status && submodule.initialized
          ? () => {
              void openSubmodule(status);
            }
          : undefined,
    },
    submodule.initialized
      ? { key: 'sidebar.menu.submoduleUpdate', icon: 'retry', run: update(false, false) }
      : { key: 'sidebar.menu.submoduleInit', icon: 'pull', run: update(true, false) },
    {
      key: 'sidebar.menu.submoduleUpdateRecursive',
      run: update(!submodule.initialized, true),
    },
  ];
}

/** Open, remove, prune, new (F-261). The current worktree has only "New worktree…". */
export function worktreeMenu(repoId: number, worktree: WorktreeRef): ModuleMenuItem[] {
  const create: ModuleMenuItem = {
    key: 'sidebar.menu.worktreeCreate',
    icon: 'plus',
    run: () => {
      openWorktreeDialog({ kind: 'create', repoId, branch: null });
    },
  };
  if (worktree.isCurrent) return [create];
  return [
    {
      key: 'sidebar.menu.openTab',
      icon: 'folderOpen',
      why: 'sidebar.why.worktreeMissing',
      run: worktree.prunable
        ? undefined
        : () => {
            void openRepoPath(worktree.path);
          },
    },
    create,
    ...(worktree.prunable
      ? [
          {
            key: 'sidebar.menu.worktreePrune',
            run: () => {
              void pruneWorktrees(repoId);
            },
          } as const,
        ]
      : []),
    ...(worktree.isMain
      ? []
      : [
          {
            key: 'sidebar.menu.worktreeRemove',
            icon: 'trash',
            danger: true,
            run: () => {
              openWorktreeDialog({ kind: 'remove', repoId, path: worktree.path });
            },
          } as const,
        ]),
  ];
}

/** Why a local branch cannot be checked out here: it is in another worktree (Git refuses). */
export function branchElsewhere(repoId: number, branch: string): WorktreeRef | null {
  return otherWorktreeOf(cachedRefs(repoId), branch);
}

/** "Check out in a new worktree…" of a local branch not checked out anywhere. */
export function branchWorktreeItem(
  repoId: number,
  branch: string,
  checkedOut: boolean,
): ModuleMenuItem {
  return {
    key: 'sidebar.menu.branchWorktree',
    icon: 'folder',
    why: 'sidebar.why.inOtherWorktree',
    run: checkedOut
      ? undefined
      : () => {
          openWorktreeDialog({ kind: 'create', repoId, branch });
        },
  };
}
