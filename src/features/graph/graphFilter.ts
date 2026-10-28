import { useQuery } from '@tanstack/react-query';

import { showYagguiError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { translate, useI18nStore } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type GraphFilter } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { revealCommit } from '../repo/graphNavigation';
import { useRepoSessions } from '../repo/repoSessions';
import { shortOid } from '../repo/repoStatus';
import { getGraphSource, invalidateGraph } from './graphSource';

/**
 * Refs hidden from the graph or soloed (F-028) and first-parent mode (F-032), persisted per
 * repository by the backend.
 */

export const EMPTY_FILTER: GraphFilter = {
  hidden: [],
  solo: null,
  hideRemotes: false,
  hideStashes: false,
  firstParent: false,
};

export const graphFilterKey = (repoId: number) => ['graph-filter', repoId] as const;

export function isFilterActive(filter: GraphFilter | undefined): boolean {
  return (
    filter !== undefined &&
    (filter.hidden.length > 0 ||
      filter.solo !== null ||
      filter.hideRemotes ||
      filter.hideStashes ||
      isFirstParent(filter))
  );
}

export function isFirstParent(filter: GraphFilter | undefined): boolean {
  return filter?.firstParent ?? false;
}

export function useGraphFilter(repoId: number): GraphFilter {
  const open = useRepoSessions((state) => state.sessions[repoId]?.status === 'open');
  const query = useQuery({
    queryKey: graphFilterKey(repoId),
    queryFn: () => unwrap(ipc.commands.graphFilter(repoId)),
    enabled: open,
    staleTime: Infinity,
  });
  return query.data ?? EMPTY_FILTER;
}

export function currentFilter(repoId: number): GraphFilter {
  return queryClient.getQueryData<GraphFilter>(graphFilterKey(repoId)) ?? EMPTY_FILTER;
}

/** Applies `change` to the current filter, stores it and reloads the graph and the refs rows. */
export async function updateGraphFilter(
  repoId: number,
  change: (filter: GraphFilter) => GraphFilter,
): Promise<void> {
  const next = change(currentFilter(repoId));
  try {
    const stored = await unwrap(ipc.commands.setGraphFilter(repoId, next));
    queryClient.setQueryData(graphFilterKey(repoId), stored);
  } catch (error) {
    if (error instanceof YagguiIpcError) {
      showYagguiError(error.error, {
        title: translate(useI18nStore.getState().locale, 'graph.filter.failed'),
      });
      return;
    }
    throw error;
  }
  invalidateGraph(repoId);
  void queryClient.invalidateQueries({ queryKey: queryKeys.repoRefs(repoId) });
}

/**
 * Name a graph filter uses for a folder of the refs tree (`backup` of local branches →
 * `refs/heads/backup/`): it hides every branch under it, including those created later.
 */
export function folderFilterName(section: 'local' | 'remote', path: string): string {
  return `${section === 'local' ? 'refs/heads/' : 'refs/remotes/'}${path}/`;
}

function covers(entry: string, fullName: string): boolean {
  return entry === fullName || (entry.endsWith('/') && fullName.startsWith(entry));
}

/**
 * Hides `fullName` (a ref or a folder), or shows it again. Hiding a folder drops the entries it
 * now covers; hiding the soloed ref, or its folder, leaves solo mode.
 */
export function toggleHidden(filter: GraphFilter, fullName: string): GraphFilter {
  if (filter.hidden.includes(fullName)) {
    return { ...filter, hidden: filter.hidden.filter((name) => name !== fullName) };
  }
  return {
    ...filter,
    hidden: [...filter.hidden.filter((name) => !covers(fullName, name)), fullName],
    solo: filter.solo !== null && covers(fullName, filter.solo) ? null : filter.solo,
  };
}

/** Solo on `fullName`, or back to every branch when it already is. */
export function toggleSolo(filter: GraphFilter, fullName: string): GraphFilter {
  return {
    ...filter,
    solo: filter.solo === fullName ? null : fullName,
    hidden: filter.hidden.filter((name) => name !== fullName),
  };
}

/** Whether `fullName` (a ref or a folder) is left out of the graph by `filter` (solo aside). */
export function isHidden(filter: GraphFilter, fullName: string): boolean {
  return (
    filter.hidden.some((entry) => covers(entry, fullName)) ||
    (filter.hideRemotes && fullName.startsWith('refs/remotes/'))
  );
}

/**
 * The hidden folder that hides `fullName` while `fullName` itself is not in the list: showing
 * it again means showing that folder. `null` otherwise.
 */
export function hiddenByFolder(filter: GraphFilter, fullName: string): string | null {
  if (filter.hidden.includes(fullName)) return null;
  return filter.hidden.find((entry) => entry !== fullName && covers(entry, fullName)) ?? null;
}

/** Turns first-parent mode on or off (`on` omitted: toggles it). */
export function setFirstParent(repoId: number, on?: boolean): Promise<void> {
  return updateGraphFilter(repoId, (f) => ({ ...f, firstParent: on ?? !isFirstParent(f) }));
}

/**
 * Says that `sha` has no row because first-parent mode leaves it out, with the way back to the
 * full history, which then shows it. Nothing when the mode is off.
 */
export function explainOutsideFirstParent(repoId: number, sha: string): void {
  if (!isFirstParent(currentFilter(repoId))) return;
  const locale = useI18nStore.getState().locale;
  toast({
    variant: 'info',
    title: translate(locale, 'graph.firstParent.outside', { sha: shortOid(sha) }),
    description: translate(locale, 'graph.firstParent.outsideHint'),
    action: {
      label: translate(locale, 'graph.firstParent.leave'),
      onClick: () => {
        void leaveFirstParent(repoId, sha);
      },
    },
  });
}

/** Leaves first-parent mode, then shows `sha` once the full graph is loaded. */
export async function leaveFirstParent(repoId: number, sha: string | null): Promise<void> {
  await setFirstParent(repoId, false);
  if (isFirstParent(currentFilter(repoId))) return;
  await getGraphSource(repoId).refresh();
  if (sha !== null) revealCommit(repoId, sha, null);
}

export function showAll(repoId: number): Promise<void> {
  return updateGraphFilter(repoId, () => EMPTY_FILTER);
}

/** Short names for the indicator: `refs/heads/x` → `x`, `refs/heads/backup/` → `backup/`. */
export function shortName(fullName: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (fullName.startsWith(prefix)) return fullName.slice(prefix.length);
  }
  return fullName;
}
