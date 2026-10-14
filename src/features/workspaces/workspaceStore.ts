import { create } from 'zustand';

import type { YagguiError } from '../../ipc';

/** Result of the last workspace fetch of a repo ("Fetch all", F-008). */
export type RepoFetchStatus =
  { status: 'running' } | { status: 'done' } | { status: 'failed'; error: YagguiError };

interface WorkspaceUiStore {
  /** Workspaces dialog, open on a workspace (`null`: the first one, or none yet). */
  manager: { workspaceId: number | null } | null;
  /** Folder scan dialog; imports into `workspaceId` by default. */
  scan: { workspaceId: number | null } | null;
  /** Relocate-or-remove dialog of a moved or deleted repo (F-009). */
  missing: { repoId: number; workspaceId: number | null } | null;
  fetches: Record<number, RepoFetchStatus | undefined>;
  openManager: (workspaceId?: number | null) => void;
  closeManager: () => void;
  selectWorkspace: (workspaceId: number | null) => void;
  openScan: (workspaceId?: number | null) => void;
  closeScan: () => void;
  showMissing: (repoId: number, workspaceId?: number | null) => void;
  closeMissing: () => void;
  setFetch: (repoId: number, status: RepoFetchStatus | undefined) => void;
}

export const useWorkspaceUi = create<WorkspaceUiStore>()((set) => ({
  manager: null,
  scan: null,
  missing: null,
  fetches: {},
  openManager: (workspaceId = null) => {
    set({ manager: { workspaceId } });
  },
  closeManager: () => {
    set({ manager: null });
  },
  selectWorkspace: (workspaceId) => {
    set((state) => (state.manager ? { manager: { workspaceId } } : {}));
  },
  openScan: (workspaceId = null) => {
    set({ scan: { workspaceId } });
  },
  closeScan: () => {
    set({ scan: null });
  },
  showMissing: (repoId, workspaceId = null) => {
    set({ missing: { repoId, workspaceId } });
  },
  closeMissing: () => {
    set({ missing: null });
  },
  setFetch: (repoId, status) => {
    set((state) => ({ fetches: { ...state.fetches, [repoId]: status } }));
  },
}));
