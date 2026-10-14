import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';
import { useRepoSessions } from '../repo/repoSessions';

/** Branches, tags, stashes… of an open repository; refetched on `refs-changed`. */
export function useRepoRefs(repoId: number) {
  const open = useRepoSessions((state) => state.sessions[repoId]?.status === 'open');
  return useQuery({
    queryKey: queryKeys.repoRefs(repoId),
    queryFn: () => unwrap(ipc.commands.listRefs(repoId)),
    enabled: open,
    staleTime: Infinity,
  });
}
