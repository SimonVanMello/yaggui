import { showError, showYagguiError } from '../errors/presentError';
import { queryClient, queryKeys } from '../queryClient';
import { tryOpenRepo } from '../../features/repo/repoSessions';
import { useWorkspaceUi } from '../../features/workspaces/workspaceStore';
import { translate, useI18nStore } from '../../i18n/i18n';
import { ipc, unwrap, type KnownRepo } from '../../ipc';
import { selectActiveTab, useTabsStore, type ClosedTab } from './tabsStore';

/** Whether "Reopen closed tab" has something to bring back. */
export function canReopenClosedTab(): boolean {
  return useTabsStore.getState().closedTabs.length > 0;
}

async function knownRepo(repoId: number): Promise<KnownRepo | undefined> {
  const repos = await queryClient.query({
    queryKey: queryKeys.knownRepos,
    queryFn: () => unwrap(ipc.commands.listRepos()),
    staleTime: 0,
  });
  return repos.find((repo) => repo.id === repoId);
}

/**
 * `⌘⇧T`: opens the repository of the last closed tab again, at its former place, pinned if it
 * was. Its layout comes back with the repository (`loadRepoLayout`). A folder that moved or
 * disappeared offers to locate it again (F-009); a repository removed from the recents since
 * is skipped for the one closed before it.
 */
export async function reopenClosedTab(): Promise<void> {
  let entry: ClosedTab | undefined;
  let known: KnownRepo | undefined;
  while (!known) {
    entry = useTabsStore.getState().popClosedTab();
    if (!entry) return;
    try {
      known = await knownRepo(entry.repoId);
    } catch (error) {
      showError(error);
      return;
    }
  }
  const closed = entry;

  const tabs = useTabsStore.getState();
  const open = tabs.tabs.find((tab) => tab.repoId === known.id);
  if (open) {
    tabs.activate(open.id);
    return;
  }
  if (!known.exists) {
    useWorkspaceUi.getState().showMissing(known.id);
    return;
  }
  // The welcome tab left by closing the last tab takes the repository, rather than staying.
  const active = selectActiveTab(tabs);
  const error = await tryOpenRepo(known.path, active.repoId === null ? active.id : undefined);
  if (error) {
    if (error.code === 'repoNotFound') useWorkspaceUi.getState().showMissing(known.id);
    else {
      showYagguiError(error, {
        title: translate(useI18nStore.getState().locale, 'repo.openFailed'),
      });
    }
    return;
  }
  const tab = useTabsStore.getState().tabs.find((t) => t.repoId === known.id);
  if (tab && closed) useTabsStore.getState().placeReopened(tab.id, closed);
}
