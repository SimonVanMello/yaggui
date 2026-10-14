import { create } from 'zustand';

export type WorktreeDialog =
  /** `branch`: an existing branch to check out there, preselected. */
  | { kind: 'create'; repoId: number; branch: string | null }
  | { kind: 'remove'; repoId: number; path: string };

interface WorktreeDialogStore {
  dialog: WorktreeDialog | null;
  open: (dialog: WorktreeDialog) => void;
  close: () => void;
}

export const useWorktreeDialogs = create<WorktreeDialogStore>()((set) => ({
  dialog: null,
  open: (dialog) => {
    set({ dialog });
  },
  close: () => {
    set({ dialog: null });
  },
}));

export function openWorktreeDialog(dialog: WorktreeDialog): void {
  useWorktreeDialogs.getState().open(dialog);
}
