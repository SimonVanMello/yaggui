/**
 * What dropping something on a local branch can do (F-026, F-143). Pure: the drag layer asks
 * for the actions, shows them in a menu, and the history operations run the chosen one.
 */

export interface BranchDrag {
  kind: 'branch';
  /** Short name: `feat/x`, or `origin/feat/x` for a remote branch. */
  name: string;
  remote: boolean;
}

export interface CommitsDrag {
  kind: 'commits';
  /** Dragged commits (the graph selection), any order. */
  shas: string[];
}

export type DragPayload = BranchDrag | CommitsDrag;

export type DropActionId = 'merge' | 'rebase' | 'fastForward' | 'cherryPick';

export interface DropAction {
  id: DropActionId;
  /** Branch (or `shas` for a cherry-pick) that is merged, rebased or picked. */
  source: string;
  /** Local branch the pointer was released on. */
  target: string;
  shas: string[];
  /**
   * The target is not checked out: the front checks it out first (M3-1 contract). Never set
   * for a rebase, which checks out the rebased branch itself (`git rebase <onto> <branch>`).
   */
  needsCheckout: boolean;
  /** Why the action is listed but cannot run. */
  disabled: 'remoteSource' | null;
}

/** Actions for `payload` dropped on the local branch `target`; `current` is the checked-out one. */
export function planDrop(
  payload: DragPayload,
  target: string,
  current: string | null,
): DropAction[] {
  const needsCheckout = target !== current;
  if (payload.kind === 'commits') {
    if (payload.shas.length === 0) return [];
    return [
      {
        id: 'cherryPick',
        source: '',
        target,
        shas: payload.shas,
        needsCheckout,
        disabled: null,
      },
    ];
  }
  if (payload.name === target) return [];
  const base = { source: payload.name, target, shas: [], needsCheckout };
  return [
    { ...base, id: 'merge', disabled: null },
    // `git rebase <onto> <branch>` rewrites a local branch: a remote one has nothing to rewrite.
    {
      ...base,
      id: 'rebase',
      needsCheckout: false,
      disabled: payload.remote ? 'remoteSource' : null,
    },
    { ...base, id: 'fastForward', disabled: null },
  ];
}

/** `X` dragged on `Y` is also what the sidebar menu of `X` offers against the current branch. */
export function planAgainstCurrent(
  branch: BranchDrag,
  current: string | null,
): { merge: DropAction | null; rebase: DropAction | null; fastForward: DropAction | null } {
  if (current === null || current === branch.name) {
    return { merge: null, rebase: null, fastForward: null };
  }
  const actions = planDrop(branch, current, current);
  return {
    merge: actions.find((a) => a.id === 'merge') ?? null,
    rebase: actions.find((a) => a.id === 'rebase') ?? null,
    fastForward: actions.find((a) => a.id === 'fastForward') ?? null,
  };
}
