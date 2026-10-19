import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { currentPreferences } from '../../app/preferences';
import { queryClient, queryKeys } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, unwrap, type KnownRepo, type Workspace } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { closeTabAndRepo, restoreRepoSession, tryOpenRepo } from '../repo/repoSessions';
import { workspaceKeys } from './workspaceQueries';
import { useWorkspaceUi } from './workspaceStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

async function knownRepos(): Promise<KnownRepo[]> {
  return queryClient.query({
    queryKey: queryKeys.knownRepos,
    queryFn: () => unwrap(ipc.commands.listRepos()),
    staleTime: 0,
  });
}

function storeWorkspace(workspace: Workspace): void {
  queryClient.setQueryData<Workspace[]>(workspaceKeys.all, (list) =>
    list?.map((w) => (w.id === workspace.id ? workspace : w)),
  );
  void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
}

/** Creates a workspace and returns it; `null` (error shown) if the name is refused. */
export async function createWorkspace(
  name: string,
  repoIds: readonly number[] = [],
): Promise<Workspace | null> {
  try {
    const workspace = await unwrap(ipc.commands.createWorkspace(name, [...repoIds]));
    await queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    return workspace;
  } catch (error) {
    showError(error);
    return null;
  }
}

export async function renameWorkspace(workspaceId: number, name: string): Promise<boolean> {
  try {
    storeWorkspace(await unwrap(ipc.commands.renameWorkspace(workspaceId, name)));
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

/** Asks first: the workspace goes, its repos stay in the list. */
export async function deleteWorkspace(workspace: Workspace): Promise<boolean> {
  const confirmed = await confirm({
    title: t('workspace.delete.title', { name: workspace.name }),
    description: t('workspace.delete.description', { count: workspace.repoIds.length }),
    confirmLabel: t('workspace.delete.confirm'),
    danger: true,
  });
  if (!confirmed) return false;
  try {
    await unwrap(ipc.commands.deleteWorkspace(workspace.id));
    queryClient.setQueryData<Workspace[]>(workspaceKeys.all, (list) =>
      list?.filter((w) => w.id !== workspace.id),
    );
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

export async function addReposToWorkspace(
  workspaceId: number,
  repoIds: readonly number[],
): Promise<void> {
  try {
    storeWorkspace(await unwrap(ipc.commands.addToWorkspace(workspaceId, [...repoIds])));
  } catch (error) {
    showError(error);
  }
}

export async function removeRepoFromWorkspace(workspaceId: number, repoId: number): Promise<void> {
  try {
    storeWorkspace(await unwrap(ipc.commands.removeFromWorkspace(workspaceId, repoId)));
  } catch (error) {
    showError(error);
  }
}

function isEmptyTab(tabId: string | undefined): boolean {
  return useTabsStore.getState().tabs.some((tab) => tab.id === tabId && tab.repoId === null);
}

/**
 * Opens every repo of the workspace in a tab (F-006), in the workspace order, and activates the
 * first one. `targetTabId` (a welcome tab) receives the first repo. Missing folders are skipped
 * and reported with a way to fix them.
 */
export async function openWorkspace(workspace: Workspace, targetTabId?: string): Promise<void> {
  let known: KnownRepo[];
  try {
    known = await knownRepos();
  } catch (error) {
    showError(error);
    return;
  }
  const byId = new Map(known.map((repo) => [repo.id, repo]));
  const repos = workspace.repoIds.flatMap((id) => byId.get(id) ?? []);
  const missing = repos.filter((repo) => !repo.exists);
  const failed: string[] = [];
  let firstRepoId: number | null = null;
  let target = targetTabId;
  // One at a time: tabs then follow the workspace order.
  for (const repo of repos) {
    if (!repo.exists) continue;
    const error = await tryOpenRepo(repo.path, target);
    if (error) {
      failed.push(repo.name);
      continue;
    }
    // A repo that already had a tab leaves the welcome tab for the next one.
    if (!isEmptyTab(target)) target = undefined;
    firstRepoId ??= repo.id;
  }
  const tabs = useTabsStore.getState();
  if (targetTabId && firstRepoId !== null && isEmptyTab(targetTabId)) tabs.closeTab(targetTabId);
  const first = tabs.tabs.find((tab) => tab.repoId === firstRepoId);
  if (first) tabs.activate(first.id);

  if (missing.length > 0) {
    toast({
      variant: 'warning',
      title: t('workspace.open.missing', { count: missing.length }),
      description: missing.map((repo) => repo.name).join(', '),
      action: {
        label: t('workspace.open.review'),
        onClick: () => {
          useWorkspaceUi.getState().openManager(workspace.id);
        },
      },
    });
  }
  if (failed.length > 0) {
    toast({
      variant: 'error',
      title: t('workspace.open.failed', { count: failed.length }),
      description: failed.join(', '),
    });
  }
}

/**
 * "Fetch all" (F-008): fetches every existing repo of the workspace. All requests start at once,
 * the backend runs a few at a time; each row shows its own result as soon as it is known.
 */
export async function fetchWorkspace(workspace: Workspace): Promise<void> {
  const ui = useWorkspaceUi.getState();
  let known: KnownRepo[];
  try {
    known = await knownRepos();
  } catch (error) {
    showError(error);
    return;
  }
  const exists = new Set(known.filter((repo) => repo.exists).map((repo) => repo.id));
  const ids = workspace.repoIds.filter(
    (id) => exists.has(id) && ui.fetches[id]?.status !== 'running',
  );
  if (ids.length === 0) return;
  const prune = currentPreferences().prune;
  const results = await Promise.all(
    ids.map(async (repoId) => {
      useWorkspaceUi.getState().setFetch(repoId, { status: 'running' });
      const result = await ipc.commands.fetchKnownRepo(repoId, prune);
      useWorkspaceUi
        .getState()
        .setFetch(
          repoId,
          result.status === 'ok' ? { status: 'done' } : { status: 'failed', error: result.error },
        );
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.overview(repoId) });
      return result.status === 'ok' || result.error.code === 'cancelled';
    }),
  );
  const failures = results.filter((ok) => !ok).length;
  if (failures === 0) {
    toast({
      variant: 'success',
      title: t('workspace.fetch.done', { count: ids.length, name: workspace.name }),
    });
  } else {
    toast({
      variant: 'warning',
      title: t('workspace.fetch.failed', { count: failures, total: ids.length }),
    });
  }
}

let picking = false;

/** Native folder picker with a title of our own; `null` if cancelled or unavailable. */
export async function pickFolder(titleKey: MessageKey): Promise<string | null> {
  if (picking) return null;
  picking = true;
  try {
    return await unwrap(ipc.commands.pickRepoFolder(t(titleKey)));
  } catch (error) {
    console.warn('Folder picker unavailable', error);
    toast({ variant: 'warning', title: t('openDialog.pickerFailed') });
    return null;
  } finally {
    picking = false;
  }
}

/** Refreshes what shows a known repo after its entry changed. */
function invalidateRepoLists(repoIds: readonly number[]): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.knownRepos });
  void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  for (const id of repoIds) {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.overview(id) });
  }
}

/**
 * Points a moved repo to a folder chosen by the user (F-009). Tabs showing it reopen it from
 * there. Returns `true` once relocated.
 */
export async function relocateRepo(repoId: number, path?: string): Promise<boolean> {
  const chosen = path ?? (await pickFolder('workspace.relocate.pickerTitle'));
  if (!chosen) return false;
  let relocated: KnownRepo;
  try {
    relocated = await unwrap(ipc.commands.relocateRepo(repoId, chosen));
  } catch (error) {
    showError(error, { title: t('workspace.relocate.failed') });
    return false;
  }
  invalidateRepoLists([repoId, relocated.id]);
  // Merged into an entry already known at that folder: its tabs now show that one.
  const tabs = useTabsStore.getState();
  for (const tab of tabs.tabs) {
    if (tab.repoId !== repoId) continue;
    if (relocated.id !== repoId) tabs.setRepo(tab.id, relocated.id);
    void restoreRepoSession(relocated.id);
  }
  toast({ variant: 'success', title: t('workspace.relocate.done', { name: relocated.name }) });
  return true;
}

/** Imports scanned folders, into a workspace if given. Returns the imported ids. */
export async function importRepos(
  paths: readonly string[],
  workspaceId: number | null,
): Promise<number[] | null> {
  try {
    const result = await unwrap(ipc.commands.importRepos([...paths], workspaceId));
    invalidateRepoLists([]);
    if (result.failed.length > 0) {
      toast({
        variant: 'warning',
        title: t('scan.importFailed', { count: result.failed.length }),
        description: result.failed.map((failure) => failure.path).join('\n'),
      });
    }
    return result.repoIds;
  } catch (error) {
    showError(error);
    return null;
  }
}

/** Removes the repo from the known list (and so from its workspaces). */
export async function forgetRepo(repoId: number): Promise<void> {
  try {
    await unwrap(ipc.commands.forgetRepo(repoId));
    // Its tab would keep pointing to a repo id that no longer exists.
    for (const tab of useTabsStore.getState().tabs) {
      if (tab.repoId === repoId) closeTabAndRepo(tab.id);
    }
  } catch (error) {
    showError(error);
  }
  invalidateRepoLists([repoId]);
}
