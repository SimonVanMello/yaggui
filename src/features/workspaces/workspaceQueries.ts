import { useQuery } from '@tanstack/react-query';

import { ipc, unwrap } from '../../ipc';

export const workspaceKeys = {
  all: ['workspaces'] as const,
  overview: (repoId: number) => ['repo-overview', repoId] as const,
};

/** Overview rows stay fresh this long: reopening the dialog does not rescan every repo. */
const OVERVIEW_STALE_MS = 15_000;

export function useWorkspaces() {
  return useQuery({
    queryKey: workspaceKeys.all,
    queryFn: () => unwrap(ipc.commands.listWorkspaces()),
  });
}

/**
 * Branch, ahead / behind, dirty state and last fetch of one repo (F-008). One query per row:
 * rows fill in as their read completes, and the backend bounds how many run at once.
 */
export function useRepoOverview(repoId: number) {
  return useQuery({
    queryKey: workspaceKeys.overview(repoId),
    queryFn: () => unwrap(ipc.commands.repoOverview(repoId)),
    staleTime: OVERVIEW_STALE_MS,
  });
}
