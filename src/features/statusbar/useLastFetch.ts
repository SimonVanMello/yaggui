import { useQuery } from '@tanstack/react-query';

import { queryClient } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';
import { useYagguiEvent } from '../../ipc/useYagguiEvent';
import { isNetworkKind } from '../repo/opsStore';
import { useRepoSessions } from '../repo/repoSessions';

export const lastFetchKey = (repoId: number) => ['last-fetch', repoId] as const;

/** Last fetch of an open repository (`FETCH_HEAD`), seconds since the epoch; `null`: never. */
export function useLastFetch(repoId: number) {
  const open = useRepoSessions((state) => state.sessions[repoId]?.status === 'open');
  return useQuery({
    queryKey: lastFetchKey(repoId),
    queryFn: () => unwrap(ipc.commands.lastFetchedAt(repoId)),
    enabled: open,
    staleTime: Infinity,
  });
}

/**
 * Keeps the last fetch times fresh, for every repository: a fetch, pull or push that ends,
 * or refs that move (a fetch run from a terminal brings new remote branches). Mounted once.
 */
export function useLastFetchInvalidation(): void {
  const invalidate = (repoId: number) => {
    void queryClient.invalidateQueries({ queryKey: lastFetchKey(repoId) });
  };
  useYagguiEvent('opFinished', ({ repoId, kind }) => {
    if (isNetworkKind(kind)) invalidate(repoId);
  });
  useYagguiEvent('refsChanged', ({ repoId }) => {
    invalidate(repoId);
  });
}
