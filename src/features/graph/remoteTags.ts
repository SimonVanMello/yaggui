import { useQuery } from '@tanstack/react-query';

import { queryClient } from '../../app/queryClient';
import { usePreferences } from '../../app/usePreferences';
import { ipc, unwrap } from '../../ipc';

/** Tag name → remotes holding it at the same object. */
export type RemoteTagMap = ReadonlyMap<string, readonly string[]>;

const key = (repoId: number) => ['remote-tags', repoId] as const;

/** Repositories whose remotes must be asked again (`git ls-remote`) on the next read. */
const relist = new Set<number>();

/**
 * Tags present on the remotes (opt-in `remoteTags` preference): `null` while off or loading.
 * Off, nothing is asked: the backend only runs `ls-remote` when this query does.
 */
export function useRemoteTags(repoId: number): RemoteTagMap | null {
  const enabled = usePreferences().remoteTags === true;
  const query = useQuery({
    queryKey: key(repoId),
    queryFn: async (): Promise<RemoteTagMap> => {
      const refresh = relist.delete(repoId);
      const tags = await unwrap(ipc.commands.remoteTags(repoId, refresh));
      return new Map(tags.map((tag) => [tag.name, tag.remotes]));
    },
    enabled,
    // Only events refresh it: a graph row mounting while scrolling must not ask again.
    staleTime: Infinity,
  });
  return enabled ? (query.data ?? null) : null;
}

/** Local tags changed: compared again with the last listing, no network. */
export function invalidateRemoteTags(repoId: number): void {
  void queryClient.invalidateQueries({ queryKey: key(repoId) });
}

/** A fetch, pull or push may have changed the remote tags: list them again. */
export function relistRemoteTags(repoId: number): void {
  relist.add(repoId);
  invalidateRemoteTags(repoId);
}
