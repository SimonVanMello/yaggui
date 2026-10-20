import { create } from 'zustand';

import type { ResetMode } from '../../ipc';

/** Dialogs of the history operations (M3-2); one at a time, rendered by `HistoryDialogs`. */
export type HistoryDialog =
  | {
      kind: 'merge';
      repoId: number;
      /** `null`: the dialog asks for the branch to merge (palette, keyboard). */
      source: string | null;
      /** Branch that receives the merge; `null`: the checked-out one. */
      target: string | null;
      /** The mode proposed first (a "Fast-forward" gesture asks for `fastForwardOnly`). */
      mode?: 'fastForwardOnly';
    }
  | {
      kind: 'rebase';
      repoId: number;
      /** Branch to rebase; `null`: the checked-out one. */
      branch: string | null;
      /** `null`: the dialog asks for it. */
      onto: string | null;
    }
  | {
      kind: 'reset';
      repoId: number;
      target: string;
      label: string;
      mode?: ResetMode;
    }
  | {
      /** Which parent a merge commit is compared with, for a revert or a cherry-pick (`-m`). */
      kind: 'parent';
      repoId: number;
      op: 'revert' | 'cherryPick';
      /** Commits to apply (one for a revert), oldest first. */
      shas: string[];
      /** Branch the cherry-pick lands on, when it is not the checked-out one. */
      target: string | null;
    }
  | {
      /** New message for a commit of the current branch. */
      kind: 'reword';
      repoId: number;
      sha: string;
      /** The commit is HEAD: amended instead of rebased. */
      head: boolean;
    }
  | { kind: 'continue'; repoId: number };

interface HistoryDialogsStore {
  dialog: HistoryDialog | null;
  open: (dialog: HistoryDialog) => void;
  close: () => void;
}

export const useHistoryDialogs = create<HistoryDialogsStore>()((set) => ({
  dialog: null,
  open: (dialog) => {
    set({ dialog });
  },
  close: () => {
    set({ dialog: null });
  },
}));

export function openHistoryDialog(dialog: HistoryDialog): void {
  useHistoryDialogs.getState().open(dialog);
}
