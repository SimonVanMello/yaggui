import type { ConflictLabels, RepoOperation, SideLabel } from '../../ipc';
import type { Side } from './mergeModel';

/** What a side is in the operation in progress (F-163): shown next to its branch name. */
export type SideRole = 'current' | 'merged' | 'onto' | 'replayed' | 'picked' | 'reverted' | 'other';

export function sideRole(operation: RepoOperation | null, side: Side): SideRole {
  switch (operation?.kind) {
    case 'rebase':
      // Ours is the branch being rebased onto, theirs the commit being replayed.
      return side === 'ours' ? 'onto' : 'replayed';
    case 'merge':
      return side === 'ours' ? 'current' : 'merged';
    case 'cherryPick':
      return side === 'ours' ? 'current' : 'picked';
    case 'revert':
      return side === 'ours' ? 'current' : 'reverted';
    default:
      return side === 'ours' ? 'current' : 'other';
  }
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** Name of a side: its branch, else its commit, else `null` (the caller's fallback). */
export function sideName(label: SideLabel): string | null {
  if (label.branch) return label.branch;
  if (label.commit) return shortSha(label.commit.sha);
  return null;
}

/** The commit line under a side's name: `abc1234 · summary`, `null` without a commit. */
export function sideCommit(label: SideLabel): string | null {
  if (!label.commit) return null;
  return `${shortSha(label.commit.sha)} · ${label.commit.summary}`;
}

/** Names of both sides, with fallbacks when Git gives neither branch nor commit. */
export function sideNames(
  labels: ConflictLabels,
  fallback: Record<Side, string>,
): Record<Side, string> {
  return {
    ours: sideName(labels.ours) ?? fallback.ours,
    theirs: sideName(labels.theirs) ?? fallback.theirs,
  };
}
