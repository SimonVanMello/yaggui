/**
 * The file history, blame or reflog shown in place of the graph (M4-4, F-220 to F-222).
 *
 * Keyed by repository, like `graphNavigation`: a repository is open in one tab at most
 * (F-004), so entry points that only know the repository (sidebar, palette) can open a view.
 * A diff or a conflict opened meanwhile shows over it; `Esc` closes it.
 */
import { create } from 'zustand';

import { useTabsStore } from '../../app/tabs/tabsStore';
import { closeConflictView } from '../conflicts/conflictViewStore';
import { closeDiff } from '../diff/diffStore';
import { useRepoSessions } from '../repo/repoSessions';

/** A version of a file to blame: `rev` null is the working tree. */
export interface BlameTarget {
  path: string;
  rev: string | null;
  /** Line (0-based) to bring into view once loaded. */
  line?: number;
}

export type InspectView =
  | {
      kind: 'fileHistory';
      path: string;
      /** Commit the history starts from; `null`: HEAD. */
      rev: string | null;
    }
  | {
      kind: 'blame';
      target: BlameTarget;
      /** Versions blamed before ("blame of the parent"), most recent last, for going back. */
      trail: BlameTarget[];
    }
  | {
      kind: 'reflog';
      /** `HEAD` or `refs/heads/<branch>`. */
      reference: string;
    };

interface InspectState {
  views: Partial<Record<number, InspectView>>;
}

export const useInspectStore = create<InspectState>(() => ({ views: {} }));

export function useInspectView(repoId: number): InspectView | undefined {
  return useInspectStore((state) => state.views[repoId]);
}

export function inspectViewOf(repoId: number): InspectView | undefined {
  return useInspectStore.getState().views[repoId];
}

function show(repoId: number, view: InspectView): void {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.repoId === repoId);
  if (tab) {
    closeDiff(tab.id);
    closeConflictView(tab.id);
  }
  useInspectStore.setState((state) => ({ views: { ...state.views, [repoId]: view } }));
}

export function openFileHistory(repoId: number, path: string, rev: string | null = null): void {
  show(repoId, { kind: 'fileHistory', path, rev });
}

export function openBlame(repoId: number, path: string, rev: string | null = null): void {
  show(repoId, { kind: 'blame', target: { path, rev }, trail: [] });
}

/** Blames another version from the open blame, remembering the current one for "Back". */
export function blameAnother(repoId: number, target: BlameTarget): void {
  const view = inspectViewOf(repoId);
  const trail = view?.kind === 'blame' ? [...view.trail, view.target] : [];
  useInspectStore.setState((state) => ({
    views: { ...state.views, [repoId]: { kind: 'blame', target, trail } },
  }));
}

/** Back to the version blamed before; `false` when there is none. */
export function blameBack(repoId: number): boolean {
  const view = inspectViewOf(repoId);
  if (view?.kind !== 'blame') return false;
  const previous = view.trail[view.trail.length - 1];
  if (!previous) return false;
  useInspectStore.setState((state) => ({
    views: {
      ...state.views,
      [repoId]: { kind: 'blame', target: previous, trail: view.trail.slice(0, -1) },
    },
  }));
  return true;
}

export function openReflog(repoId: number, reference = 'HEAD'): void {
  show(repoId, { kind: 'reflog', reference });
}

export function closeInspect(repoId: number): void {
  useInspectStore.setState((state) => ({ views: { ...state.views, [repoId]: undefined } }));
}

// A closed repository forgets its view, like its graph state.
useRepoSessions.subscribe((state) => {
  const { views } = useInspectStore.getState();
  const closed = Object.keys(views)
    .map(Number)
    .filter((repoId) => {
      const status = state.sessions[repoId]?.status;
      return views[repoId] !== undefined && status !== 'open' && status !== 'opening';
    });
  if (closed.length === 0) return;
  useInspectStore.setState({
    views: Object.fromEntries(
      Object.entries(views).filter(([repoId]) => !closed.includes(Number(repoId))),
    ),
  });
});
