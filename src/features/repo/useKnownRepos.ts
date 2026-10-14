import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';

/** Recent and favorite repositories, most recently opened first. */
export function useKnownRepos() {
  return useQuery({
    queryKey: queryKeys.knownRepos,
    queryFn: () => unwrap(ipc.commands.listRepos()),
  });
}
