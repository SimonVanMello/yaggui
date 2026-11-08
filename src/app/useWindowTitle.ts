import { useEffect } from 'react';

import { repoDisplayName, useRepoSessions } from '../features/repo/repoSessions';
import { useKnownRepos } from '../features/repo/useKnownRepos';
import { useRepoState } from '../features/repo/useRepoState';
import { nativeWindow } from '../ipc';
import { platform } from '../ui/platform';
import { selectActiveTab, useTabsStore } from './tabs/tabsStore';
import { formatWindowTitle, headLabel } from './windowTitle';

/** Keeps the window title on the active tab's repository and branch (tab switch, checkout, rename). */
export function useWindowTitle(): void {
  const repoId = useTabsStore((state) => selectActiveTab(state).repoId);
  const session = useRepoSessions((state) =>
    repoId === null ? undefined : state.sessions[repoId],
  );
  const known = useKnownRepos().data?.find((repo) => repo.id === repoId);
  const state = useRepoState(repoId).data;
  const name = repoId === null ? null : repoDisplayName(session, known);
  const title = formatWindowTitle(
    name === null ? null : { repo: name, branch: state ? headLabel(state) : null },
    platform,
  );
  useEffect(() => {
    void nativeWindow.setTitle(title).catch((error: unknown) => {
      console.warn('Could not set the window title', error);
    });
  }, [title]);
}
