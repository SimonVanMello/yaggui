import { create } from 'zustand';

import type { CommitRef } from '../../ipc';
import type { RebaseRow } from './rebaseModel';

/** Where a rebase started from the view is halted. */
export type RebaseStop =
  | { kind: 'edit'; commit: CommitRef; step: number | null; total: number | null }
  | { kind: 'conflicts' };

export interface RebaseSession {
  /** Commit the rebase goes on top of (excluded); `null` while the user picks it. */
  base: string | null;
  /** The todo being edited, oldest first; `null` until the plan is loaded. */
  rows: RebaseRow[] | null;
  /** Set once the rebase started and halted: the view then shows the way to go on. */
  stop: RebaseStop | null;
  /**
   * Autosquash (F-147): the todo starts with the fixups under their targets. With a `null`
   * base, the backend picks it: the parent of the oldest commit a fixup targets.
   */
  autosquash: boolean;
}

interface RebaseStore {
  /** One session per repository (a repository is open in one tab at most). */
  sessions: Partial<Record<number, RebaseSession>>;
}

export const useRebaseStore = create<RebaseStore>()(() => ({ sessions: {} }));

function patch(repoId: number, change: (session: RebaseSession) => RebaseSession): void {
  useRebaseStore.setState((state) => {
    const session = state.sessions[repoId];
    return session ? { sessions: { ...state.sessions, [repoId]: change(session) } } : state;
  });
}

/**
 * Opens the interactive rebase view in place of the graph of the tab showing `repoId`
 * (F-142). `base` is excluded, as in `git rebase -i <base>`: the view lists the commits after
 * it up to HEAD. `null` shows a picker among the latest commits of the branch first. Opening
 * again with the same base keeps what was edited; another base starts over.
 */
export function openInteractiveRebase(repoId: number, base: string | null): void {
  useRebaseStore.setState((state) => {
    const current = state.sessions[repoId];
    if (current && current.base === base && !current.autosquash) return state;
    return {
      sessions: {
        ...state.sessions,
        [repoId]: { base, rows: null, stop: null, autosquash: false },
      },
    };
  });
}

/**
 * Opens the interactive rebase view with the fixups already moved under their targets
 * (F-147), for review before running it. Any edit of an open session is replaced.
 */
export function openAutosquash(repoId: number, base: string | null): void {
  useRebaseStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [repoId]: { base, rows: null, stop: null, autosquash: true },
    },
  }));
}

/** Closes the view and forgets its edits. A rebase already started keeps running in Git. */
export function closeInteractiveRebase(repoId: number): void {
  useRebaseStore.setState((state) => {
    if (!state.sessions[repoId]) return state;
    const sessions = Object.fromEntries(
      Object.entries(state.sessions).filter(([key]) => Number(key) !== repoId),
    );
    return { sessions };
  });
}

/** The open session of a repository, `undefined` while the graph is shown. */
export function useInteractiveRebase(repoId: number): RebaseSession | undefined {
  return useRebaseStore((state) => state.sessions[repoId]);
}

/** Picks the base from the picker. */
export function chooseRebaseBase(repoId: number, base: string): void {
  patch(repoId, (session) => ({ ...session, base, rows: null, stop: null, autosquash: false }));
}

export function setRebaseRows(repoId: number, rows: RebaseRow[] | null): void {
  patch(repoId, (session) => ({ ...session, rows }));
}

export function setRebaseStop(repoId: number, stop: RebaseStop | null): void {
  patch(repoId, (session) => ({ ...session, stop }));
}
