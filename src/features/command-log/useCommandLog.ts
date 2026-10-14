import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';

/** Executed Git commands, oldest first; kept live by the `command-logged` event. */
export function useCommandLog() {
  return useQuery({
    queryKey: queryKeys.commandLog,
    queryFn: () => unwrap(ipc.commands.commandLog()),
    staleTime: Infinity,
  });
}
