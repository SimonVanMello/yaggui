import { create } from 'zustand';

/** One side of a comparison: what the backend resolves, and what the panel shows. */
export interface CompareSide {
  /** A full SHA or a ref name (`main`, `origin/main`). */
  rev: string;
  label: string;
}

/** Two revisions compared (F-029, F-104): commits of each side, then the global diff B → A. */
export interface CompareRequest {
  a: CompareSide;
  b: CompareSide;
}

interface CompareState {
  /** By repository: shown in the right panel in place of the commit details. */
  compare: Record<number, CompareRequest | undefined>;
}

export const useCompareStore = create<CompareState>(() => ({ compare: {} }));

export function openCompare(repoId: number, request: CompareRequest): void {
  useCompareStore.setState((state) => ({ compare: { ...state.compare, [repoId]: request } }));
}

export function closeCompare(repoId: number): void {
  useCompareStore.setState((state) => ({ compare: { ...state.compare, [repoId]: undefined } }));
}

export function swapCompare(repoId: number): void {
  const current = useCompareStore.getState().compare[repoId];
  if (current) openCompare(repoId, { a: current.b, b: current.a });
}

export function useCompare(repoId: number): CompareRequest | undefined {
  return useCompareStore((state) => state.compare[repoId]);
}

/** A closed repository forgets its comparison: reopened, it shows the commit details again. */
export function forgetCompare(repoId: number): void {
  useCompareStore.setState((state) => {
    if (!(repoId in state.compare)) return state;
    return {
      compare: Object.fromEntries(
        Object.entries(state.compare).filter(([id]) => Number(id) !== repoId),
      ),
    };
  });
}
