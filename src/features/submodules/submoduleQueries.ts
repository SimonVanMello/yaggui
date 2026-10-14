import { useQuery } from '@tanstack/react-query';

import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type SubmoduleStatus } from '../../ipc';
import { useYagguiEvent } from '../../ipc/useYagguiEvent';
import { useRepoSessions } from '../repo/repoSessions';

export const submoduleKeys = {
  status: (repoId: number) => ['submodule-status', repoId] as const,
};

/**
 * Recorded vs checked out commit and local changes of each submodule (F-260). Separate from
 * the refs: it runs a status inside every submodule, so it is only asked for when the
 * repository has some, and refetched on `status-changed` / `refs-changed`.
 */
export function useSubmoduleStatus(repoId: number, enabled = true) {
  const open = useRepoSessions((state) => state.sessions[repoId]?.status === 'open');
  return useQuery({
    queryKey: submoduleKeys.status(repoId),
    queryFn: () => unwrap(ipc.commands.submoduleStatus(repoId)),
    enabled: open && enabled,
    staleTime: Infinity,
  });
}

export function submoduleStatusOf(
  statuses: readonly SubmoduleStatus[] | undefined,
  path: string,
): SubmoduleStatus | undefined {
  return statuses?.find((s) => s.path === path);
}

/** Keeps the submodule states current; mounted once by the shell. */
export function useSubmoduleRefresh(): void {
  const refresh = ({ repoId }: { repoId: number }) => {
    void queryClient.invalidateQueries({ queryKey: submoduleKeys.status(repoId) });
  };
  useYagguiEvent('statusChanged', refresh);
  useYagguiEvent('refsChanged', refresh);
  useYagguiEvent('opFinished', refresh);
}
