import { useQuery } from '@tanstack/react-query';

import { queryClient, queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';

/** Labels and blocked reasons of the next undo and redo; refetched on `journal-changed`. */
export function useUndoState(repoId: number) {
  return useQuery({
    queryKey: queryKeys.undoState(repoId),
    queryFn: () => unwrap(ipc.commands.undoState(repoId)),
  });
}

/** Operations of the session, newest first. Only fetched while the history is open. */
export function useOpHistory(repoId: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.opHistory(repoId),
    queryFn: () => unwrap(ipc.commands.opHistory(repoId)),
    enabled,
  });
}

/** Targeted: only the two journal queries of this repository. */
export function invalidateJournal(repoId: number): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.undoState(repoId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.opHistory(repoId) });
}
