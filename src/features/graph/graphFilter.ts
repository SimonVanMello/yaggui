import { useQuery } from '@tanstack/react-query';

import { showYagguiError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { translate, useI18nStore } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type GraphFilter } from '../../ipc';
import { useRepoSessions } from '../repo/repoSessions';
import { invalidateGraph } from './graphSource';

/** Refs hidden from the graph or soloed (F-028), persisted per repository by the backend. */

export const EMPTY_FILTER: GraphFilter = {
  hidden: [],
  solo: null,
  hideRemotes: false,
  hideStashes: false,
};

export const graphFilterKey = (repoId: number) => ['graph-filter', repoId] as const;

export function isFilterActive(filter: GraphFilter | undefined): boolean {
  return (
    filter !== undefined &&
    (filter.hidden.length > 0 || filter.solo !== null || filter.hideRemotes || filter.hideStashes)
  );
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

function currentFilter(repoId: number): GraphFilter {
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

/** Hides `fullName`, or shows it again. Hiding the soloed ref leaves solo mode. */
export function toggleHidden(filter: GraphFilter, fullName: string): GraphFilter {
  const hidden = filter.hidden.includes(fullName)
    ? filter.hidden.filter((name) => name !== fullName)
    : [...filter.hidden, fullName];
  return { ...filter, hidden, solo: filter.solo === fullName ? null : filter.solo };
}

/** Solo on `fullName`, or back to every branch when it already is. */
export function toggleSolo(filter: GraphFilter, fullName: string): GraphFilter {
  return {
    ...filter,
    solo: filter.solo === fullName ? null : fullName,
    hidden: filter.hidden.filter((name) => name !== fullName),
  };
}

/** Whether `fullName` is left out of the graph by `filter` (solo aside). */
export function isHidden(filter: GraphFilter, fullName: string): boolean {
  return (
    filter.hidden.includes(fullName) || (filter.hideRemotes && fullName.startsWith('refs/remotes/'))
  );
}

export function showAll(repoId: number): Promise<void> {
  return updateGraphFilter(repoId, () => EMPTY_FILTER);
}

/** Short names for the indicator: `refs/heads/x` → `x`. */
export function shortName(fullName: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (fullName.startsWith(prefix)) return fullName.slice(prefix.length);
  }
  return fullName;
}
