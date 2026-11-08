import { QueryObserver } from '@tanstack/react-query';

import { ipc, unwrap, type KnownRepo } from '../../ipc';
import { queryClient, queryKeys } from '../queryClient';

/** Length of File › Open Recent. */
export const RECENT_MAX = 10;

/**
 * The repositories of Open Recent: the most recently opened first, favorites or not. One that
 * was only imported (workspace scan) and never opened is not recent.
 */
export function recentRepos(known: readonly KnownRepo[]): KnownRepo[] {
  return known
    .filter((repo) => repo.lastOpenedAt > 0)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, RECENT_MAX);
}

/** What the menu shows of the list: a favorite star or a reorder past the 10th changes nothing. */
function signature(recents: readonly KnownRepo[]): string {
  return JSON.stringify(recents.map((repo) => [repo.path, repo.name, repo.exists]));
}

const options = {
  queryKey: queryKeys.knownRepos,
  queryFn: () => unwrap(ipc.commands.listRepos()),
};

/**
 * Reads the recent repositories, then calls `onChange` each time the shown part of them
 * changes. It follows the known repositories query: every open, forget, rename or relocation
 * invalidates it, and this observer keeps it active, so it is fetched again.
 */
export async function watchRecentRepos(
  onChange: (recents: KnownRepo[]) => void,
): Promise<KnownRepo[]> {
  let initial: KnownRepo[] = [];
  try {
    // The welcome screen may have read them already.
    initial = recentRepos(await queryClient.query({ ...options, staleTime: Infinity }));
  } catch (error) {
    console.warn('Recent repositories unavailable for the menu', error);
  }
  let shown = signature(initial);
  const observer = new QueryObserver(queryClient, { ...options, refetchOnMount: false });
  observer.subscribe((result) => {
    if (!result.data) return;
    const next = recentRepos(result.data);
    const nextSignature = signature(next);
    if (nextSignature === shown) return;
    shown = nextSignature;
    onChange(next);
  });
  return initial;
}
