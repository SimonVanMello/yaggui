import { create } from 'zustand';

/** Dialogs of the commit panel (M4-7a); one at a time, rendered by `CommitToolsDialogs`. */
export type CommitToolsDialog =
  /** `repoId`: the repository whose draft can be saved as a template. */
  | { kind: 'templates'; repoId: number | null }
  | { kind: 'profiles'; repoId: number | null }
  | { kind: 'gitignore'; repoId: number; path: string }
  | { kind: 'stashFiles'; repoId: number; files: StashFile[] };

export interface StashFile {
  path: string;
  untracked: boolean;
}

interface CommitToolsStore {
  dialog: CommitToolsDialog | null;
  /** The Conventional Commits fields are shown above the summary. */
  conventional: boolean;
  open: (dialog: CommitToolsDialog) => void;
  close: () => void;
  setConventional: (on: boolean) => void;
}

export const useCommitTools = create<CommitToolsStore>()((set) => ({
  dialog: null,
  conventional: false,
  open: (dialog) => {
    set({ dialog });
  },
  close: () => {
    set({ dialog: null });
  },
  setConventional: (conventional) => {
    set({ conventional });
  },
}));

export function openCommitToolsDialog(dialog: CommitToolsDialog): void {
  useCommitTools.getState().open(dialog);
}
