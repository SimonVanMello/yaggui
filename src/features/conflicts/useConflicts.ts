import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';

/** Conflicted files with their labels; refreshed with the repo state (watcher events). */
export function useConflicts(repoId: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.conflicts(repoId),
    queryFn: () => unwrap(ipc.commands.listConflicts(repoId)),
    enabled,
    staleTime: Infinity,
  });
}
