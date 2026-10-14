import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { ipc, unwrap, type RepoOperation } from '../../ipc';

/**
 * Detail of the operation in progress (labels, prepared message, whether it can continue).
 * Only asked while `operation` is set in the repo state; refreshed with it.
 */
export function useOperationDetail(repoId: number, operation: RepoOperation | null) {
  return useQuery({
    queryKey: queryKeys.operationDetail(repoId),
    queryFn: () => unwrap(ipc.commands.operationDetail(repoId)),
    enabled: operation !== null,
    staleTime: Infinity,
  });
}
