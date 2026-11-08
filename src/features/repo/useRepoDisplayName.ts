import { repoDisplayName, useRepoSessions } from './repoSessions';
import { useKnownRepos } from './useKnownRepos';

/**
 * Display name of a repository as the tabs show it: the name given with "Rename…", else the
 * folder name. `null` for no repository, or while neither its session nor the list knows it.
 */
export function useRepoDisplayName(repoId: number | null): string | null {
  const session = useRepoSessions((state) =>
    repoId === null ? undefined : state.sessions[repoId],
  );
  const known = useKnownRepos().data?.find((repo) => repo.id === repoId);
  return repoId === null ? null : repoDisplayName(session, known);
}
