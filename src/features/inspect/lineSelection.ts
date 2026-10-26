import { useEffect, useState } from 'react';
import { create } from 'zustand';

/** A range of lines of a file version, 1-based and inclusive, as `openLineHistory` takes it. */
export interface LineRange {
  path: string;
  /** Version the line numbers refer to; `null`: the working tree. */
  rev: string | null;
  start: number;
  end: number;
}

interface Published extends LineRange {
  /** The view that published it: only it clears it. */
  owner: symbol;
}

interface LineSelectionState {
  byRepo: Partial<Record<number, Published>>;
}

/**
 * The line range selected in a blame or a commit diff of each repository, for the palette's
 * "History of the selected lines" (F-223). The last view to select lines wins.
 */
const useLineSelectionStore = create<LineSelectionState>(() => ({ byRepo: {} }));

/** The selected line range of `repoId`, if a view has one. */
export function selectedLines(repoId: number): LineRange | null {
  const published = useLineSelectionStore.getState().byRepo[repoId];
  if (!published) return null;
  const { path, rev, start, end } = published;
  return { path, rev, start, end };
}

function clear(repoId: number, owner: symbol): void {
  useLineSelectionStore.setState((state) => {
    if (state.byRepo[repoId]?.owner !== owner) return state;
    return { byRepo: { ...state.byRepo, [repoId]: undefined } };
  });
}

/** Publishes the range a view has selected (`null`: none) while it is mounted. */
export function usePublishedLines(repoId: number, range: LineRange | null): void {
  const [owner] = useState(() => Symbol('lines'));
  const path = range?.path;
  const rev = range?.rev ?? null;
  const start = range?.start;
  const end = range?.end;
  useEffect(() => {
    if (path === undefined || start === undefined || end === undefined) {
      clear(repoId, owner);
      return;
    }
    useLineSelectionStore.setState((state) => ({
      byRepo: { ...state.byRepo, [repoId]: { owner, path, rev, start, end } },
    }));
    return () => {
      clear(repoId, owner);
    };
  }, [repoId, owner, path, rev, start, end]);
}
