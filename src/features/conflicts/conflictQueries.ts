import { useQuery } from '@tanstack/react-query';

import { queryClient } from '../../app/queryClient';
import { useRepoEvent } from '../../app/tabs/tabSuspension';
import { ipc, unwrap, type ConflictStage } from '../../ipc';

/**
 * Queries of the file open in the conflict editor. Not under `queryKeys.conflicts` (the list,
 * invalidated on every watcher event): the versions must not be re-read while edited.
 */
export const conflictFileKeys = {
  repo: (repoId: number) => ['conflict-file', repoId] as const,
  versions: (repoId: number, path: string) => ['conflict-file', repoId, 'versions', path] as const,
  image: (repoId: number, path: string, stage: ConflictStage) =>
    ['conflict-file', repoId, 'image', path, stage] as const,
  tool: (repoId: number) => ['conflict-file', repoId, 'tool'] as const,
};

/**
 * The versions of a conflicted file, read each time the view opens (dropped when it closes).
 * While a conflict is on screen the watcher does not refresh it: the editor would lose what is
 * being edited. A file shown as resolved is re-read when the working tree changes (put back in
 * conflict by `git checkout -m`, for instance).
 */
export function useConflictVersions(repoId: number, path: string) {
  const query = useQuery({
    queryKey: conflictFileKeys.versions(repoId, path),
    queryFn: () => unwrap(ipc.commands.conflictVersions(repoId, path)),
    staleTime: Infinity,
    gcTime: 0,
  });
  const resolved = query.data?.kind === null;
  useRepoEvent('statusChanged', repoId, () => {
    if (resolved) void query.refetch();
  });
  return query;
}

export function useConflictImage(
  repoId: number,
  path: string,
  stage: ConflictStage,
  enabled: boolean,
) {
  return useQuery({
    queryKey: conflictFileKeys.image(repoId, path, stage),
    queryFn: () => unwrap(ipc.commands.conflictImage(repoId, path, stage)),
    enabled,
    staleTime: Infinity,
  });
}

/** `merge.tool` of the repository (`null`: none configured). */
export function useMergeTool(repoId: number) {
  return useQuery({
    queryKey: conflictFileKeys.tool(repoId),
    queryFn: () => unwrap(ipc.commands.mergeTool(repoId)),
    staleTime: 60_000,
  });
}

/** Re-reads the versions of the conflicted files (after a resolution). */
export function refreshConflictFiles(repoId: number): void {
  void queryClient.invalidateQueries({ queryKey: conflictFileKeys.repo(repoId) });
}
