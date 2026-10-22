import { useQuery } from '@tanstack/react-query';

import { queryClient, queryKeys } from '../../app/queryClient';
import { ipc, unwrap } from '../../ipc';
import { diffKeys } from '../diff/diffQueries';
import { invalidateGraph } from '../graph/graphSource';
import { forgetAutosquash } from './fixupOps';
import { closeInteractiveRebase } from './rebaseStore';

const planKey = (repoId: number) => ['rebase-plan', repoId] as const;

/** The commits `base..HEAD` an interactive rebase would rewrite (read only). */
export function useRebasePlan(repoId: number, base: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...planKey(repoId), base] as const,
    queryFn: () => unwrap(ipc.commands.interactiveRebasePlan(repoId, base ?? '')),
    enabled: enabled && base !== null,
    staleTime: Infinity,
  });
}

/** Files still in conflict and what Git offers for the operation in progress. */
export function useOperationDetail(repoId: number, version: number) {
  return useQuery({
    // The state of the repository changes with the watcher: read the detail again with it.
    queryKey: ['rebase-operation-detail', repoId, version] as const,
    queryFn: () => unwrap(ipc.commands.operationDetail(repoId)),
    placeholderData: (previous) => previous,
  });
}

/** History, lists and the worktree views change with a rebase; the watcher is slower. */
export function refreshAfterRebase(repoId: number): void {
  invalidateGraph(repoId);
  void queryClient.invalidateQueries({ queryKey: queryKeys.repoRefs(repoId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.repoState(repoId) });
  void queryClient.invalidateQueries({ queryKey: diffKeys.worktree(repoId) });
}

/** Leaves the view: forgets the edits and the plan, which is stale from now on. */
export function leaveRebase(repoId: number): void {
  closeInteractiveRebase(repoId);
  queryClient.removeQueries({ queryKey: planKey(repoId) });
  forgetAutosquash(repoId);
}

export interface BaseCandidate {
  sha: string;
  summary: string;
  authorName: string;
  authorTime: number | null;
  /** Commits above it, up to HEAD: what the rebase would rewrite. */
  above: number;
}

export const BASE_CANDIDATES = 30;

/** The latest commits of the current branch, first parent only: one page of the graph. */
export async function loadBaseCandidates(repoId: number): Promise<BaseCandidate[]> {
  const [state, page] = await Promise.all([
    unwrap(ipc.commands.repoState(repoId)),
    unwrap(ipc.commands.graphPage(repoId, 0, 500)),
  ]);
  if (state.head.kind === 'unborn') return [];
  const rows = new Map(page.shas.map((sha, row) => [sha, row]));
  const candidates: BaseCandidate[] = [];
  let row = rows.get(state.head.oid);
  while (row !== undefined && candidates.length < BASE_CANDIDATES) {
    const sha: string | undefined = page.parents[row]?.[0];
    const next = sha === undefined ? undefined : rows.get(sha);
    if (sha === undefined || next === undefined) break;
    row = next;
    candidates.push({
      sha,
      summary: page.summaries[next] ?? '',
      authorName: page.authorNames[next] ?? '',
      authorTime: page.authorTimes[next] ?? null,
      above: candidates.length + 1,
    });
  }
  return candidates;
}

export function useBaseCandidates(repoId: number) {
  return useQuery({
    queryKey: ['rebase-base-candidates', repoId] as const,
    queryFn: () => loadBaseCandidates(repoId),
    staleTime: 0,
  });
}
