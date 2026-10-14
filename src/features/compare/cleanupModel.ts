import type { CleanupBranch } from '../../ipc';

/** What deleting `selected` does, for the confirmation (F-105). */
export interface CleanupEffect {
  count: number;
  merged: number;
  gone: number;
  /** Commits only the deleted `[gone]` branches reach: left to the reflog. */
  unmergedCommits: number;
}

export function cleanupEffect(
  branches: readonly CleanupBranch[],
  selected: ReadonlySet<string>,
): CleanupEffect {
  const chosen = branches.filter((b) => selected.has(b.name));
  return {
    count: chosen.length,
    merged: chosen.filter((b) => b.merged).length,
    gone: chosen.filter((b) => !b.merged && b.gone).length,
    unmergedCommits: chosen.reduce((sum, b) => sum + b.unmerged, 0),
  };
}

/** Selected by default: what is safe to delete (merged); `[gone]` with unmerged commits is not. */
export function defaultSelection(branches: readonly CleanupBranch[]): Set<string> {
  return new Set(branches.filter((b) => b.merged || b.unmerged === 0).map((b) => b.name));
}

/** The command the deletion runs, as shown in the dialog. */
export function cleanupCommand(names: readonly string[]): string {
  return `git branch -D -- ${names.join(' ')}`;
}
