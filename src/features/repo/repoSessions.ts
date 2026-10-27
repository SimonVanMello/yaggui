import { create } from 'zustand';

import { showYagguiError } from '../../app/errors/presentError';
import { forgetCompare } from '../compare/compareStore';
import { closeInteractiveRebase } from '../rebase/rebaseStore';
import { useStashPreview } from '../refs/stashPreview';
import { forgetCommitUi } from '../staging/commitUi';
import { disposeRepoTerminals } from '../terminal/terminalActions';
import { useGraphNavigation } from './graphNavigation';
import { forgetLastFinished } from './opsStore';
import { queryClient, queryKeys } from '../../app/queryClient';
import { loadRepoLayout } from '../../app/tabs/repoLayout';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore } from '../../i18n/i18n';
import {
  YagguiIpcError,
  ipc,
  unwrap,
  type YagguiError,
  type KnownRepo,
  type RepoInfo,
} from '../../ipc';

export type RepoSession =
  | { status: 'opening'; name: string | null }
  | { status: 'open'; info: RepoInfo }
  | { status: 'error'; name: string | null; path: string | null; error: YagguiError };

interface RepoSessionsStore {
  sessions: Record<number, RepoSession | undefined>;
}

export const useRepoSessions = create<RepoSessionsStore>()(() => ({ sessions: {} }));

function setSession(repoId: number, session: RepoSession | undefined): void {
  useRepoSessions.setState((state) => ({ sessions: { ...state.sessions, [repoId]: session } }));
}

function asYagguiError(error: unknown): YagguiError {
  if (error instanceof YagguiIpcError) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'internal',
    message: { en: message, fr: message },
    action: null,
    detail: null,
    payload: null,
  };
}

/**
 * Repositories for which this frontend holds one backend session (one `openRepo` not yet
 * matched by `closeRepo`). The backend counts references, so every `openRepo` must be
 * balanced by exactly one `closeRepo`: the tab of a repository owns its single reference.
 */
const held = new Set<number>();

function closeBackendSession(repoId: number): void {
  void ipc.commands.closeRepo(repoId).catch((error: unknown) => {
    console.warn('closeRepo failed', error);
  });
}

function hasTab(repoId: number): boolean {
  return useTabsStore.getState().tabs.some((tab) => tab.repoId === repoId);
}

/** Takes ownership of a successful `openRepo`, or gives it back if already held. */
function acquire(repoId: number): void {
  if (held.has(repoId)) closeBackendSession(repoId);
  else held.add(repoId);
}

/** Number of backend sessions currently held (for tests and diagnostics). */
export function heldSessionCount(): number {
  return held.size;
}

function registerOpenRepo(info: RepoInfo): void {
  acquire(info.id);
  setSession(info.id, { status: 'open', info });
  queryClient.setQueryData(queryKeys.repoState(info.id), info.state);
  void queryClient.invalidateQueries({ queryKey: queryKeys.knownRepos });
}

async function knownRepos(): Promise<KnownRepo[]> {
  return queryClient.query({
    queryKey: queryKeys.knownRepos,
    queryFn: () => unwrap(ipc.commands.listRepos()),
    staleTime: 0,
  });
}

/**
 * Opens the repository at `path` in a tab (F-001): activates its tab if it is already open,
 * otherwise uses `targetTabId` (a welcome tab) or a new tab. Returns the error, if any,
 * without showing it.
 */
export async function tryOpenRepo(path: string, targetTabId?: string): Promise<YagguiError | null> {
  let info: RepoInfo;
  try {
    info = await unwrap(ipc.commands.openRepo(path));
  } catch (error) {
    return asYagguiError(error);
  }
  registerOpenRepo(info);

  const layout = await loadRepoLayout(info.id);
  // Read after the load: another open of the same repository may have finished meanwhile.
  const tabs = useTabsStore.getState();
  const existing = tabs.tabs.find((tab) => tab.repoId === info.id);
  if (existing) {
    tabs.activate(existing.id);
    return null;
  }
  const target = tabs.tabs.find((tab) => tab.id === targetTabId && tab.repoId === null);
  const tabId = target?.id ?? tabs.newTab();
  tabs.setRepo(tabId, info.id, layout);
  tabs.activate(tabId);
  return null;
}

/** Same as `tryOpenRepo`, showing a failure as an error toast with its suggested action. */
export async function openRepoPath(path: string, targetTabId?: string): Promise<boolean> {
  const error = await tryOpenRepo(path, targetTabId);
  if (error) {
    showYagguiError(error, {
      title: translate(useI18nStore.getState().locale, 'repo.openFailed'),
      retry: () => void openRepoPath(path, targetTabId),
    });
  }
  return error === null;
}

/** (Re)opens the repository of a restored tab, keeping the error in the tab if it fails. */
export async function restoreRepoSession(repoId: number): Promise<void> {
  const current = useRepoSessions.getState().sessions[repoId];
  if (current?.status === 'opening' || current?.status === 'open') return;
  const name = current?.status === 'error' ? current.name : null;
  setSession(repoId, { status: 'opening', name });

  let known: KnownRepo | undefined;
  try {
    known = (await knownRepos()).find((repo) => repo.id === repoId);
  } catch (error) {
    setSession(repoId, { status: 'error', name, path: null, error: asYagguiError(error) });
    return;
  }
  if (!known) {
    const message = {
      en: translate('en', 'repo.unknown'),
      fr: translate('fr', 'repo.unknown'),
    };
    setSession(repoId, {
      status: 'error',
      name: null,
      path: null,
      error: { code: 'repoNotFound', message, action: null, detail: null, payload: null },
    });
    return;
  }
  let info: RepoInfo;
  try {
    info = await unwrap(ipc.commands.openRepo(known.path));
  } catch (error) {
    if (!hasTab(repoId)) return;
    setSession(repoId, {
      status: 'error',
      name: known.name,
      path: known.path,
      error: asYagguiError(error),
    });
    return;
  }
  // The tab was closed while the repository was opening: give the session back.
  if (!hasTab(info.id)) {
    closeBackendSession(info.id);
    return;
  }
  registerOpenRepo(info);
}

/** Closes the tab and, since a repository has a single tab, its backend session. */
export function closeTabAndRepo(tabId: string): void {
  const tabs = useTabsStore.getState();
  const tab = tabs.tabs.find((t) => t.id === tabId);
  tabs.closeTab(tabId);
  if (tab?.repoId != null) releaseRepo(tab.repoId);
}

/**
 * Whether `queryKey` belongs to the repository: every per-repository key puts the id right
 * after its name (`['repo-state', repoId]`, `['diff', repoId, …]`), except the Git config
 * entries (`['git-config', 'repo', repoId]`).
 */
export function isRepoQueryKey(queryKey: readonly unknown[], repoId: number): boolean {
  return queryKey[1] === repoId || (queryKey[0] === 'git-config' && queryKey[2] === repoId);
}

/**
 * Forgets everything cached about the repository: a session reopened later reads it again,
 * since the repository may have changed meanwhile (`staleTime: Infinity` queries never would).
 */
function forgetRepo(repoId: number): void {
  setSession(repoId, undefined);
  queryClient.removeQueries({ predicate: (query) => isRepoQueryKey(query.queryKey, repoId) });
  useGraphNavigation.getState().clear(repoId);
  closeInteractiveRebase(repoId);
  disposeRepoTerminals(repoId);
  // The UI state kept per repository (the graph source and the inspect view follow the
  // session on their own).
  forgetCompare(repoId);
  useStashPreview.getState().clear(repoId);
  forgetCommitUi(repoId);
  forgetLastFinished(repoId);
}

/**
 * Drops the session of a repository that no tab shows anymore. An `openRepo` still in flight
 * is balanced when it completes (see `restoreRepoSession`).
 */
export function releaseRepo(repoId: number): void {
  if (hasTab(repoId)) return;
  forgetRepo(repoId);
  if (held.delete(repoId)) closeBackendSession(repoId);
}

/**
 * Drops a session the backend closed on its own (a relocation closes every session of the
 * repository): there is nothing to give back, and the tab reopens it from the new folder.
 */
export function resetRepoSession(repoId: number): void {
  held.delete(repoId);
  forgetRepo(repoId);
}

/** Display name of a tab's repository, from its session or the known repos list. */
export function repoDisplayName(
  session: RepoSession | undefined,
  known: KnownRepo | undefined,
): string | null {
  if (session?.status === 'open') return session.info.name;
  return session?.name ?? known?.name ?? null;
}

export function activeRepoId(): number | null {
  return selectActiveTab(useTabsStore.getState()).repoId;
}
