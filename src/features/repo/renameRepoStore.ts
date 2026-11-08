import { create } from 'zustand';

interface RenameRepoStore {
  /** Repository whose "Rename…" dialog is open. */
  repoId: number | null;
  open: (repoId: number) => void;
  close: () => void;
}

export const useRenameRepo = create<RenameRepoStore>()((set) => ({
  repoId: null,
  open: (repoId) => {
    set({ repoId });
  },
  close: () => {
    set({ repoId: null });
  },
}));
