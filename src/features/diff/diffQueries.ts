import { useQuery } from '@tanstack/react-query';

import { queryClient } from '../../app/queryClient';
import { useRepoEvent } from '../../app/tabs/tabSuspension';
import { ipc, unwrap, type DiffOptions, type DiffSide, type DiffTarget } from '../../ipc';
import { targetKey } from './diffStore';

export const diffKeys = {
  repo: (repoId: number) => ['diff', repoId] as const,
  worktree: (repoId: number) => ['diff', repoId, 'worktree'] as const,
  files: (repoId: number, target: DiffTarget) =>
    [...scope(repoId, target), 'files', targetKey(target)] as const,
  file: (
    repoId: number,
    target: DiffTarget,
    path: string,
    oldPath: string | null,
    options: DiffOptions,
  ) => [...scope(repoId, target), 'file', targetKey(target), path, oldPath, options] as const,
  /** Working tree file of the editor: a watcher event reloads it like the diffs. */
  edit: (repoId: number, path: string) => [...diffKeys.worktree(repoId), 'edit', path] as const,
  image: (
    repoId: number,
    target: DiffTarget,
    path: string,
    oldPath: string | null,
    side: DiffSide,
  ) => [...scope(repoId, target), 'image', targetKey(target), path, oldPath, side] as const,
};

/** Commit diffs never change; index and working tree diffs are refreshed by the watcher. */
function scope(repoId: number, target: DiffTarget) {
  return target.kind === 'commits'
    ? (['diff', repoId, 'commits'] as const)
    : diffKeys.worktree(repoId);
}

export function useChangedFiles(repoId: number, target: DiffTarget | null) {
  return useQuery({
    queryKey: target ? diffKeys.files(repoId, target) : ['diff', repoId, 'none'],
    queryFn: () => (target ? unwrap(ipc.commands.changedFiles(repoId, target)) : null),
    enabled: target !== null,
    staleTime: Infinity,
  });
}

/** Position of `targetKey(target)` in a `diffKeys.file` key. */
const FILE_KEY_TARGET = 4;

/**
 * Whether the diff of `previousKey` (a `diffKeys.file` key) may stand in for the one of
 * `target` while it loads: only from the same list, so a file in both lists never shows its
 * unstaged hunks under the "staged" title.
 */
export function placeholderFor(
  previousKey: readonly unknown[] | undefined,
  target: DiffTarget,
): boolean {
  return previousKey?.[FILE_KEY_TARGET] === targetKey(target);
}

export function useFileDiff(
  repoId: number,
  target: DiffTarget,
  path: string,
  oldPath: string | null,
  options: DiffOptions,
  enabled = true,
) {
  return useQuery({
    queryKey: diffKeys.file(repoId, target, path, oldPath, options),
    queryFn: () => unwrap(ipc.commands.fileDiff(repoId, target, path, oldPath, options)),
    enabled,
    staleTime: Infinity,
    // Keeps the previous file on screen while the next one loads: no flash between files.
    placeholderData: (previous, previousQuery) =>
      placeholderFor(previousQuery?.queryKey, target) ? previous : undefined,
  });
}

/** Working tree content of a file and its index version, for the file editor. */
export function useWorktreeFile(repoId: number, path: string) {
  return useQuery({
    queryKey: diffKeys.edit(repoId, path),
    queryFn: () => unwrap(ipc.commands.worktreeFile(repoId, path)),
    staleTime: Infinity,
    // An edited file is never loaded in place of another one.
    gcTime: 0,
  });
}

/** One side of an image as a `data:` URL (F-085); `null` when absent or not displayable. */
export function useDiffImage(
  repoId: number,
  target: DiffTarget,
  path: string,
  oldPath: string | null,
  side: DiffSide,
) {
  return useQuery({
    queryKey: diffKeys.image(repoId, target, path, oldPath, side),
    queryFn: () => unwrap(ipc.commands.diffImage(repoId, target, path, oldPath, side)),
    staleTime: Infinity,
  });
}

/**
 * Targeted refresh of the index / working tree diffs of `repoId` on watcher events
 * (CLAUDE.md: no global re-render). Mount it where those diffs are shown.
 */
export function useWorktreeDiffRefresh(repoId: number): void {
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: diffKeys.worktree(repoId) });
  };
  useRepoEvent('statusChanged', repoId, refresh);
  useRepoEvent('refsChanged', repoId, refresh);
}
