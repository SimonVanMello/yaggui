import { QueryClient } from '@tanstack/react-query';

import { refetchOnMount } from './tabs/tabSuspension';

/** Shared so non-React modules (event handlers, repo sessions) can update cached data. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false, refetchOnMount } },
});

export const queryKeys = {
  appInfo: ['app-info'] as const,
  changelog: ['changelog'] as const,
  knownRepos: ['known-repos'] as const,
  commandLog: ['command-log'] as const,
  repoState: (repoId: number) => ['repo-state', repoId] as const,
  repoRefs: (repoId: number) => ['repo-refs', repoId] as const,
  operationDetail: (repoId: number) => ['operation-detail', repoId] as const,
  bisectState: (repoId: number) => ['bisect-state', repoId] as const,
  conflicts: (repoId: number) => ['conflicts', repoId] as const,
  undoState: (repoId: number) => ['undo-state', repoId] as const,
  opHistory: (repoId: number) => ['op-history', repoId] as const,
};
