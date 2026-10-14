import { create } from 'zustand';

import type { StashRef } from '../../ipc';

/** The stash whose diff the details panel shows (F-183), per repository. */
interface StashPreviewStore {
  preview: Partial<Record<number, StashRef>>;
  show: (repoId: number, stash: StashRef) => void;
  clear: (repoId: number) => void;
}

export const useStashPreview = create<StashPreviewStore>()((set) => ({
  preview: {},
  show: (repoId, stash) => {
    set((state) => ({ preview: { ...state.preview, [repoId]: stash } }));
  },
  clear: (repoId) => {
    set((state) => {
      if (!(repoId in state.preview)) return state;
      return {
        preview: Object.fromEntries(
          Object.entries(state.preview).filter(([id]) => Number(id) !== repoId),
        ),
      };
    });
  },
}));
