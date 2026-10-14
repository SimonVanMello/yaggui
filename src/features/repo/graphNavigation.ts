/**
 * Front-end contract between the panels that point at commits (refs sidebar, branch selector,
 * later the palette) and the commit graph (M1-2), which subscribes to it.
 *
 * - `revealCommit(repoId, sha, row, version)` selects `sha` and asks the graph to scroll to it.
 *   `row` is the graph row when the caller knows it, for the graph layout `version` (both come
 *   from `RepoRefs` / `GraphLocation`); `null` means unknown, and the graph resolves it with
 *   `graphIndexOf`. A commit outside the graph (`row` known to be absent) is still selected.
 * - `selectCommit(repoId, sha)` changes the selection without scrolling (a click in the graph).
 * - `useSelectedSha(repoId)` / `useRevealRequest(repoId)` read the state of one repository.
 *   Each reveal gets a new `seq`, so revealing the same commit twice scrolls twice: the graph
 *   reacts to a `seq` it has not handled yet.
 *
 * State is keyed by repository: a repository is open in one tab at most (F-004), so this is
 * also the per-tab state. `clear(repoId)` drops it when the tab closes. Nothing is persisted.
 */
import { create } from 'zustand';

export interface RevealRequest {
  sha: string;
  /** Row in the graph of layout `version`, or `null` when unknown. */
  row: number | null;
  /** Graph layout version `row` refers to, `null` when unknown. */
  version: number | null;
  /** Increases with every request, across repositories. */
  seq: number;
}

interface GraphNavigationState {
  /** Selected commit (full SHA) of each repository. */
  selected: Partial<Record<number, string>>;
  /** Latest reveal request of each repository. */
  reveal: Partial<Record<number, RevealRequest>>;
  revealCommit: (repoId: number, sha: string, row: number | null, version?: number | null) => void;
  selectCommit: (repoId: number, sha: string | null) => void;
  clear: (repoId: number) => void;
}

let seq = 0;

function without<T>(record: Partial<Record<number, T>>, key: number): Partial<Record<number, T>> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => Number(k) !== key));
}

export const useGraphNavigation = create<GraphNavigationState>()((set) => ({
  selected: {},
  reveal: {},
  revealCommit: (repoId, sha, row, version = null) => {
    seq += 1;
    set((state) => ({
      selected: { ...state.selected, [repoId]: sha },
      reveal: { ...state.reveal, [repoId]: { sha, row, version, seq } },
    }));
  },
  selectCommit: (repoId, sha) => {
    set((state) => ({
      selected:
        sha === null ? without(state.selected, repoId) : { ...state.selected, [repoId]: sha },
    }));
  },
  clear: (repoId) => {
    set((state) => ({
      selected: without(state.selected, repoId),
      reveal: without(state.reveal, repoId),
    }));
  },
}));

export function useSelectedSha(repoId: number): string | null {
  return useGraphNavigation((state) => state.selected[repoId] ?? null);
}

export function useRevealRequest(repoId: number): RevealRequest | null {
  return useGraphNavigation((state) => state.reveal[repoId] ?? null);
}

/** Non-React access, for event handlers and the palette. */
export function revealCommit(
  repoId: number,
  sha: string,
  row: number | null,
  version: number | null = null,
): void {
  useGraphNavigation.getState().revealCommit(repoId, sha, row, version);
}
