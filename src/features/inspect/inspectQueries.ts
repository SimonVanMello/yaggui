import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { queryClient } from '../../app/queryClient';
import { useRepoEvent } from '../../app/tabs/tabSuspension';
import {
  ipc,
  unwrap,
  type FileHistoryCursor,
  type LineHistoryCursor,
  type LineHistoryRequest,
} from '../../ipc';
import type { BlameTarget } from './inspectStore';
import { readToken } from './readToken';

export const FILE_HISTORY_PAGE = 500;
export const REFLOG_PAGE = 500;
/** The backend shortens pages of wide ranges (about 100 000 range lines per page). */
export const LINE_HISTORY_PAGE = 500;

export const inspectKeys = {
  repo: (repoId: number) => ['inspect', repoId] as const,
  history: (repoId: number, path: string, rev: string | null) =>
    ['inspect', repoId, 'history', path, rev] as const,
  lineHistory: (repoId: number, request: LineHistoryRequest) =>
    [
      'inspect',
      repoId,
      'lineHistory',
      request.path,
      request.rev,
      request.start,
      request.end,
    ] as const,
  blame: (repoId: number, target: BlameTarget) =>
    ['inspect', repoId, 'blame', target.path, target.rev] as const,
  reflog: (repoId: number, reference: string) => ['inspect', repoId, 'reflog', reference] as const,
};

/** Pages of the history of `path` (newest first), loaded on demand. */
export function useFileHistory(repoId: number, path: string, rev: string | null) {
  return useInfiniteQuery({
    queryKey: inspectKeys.history(repoId, path, rev),
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        ipc.commands.fileHistory(
          repoId,
          path,
          rev,
          pageParam,
          FILE_HISTORY_PAGE,
          readToken(signal),
        ),
      ),
    initialPageParam: null as FileHistoryCursor | null,
    getNextPageParam: (page) => page.next,
    staleTime: 30_000,
  });
}

/**
 * Pages of the history of a line range (`git log -L`), newest first. Not refreshed on working
 * tree changes: the range was mapped to HEAD when the view opened, and keeps that meaning.
 */
export function useLineHistory(repoId: number, request: LineHistoryRequest) {
  return useInfiniteQuery({
    queryKey: inspectKeys.lineHistory(repoId, request),
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        ipc.commands.lineHistory(repoId, request, pageParam, LINE_HISTORY_PAGE, readToken(signal)),
      ),
    initialPageParam: null as LineHistoryCursor | null,
    getNextPageParam: (page) => page.next,
    staleTime: 30_000,
  });
}

export function useBlame(repoId: number, target: BlameTarget) {
  return useQuery({
    queryKey: inspectKeys.blame(repoId, target),
    queryFn: ({ signal }) =>
      unwrap(ipc.commands.blame(repoId, { path: target.path, rev: target.rev }, readToken(signal))),
    // A commit's blame never changes; the working tree's follows the watcher.
    staleTime: target.rev === null ? 0 : Infinity,
    placeholderData: (previous, query) =>
      query?.queryKey[3] === target.path ? previous : undefined,
  });
}

export function useReflog(repoId: number, reference: string) {
  return useInfiniteQuery({
    queryKey: inspectKeys.reflog(repoId, reference),
    queryFn: ({ pageParam }) =>
      unwrap(ipc.commands.reflog(repoId, reference, pageParam, REFLOG_PAGE)),
    initialPageParam: 0,
    getNextPageParam: (page, pages) => {
      const loaded = pages.reduce((sum, p) => sum + p.entries.length, 0);
      return loaded < page.total && page.entries.length > 0 ? loaded : undefined;
    },
  });
}

/**
 * Targeted refresh on watcher events: the working tree blame on file changes, histories and
 * reflogs when refs move (a commit, a reset). Mount it where these views are shown.
 */
export function useInspectRefresh(repoId: number): void {
  useRepoEvent('statusChanged', repoId, () => {
    void queryClient.invalidateQueries({
      queryKey: inspectKeys.repo(repoId),
      predicate: (query) => query.queryKey[2] === 'blame' && query.queryKey[4] === null,
    });
  });
  useRepoEvent('refsChanged', repoId, () => {
    void queryClient.invalidateQueries({
      queryKey: inspectKeys.repo(repoId),
      predicate: (query) => query.queryKey[2] !== 'blame' || query.queryKey[4] === null,
    });
  });
}
