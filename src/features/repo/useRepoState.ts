import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';
import { useRepoSessions } from './repoSessions';

/** Live state of an open repository; refreshed by `status-changed` / `refs-changed` events. */
export function useRepoState(repoId: number | null) {
  const open = useRepoSessions((state) =>
    repoId === null ? false : state.sessions[repoId]?.status === 'open',
  );
  return useQuery({
    queryKey: queryKeys.repoState(repoId ?? -1),
    queryFn: () => unwrap(ipc.commands.repoState(repoId ?? -1)),
    enabled: open,
    staleTime: Infinity,
  });
}
