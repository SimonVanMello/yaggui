import { create } from 'zustand';

import type { YagguiError } from '../../ipc';

/** Height of the terminal panel, in px; the CSS caps it at `--terminal-max-height`. */
export const TERMINAL_HEIGHT = { min: 120, default: 260 };

export type TerminalStatus = 'starting' | 'running' | 'exited' | 'failed';

/** One terminal of the panel (F-267); the emulator itself lives in `terminalSessions`. */
export interface TerminalTab {
  id: string;
  /** Shell name once started (`zsh`, `pwsh`…). */
  title: string;
  status: TerminalStatus;
  exitCode: number | null;
  error: YagguiError | null;
}

export interface RepoTerminals {
  open: boolean;
  tabs: TerminalTab[];
  activeId: string | null;
}

interface TerminalStore {
  height: number;
  /** Panel state of each repository; kept while its tab is in the background. */
  repos: Record<number, RepoTerminals | undefined>;
  setHeight: (height: number) => void;
  setOpen: (repoId: number, open: boolean) => void;
  /** Adds a terminal, makes it the active one and opens the panel. */
  addTab: (repoId: number, tab: Pick<TerminalTab, 'id' | 'title'>) => void;
  updateTab: (repoId: number, id: string, patch: Partial<Omit<TerminalTab, 'id'>>) => void;
  /** Removes a terminal; the panel closes with its last one. */
  removeTab: (repoId: number, id: string) => void;
  activate: (repoId: number, id: string) => void;
  forgetRepo: (repoId: number) => void;
}

const EMPTY: RepoTerminals = { open: false, tabs: [], activeId: null };

export function clampTerminalHeight(height: number): number {
  return Math.round(Math.max(TERMINAL_HEIGHT.min, height));
}

export const useTerminalStore = create<TerminalStore>()((set) => {
  const patchRepo = (repoId: number, patch: (repo: RepoTerminals) => RepoTerminals) => {
    set((state) => ({ repos: { ...state.repos, [repoId]: patch(state.repos[repoId] ?? EMPTY) } }));
  };
  return {
    height: TERMINAL_HEIGHT.default,
    repos: {},
    setHeight: (height) => {
      set({ height: clampTerminalHeight(height) });
    },
    setOpen: (repoId, open) => {
      patchRepo(repoId, (repo) => ({ ...repo, open }));
    },
    addTab: (repoId, { id, title }) => {
      patchRepo(repoId, (repo) => ({
        open: true,
        tabs: [...repo.tabs, { id, title, status: 'starting', exitCode: null, error: null }],
        activeId: id,
      }));
    },
    updateTab: (repoId, id, patch) => {
      patchRepo(repoId, (repo) => ({
        ...repo,
        tabs: repo.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
      }));
    },
    removeTab: (repoId, id) => {
      patchRepo(repoId, (repo) => {
        const index = repo.tabs.findIndex((tab) => tab.id === id);
        if (index < 0) return repo;
        const tabs = repo.tabs.filter((tab) => tab.id !== id);
        // The neighbor on the right takes the place, else the one on the left.
        const next = tabs[Math.min(index, tabs.length - 1)];
        const activeId = repo.activeId === id ? (next?.id ?? null) : repo.activeId;
        return { open: repo.open && tabs.length > 0, tabs, activeId };
      });
    },
    activate: (repoId, id) => {
      patchRepo(repoId, (repo) =>
        repo.tabs.some((tab) => tab.id === id) ? { ...repo, activeId: id } : repo,
      );
    },
    forgetRepo: (repoId) => {
      set((state) => ({
        repos: Object.fromEntries(
          Object.entries(state.repos).filter(([id]) => Number(id) !== repoId),
        ),
      }));
    },
  };
});

export function repoTerminals(repoId: number): RepoTerminals {
  return useTerminalStore.getState().repos[repoId] ?? EMPTY;
}

/** Panel state of a repository, re-rendering when it changes. */
export function useRepoTerminals(repoId: number): RepoTerminals {
  return useTerminalStore((state) => state.repos[repoId] ?? EMPTY);
}

export function hideTerminalPanel(repoId: number): void {
  useTerminalStore.getState().setOpen(repoId, false);
}
