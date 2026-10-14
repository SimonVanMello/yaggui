import { useQuery } from '@tanstack/react-query';

import { ipc, unwrap } from '../../ipc';
import { useRepoSessions } from '../repo/repoSessions';

export const lfsKeys = {
  status: (repoId: number) => ['lfs-status', repoId] as const,
};

/** LFS use, tracked patterns and installed `git lfs` version of a repository (F-262). */
export function useLfsStatus(repoId: number | null) {
  const open = useRepoSessions(
    (state) => repoId !== null && state.sessions[repoId]?.status === 'open',
  );
  return useQuery({
    queryKey: lfsKeys.status(repoId ?? -1),
    queryFn: () => unwrap(ipc.commands.lfsStatus(repoId ?? -1)),
    enabled: open,
    staleTime: Infinity,
  });
}
