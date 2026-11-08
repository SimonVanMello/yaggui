import { showError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { YagguiIpcError, ipc, unwrap, type KnownRepo, type YagguiError } from '../../ipc';
import { renameRepoSession } from './repoSessions';

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

/**
 * Sets the display name of a repository (tab "Rename…"); an empty name gives back the folder
 * name. The tabs, the welcome screen and the workspace overview all read the new name.
 */
export async function renameKnownRepo(
  repoId: number,
  name: string,
): Promise<{ ok: true; repo: KnownRepo } | { ok: false; error: YagguiError }> {
  let repo: KnownRepo;
  try {
    repo = await unwrap(ipc.commands.renameKnownRepo(repoId, name));
  } catch (error) {
    if (error instanceof YagguiIpcError) return { ok: false, error: error.error };
    throw error;
  }
  patchKnown((repos) => repos.map((known) => (known.id === repoId ? repo : known)));
  renameRepoSession(repoId, repo.name);
  void queryClient.invalidateQueries({ queryKey: queryKeys.knownRepos });
  return { ok: true, repo };
}
