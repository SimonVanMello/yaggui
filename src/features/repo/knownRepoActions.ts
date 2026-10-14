import { showError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { ipc, unwrap, type KnownRepo } from '../../ipc';

function patchKnown(update: (repos: KnownRepo[]) => KnownRepo[]): KnownRepo[] | undefined {
  const previous = queryClient.getQueryData<KnownRepo[]>(queryKeys.knownRepos);
  if (previous) queryClient.setQueryData(queryKeys.knownRepos, update(previous));
  return previous;
}

/** Optimistic: the star toggles instantly and reverts if the store refuses. */
export async function setFavorite(repoId: number, favorite: boolean): Promise<void> {
  const previous = patchKnown((repos) =>
    repos.map((repo) => (repo.id === repoId ? { ...repo, favorite } : repo)),
  );
  try {
    await unwrap(ipc.commands.setRepoFavorite(repoId, favorite));
  } catch (error) {
    if (previous) queryClient.setQueryData(queryKeys.knownRepos, previous);
    showError(error);
  }
}

/** Removes a repository from the recent list; never touches the folder. */
export async function forgetKnownRepo(repoId: number): Promise<void> {
  const previous = patchKnown((repos) => repos.filter((repo) => repo.id !== repoId));
  try {
    await unwrap(ipc.commands.forgetRepo(repoId));
  } catch (error) {
    if (previous) queryClient.setQueryData(queryKeys.knownRepos, previous);
    showError(error);
  }
}
