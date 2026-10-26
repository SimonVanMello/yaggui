/**
 * What dropping something on a local branch can do (F-026, F-143). Pure: the drag layer asks
 * for the actions, shows them in a menu, and the history operations run the chosen one.
 */
import type { RevisionRelation } from '../../ipc';

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
  /**
   * Branch (or `shas` for a cherry-pick) that is merged, rebased or picked. For a fast-forward:
   * where the moved branch goes.
   */
  source: string;
  /**
   * Local branch the pointer was released on. For a fast-forward: the branch that moves, which
   * is the dragged one when it is behind the branch it was dropped on.
   */
  target: string;
  shas: string[];
  /**
   * The target is not checked out: the front checks it out first (M3-1 contract). Never set
   * for a rebase, which checks out the rebased branch itself (`git rebase <onto> <branch>`).
   */
  needsCheckout: boolean;
  /** Why the action is listed but cannot run. */
  disabled: 'remoteSource' | 'upToDate' | 'diverged' | null;
}

/**
 * Actions for `payload` dropped on the local branch `target`; `current` is the checked-out one.
 * `relation` is how the dragged branch relates to `target` (`null` while unknown).
 */
export function planDrop(
  payload: DragPayload,
  target: string,
  current: string | null,
  relation: RevisionRelation | null = null,
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
    planFastForward(payload, target, relation),
  ];
}

/**
 * A fast-forward only goes one way: whichever branch is behind moves to the other, whatever was
 * dragged onto what. The backend moves a branch that is not checked out without a checkout.
 */
function planFastForward(
  payload: BranchDrag,
  target: string,
  relation: RevisionRelation | null,
): DropAction {
  const action: DropAction = {
    id: 'fastForward',
    source: payload.name,
    target,
    shas: [],
    needsCheckout: false,
    disabled: null,
  };
  switch (relation) {
    case 'behind':
      // The dragged branch moves; a remote one cannot, and `target` already contains it.
      return payload.remote
        ? { ...action, disabled: 'upToDate' }
        : { ...action, source: target, target: payload.name };
    case 'same':
      return { ...action, disabled: 'upToDate' };
    case 'diverged':
      return { ...action, disabled: 'diverged' };
    case 'ahead':
    case null:
      // While unknown, the backend still refuses what cannot be fast-forwarded.
      return action;
  }
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
