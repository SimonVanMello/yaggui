import type { RemoteRefs } from '../../ipc';

/**
 * The remotes the Fetch menu offers, from the refs (refreshed on every refs change, so the
 * menu follows the Remotes dialog): the configured ones, `origin` first. A group of
 * remote-tracking branches left by a removed remote has no URL: nothing to fetch there.
 */
export function fetchRemotes(remotes: readonly RemoteRefs[] | undefined): string[] {
  if (!remotes) return [];
  const names = remotes.filter((remote) => remote.url !== null).map((remote) => remote.name);
  return names.sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
}
