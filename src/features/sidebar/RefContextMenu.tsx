import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n/i18n';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import type { IconName } from '../../ui/Icon';
import {
  branchStartOf,
  checkoutRef,
  openCreateBranch,
  openCreateTagAt,
  stashId,
} from '../refs/refCommands';
import { openReflog } from '../inspect/inspectStore';
import { planAgainstCurrent } from '../history/dropActions';
import { runDropAction } from '../history/dnd/DropMenu';
import { operationOf } from '../history/historyOps';
import {
  deleteRemoteBranch,
  deleteRemoteTag,
  pullRepo,
  pushRepo,
  pushTag,
} from '../network/networkOps';
import { openRefDialog } from '../refs/refDialogsStore';
import { deleteTag, stashApply, stashDrop, stashPop, unsetUpstream } from '../refs/refOps';
import { shortOid } from '../repo/repoStatus';
import {
  branchElsewhere,
  branchWorktreeItem,
  submoduleMenu,
  worktreeMenu,
} from '../worktrees/moduleMenus';
import { openBranchTools } from '../compare/branchToolsStore';
import { openCompare } from '../compare/compareStore';
import {
  hiddenByFolder,
  isHidden,
  toggleHidden,
  toggleSolo,
  updateGraphFilter,
  useGraphFilter,
} from '../graph/graphFilter';
import type { GraphFilter } from '../../ipc';
import { copyText } from './refActions';
import { useRepoRefs } from './useRepoRefs';
import { targetName, targetSha, type RefTarget } from './sidebarRows';

interface Planned {
  key: MessageKey;
  icon?: IconName;
  danger?: boolean;
  /** Absent: the action arrives with a later milestone (network, merge, rebase…). */
  run?: () => void;
  /** Why a planned action is unavailable now, instead of "Soon". */
  why?: MessageKey;
  /** One entry per remote, shown as a submenu (`run` is then ignored). */
  perRemote?: { remotes: string[]; key: MessageKey; run: (remote: string) => void };
}

const SEPARATOR = null;

/** The positions a reference had (F-222). */
function reflog(repoId: number, reference: string): Planned {
  return {
    key: 'sidebar.menu.reflog',
    icon: 'history',
    run: () => {
      openReflog(repoId, reference);
    },
  };
}

/** Actions of the spec for each kind of ref; those without `run` come later. */
/** Merge, rebase and fast-forward against the checked-out branch: the keyboard twin of the drag. */
function integrationActions(
  repoId: number,
  name: string,
  remote: boolean,
  current: string | null,
): Planned[] {
  if (current === null || name === current) return [];
  const plan = planAgainstCurrent({ kind: 'branch', name, remote }, current);
  const busy = operationOf(repoId) !== null;
  const run = (action: typeof plan.merge) =>
    action && !busy
      ? () => {
          runDropAction(repoId, action);
        }
      : undefined;
  return [
    {
      key: 'sidebar.menu.merge',
      icon: 'merge',
      run: run(plan.merge),
      why: busy ? 'history.menu.busy' : undefined,
    },
    {
      key: 'sidebar.menu.rebase',
      run: remote ? undefined : run(plan.rebase),
      why: busy ? 'history.menu.busy' : 'dnd.remoteRebase',
    },
    {
      key: 'sidebar.menu.fastForward',
      run: run(plan.fastForward),
      why: busy ? 'history.menu.busy' : undefined,
    },
  ];
}

/** `run` on the only remote, or a submenu to choose when there are several. */
function onRemote(
  remotes: string[],
  key: MessageKey,
  run: (remote: string | null) => void,
): Pick<Planned, 'run' | 'perRemote'> {
  if (remotes.length > 1) return { run: () => undefined, perRemote: { remotes, key, run } };
  return {
    run: () => {
      run(remotes[0] ?? null);
    },
  };
}

/** Hide / show and solo of a branch in the graph (F-028), and its comparison (F-104). */
function graphActions(
  repoId: number,
  fullName: string,
  name: string,
  isHead: boolean,
  current: string | null,
  filter: GraphFilter,
): Planned[] {
  // The checked-out branch stays in the graph even inside a hidden folder.
  const hidden = !isHead && isHidden(filter, fullName);
  const byFolder = hidden && hiddenByFolder(filter, fullName) !== null;
  return [
    {
      key: hidden ? 'sidebar.menu.show' : 'sidebar.menu.hide',
      icon: hidden ? 'eye' : 'eyeOff',
      why: byFolder ? 'sidebar.why.hiddenFolder' : 'sidebar.why.hideCurrent',
      // HEAD's commits always stay in the graph: hiding the checked-out branch would only drop
      // its label.
      run:
        isHead || byFolder
          ? undefined
          : () => {
              void updateGraphFilter(repoId, (f) => toggleHidden(f, fullName));
            },
    },
    {
      key: filter.solo === fullName ? 'sidebar.menu.unsolo' : 'sidebar.menu.solo',
      icon: 'solo',
      run: () => {
        void updateGraphFilter(repoId, (f) => toggleSolo(f, fullName));
      },
    },
    {
      key: 'sidebar.menu.compare',
      icon: 'compare',
      why: 'sidebar.why.compareCurrent',
      run:
        current === null || current === name
          ? undefined
          : () => {
              openCompare(repoId, {
                a: { rev: fullName, label: name },
                b: { rev: current, label: current },
              });
            },
    },
    {
      key: 'sidebar.menu.compareWith',
      icon: 'compare',
      run: () => {
        openBranchTools({ kind: 'compareBranches', repoId, a: name });
      },
    },
    {
      key: 'sidebar.menu.cleanup',
      icon: 'trash',
      run: () => {
        openBranchTools({ kind: 'cleanup', repoId });
      },
    },
  ];
}

function plannedActions(
  repoId: number,
  target: RefTarget,
  current: string | null,
  remotes: string[],
  filter: GraphFilter,
): (Planned | typeof SEPARATOR)[] {
  const start = branchStartOf(target);
  const createBranch: Planned = {
    key: 'sidebar.menu.createBranch',
    icon: 'plus',
    run: start
      ? () => {
          openCreateBranch(repoId, start.from, start.label);
        }
      : undefined,
  };
  const createTag: Planned = {
    key: 'sidebar.menu.createTag',
    icon: 'tag',
    run: () => {
      openCreateTagAt(repoId, target);
    },
  };
  switch (target.kind) {
    case 'local': {
      const { branch } = target;
      const upstream = branch.upstream && !branch.upstream.gone ? branch.upstream.name : null;
      // Git refuses to check out a branch twice (F-261).
      const elsewhere = branch.isHead ? null : branchElsewhere(repoId, branch.name);
      return [
        ...(branch.isHead
          ? []
          : [
              {
                key: 'sidebar.menu.checkout',
                icon: 'branch',
                why: 'sidebar.why.inOtherWorktree',
                run: elsewhere
                  ? undefined
                  : () => {
                      checkoutRef(repoId, target);
                    },
              } as const,
            ]),
        branchWorktreeItem(repoId, branch.name, branch.isHead || elsewhere !== null),
        createBranch,
        createTag,
        reflog(repoId, `refs/heads/${branch.name}`),
        ...(branch.isHead ? [] : integrationActions(repoId, branch.name, false, current)),
        ...(branch.upstream
          ? [
              {
                key: 'sidebar.menu.pull',
                icon: 'pull',
                // Git pulls into the checked-out branch only.
                why: 'sidebar.menu.pullCurrent',
                run: branch.isHead
                  ? () => {
                      void pullRepo(repoId, null);
                    }
                  : undefined,
              } as const,
            ]
          : []),
        {
          key: 'sidebar.menu.push',
          icon: 'push',
          run: () => {
            void pushRepo(repoId, { branch: branch.name });
          },
        },
        SEPARATOR,
        {
          key: 'sidebar.menu.rename',
          run: () => {
            openRefDialog({ kind: 'renameBranch', repoId, name: branch.name });
          },
        },
        {
          key: branch.upstream ? 'sidebar.menu.changeUpstream' : 'sidebar.menu.setUpstream',
          run: () => {
            openRefDialog({
              kind: 'upstream',
              repoId,
              branch: branch.name,
              current: branch.upstream?.name ?? null,
            });
          },
        },
        ...(branch.upstream
          ? [
              {
                key: 'sidebar.menu.unsetUpstream',
                run: () => {
                  void unsetUpstream(repoId, branch.name);
                },
              } as const,
            ]
          : []),
        {
          key: 'sidebar.menu.delete',
          icon: 'trash',
          danger: true,
          // The checked-out branch cannot be deleted: check out another one first.
          why: 'sidebar.menu.deleteCurrent',
          run: branch.isHead
            ? undefined
            : () => {
                openRefDialog({ kind: 'deleteBranch', repoId, name: branch.name, upstream });
              },
        },
        SEPARATOR,
        ...graphActions(
          repoId,
          `refs/heads/${branch.name}`,
          branch.name,
          branch.isHead,
          current,
          filter,
        ),
      ];
    }
    case 'remote':
      return [
        {
          key: 'sidebar.menu.checkoutRemote',
          icon: 'branch',
          run: () => {
            checkoutRef(repoId, target);
          },
        },
        createBranch,
        reflog(repoId, target.branch.fullName),
        ...integrationActions(repoId, target.branch.name, true, current),
        SEPARATOR,
        {
          key: 'sidebar.menu.deleteRemote',
          icon: 'trash',
          danger: true,
          run: () => {
            void deleteRemoteBranch(repoId, targetName(target));
          },
        },
        SEPARATOR,
        ...graphActions(repoId, target.branch.fullName, target.branch.name, false, current, filter),
      ];
    case 'tag':
      return [
        {
          key: 'sidebar.menu.checkoutDetached',
          icon: 'commit',
          run: () => {
            checkoutRef(repoId, target);
          },
        },
        createBranch,
        {
          key: 'sidebar.menu.pushTag',
          icon: 'push',
          ...onRemote(remotes, 'sidebar.menu.pushTagTo', (remote) => {
            void pushTag(repoId, target.tag.name, remote);
          }),
        },
        {
          key: 'sidebar.menu.deleteTag',
          icon: 'trash',
          danger: true,
          run: () => {
            void deleteTag(repoId, target.tag.name);
          },
        },
        {
          key: 'sidebar.menu.deleteRemoteTag',
          icon: 'trash',
          danger: true,
          ...onRemote(remotes, 'sidebar.menu.deleteRemoteTagOn', (remote) => {
            void deleteRemoteTag(repoId, target.tag.name, remote);
          }),
        },
      ];
    case 'stash': {
      const { stash } = target;
      const id = stashId(stash);
      return [
        {
          key: 'sidebar.menu.stashApply',
          icon: 'pop',
          run: () => {
            void stashApply(repoId, id);
          },
        },
        {
          key: 'sidebar.menu.stashPop',
          icon: 'pop',
          run: () => {
            void stashPop(repoId, id);
          },
        },
        createBranch,
        {
          key: 'sidebar.menu.stashRename',
          run: () => {
            openRefDialog({ kind: 'stashRename', repoId, stash: id, message: stash.message });
          },
        },
        {
          key: 'sidebar.menu.stashDrop',
          icon: 'trash',
          danger: true,
          run: () => {
            void stashDrop(repoId, id, stash.message);
          },
        },
      ];
    }
    case 'head':
      return target.head.kind === 'detached'
        ? [createBranch, createTag, reflog(repoId, 'HEAD')]
        : [reflog(repoId, 'HEAD')];
    case 'submodule':
      return submoduleMenu(repoId, target.submodule);
    case 'worktree':
      return worktreeMenu(repoId, target.worktree);
  }
}

/** Context menu of a ref row: the actions that exist, the planned ones disabled, then copy. */
export function RefContextMenu({
  repoId,
  target,
  current,
}: {
  repoId: number;
  target: RefTarget;
  current: string | null;
}) {
  const t = useT();
  const name = targetName(target);
  const sha = targetSha(target);
  const isPath = target.kind === 'submodule' || target.kind === 'worktree';
  const remotes = (useRepoRefs(repoId).data?.remotes ?? []).map((r) => r.name);
  const filter = useGraphFilter(repoId);
  const planned = plannedActions(repoId, target, current, remotes, filter);
  const params = { name, current: current ?? 'HEAD' };

  return (
    <>
      {planned.map((action, index) =>
        action === SEPARATOR ? (
          <ContextMenuSeparator key={`sep-${String(index)}`} />
        ) : action.perRemote ? (
          <ContextMenuSub key={action.key} icon={action.icon} label={t(action.perRemote.key)}>
            {action.perRemote.remotes.map((remote) => (
              <ContextMenuItem
                key={remote}
                danger={action.danger}
                onSelect={() => {
                  action.perRemote?.run(remote);
                }}
              >
                {remote}
              </ContextMenuItem>
            ))}
          </ContextMenuSub>
        ) : (
          <ContextMenuItem
            key={action.key}
            icon={action.icon}
            danger={action.danger}
            disabled={!action.run}
            onSelect={action.run}
            hint={!action.run ? t(action.why ?? 'common.soon') : undefined}
          >
            {t(action.key, params)}
          </ContextMenuItem>
        ),
      )}
      {planned.length > 0 && <ContextMenuSeparator />}
      <ContextMenuItem
        icon="copy"
        onSelect={() => {
          copyText(name, isPath ? t('sidebar.what.path') : t('sidebar.what.name'));
        }}
      >
        {isPath ? t('sidebar.menu.copyPath') : t('sidebar.menu.copyName')}
      </ContextMenuItem>
      {sha && target.kind !== 'head' && (
        <ContextMenuItem
          icon="copy"
          hint={<code>{shortOid(sha)}</code>}
          onSelect={() => {
            copyText(sha, 'SHA');
          }}
        >
          {t('sidebar.menu.copySha')}
        </ContextMenuItem>
      )}
    </>
  );
}
