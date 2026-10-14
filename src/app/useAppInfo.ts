import { useQuery } from '@tanstack/react-query';

import { ipc } from '../ipc';
import { queryKeys } from './queryClient';

export function useAppInfo() {
  return useQuery({
    queryKey: queryKeys.appInfo,
    queryFn: () => ipc.commands.appInfo(),
    staleTime: Infinity,
  });
}
