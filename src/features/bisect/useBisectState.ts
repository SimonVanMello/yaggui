import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';
import { useRepoState } from '../repo/useRepoState';

/**
 * The bisect in progress, asked only while the repo state says one is; refreshed with the
 * operation detail (`refs-changed`, `status-changed`, after each step).
 */
export function useBisectState(repoId: number) {
  const bisecting = useRepoState(repoId).data?.operation?.kind === 'bisect';
  return useQuery({
    queryKey: queryKeys.bisectState(repoId),
    queryFn: () => unwrap(ipc.commands.bisectState(repoId)),
    enabled: bisecting,
    staleTime: Infinity,
    select: (state) => (bisecting ? state : null),
  });
}
