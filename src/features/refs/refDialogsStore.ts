import { create } from 'zustand';

import type { BranchStart, CheckoutTarget, StashId } from '../../ipc';

/** Dialogs of the branch, stash and tag actions; one at a time, rendered by `RefDialogs`. */
export type RefDialog =
  | {
      kind: 'createBranch';
      repoId: number;
      from: BranchStart;
      /** Where the branch starts, for humans (`main`, `3f9c2a1`, `stash@{0}`). */
      fromLabel: string;
    }
  | { kind: 'renameBranch'; repoId: number; name: string }
  | {
      kind: 'deleteBranch';
      repoId: number;
      name: string;
      /** Upstream (`origin/feat`), when the branch has one that still exists. */
      upstream: string | null;
    }
  | { kind: 'upstream'; repoId: number; branch: string; current: string | null }
  | { kind: 'createTag'; repoId: number; target: string; targetLabel: string }
  /** Checkout of a tag (F-202): detached HEAD explained, a branch offered. */
  | { kind: 'tagCheckout'; repoId: number; name: string; fullName: string }
  | {
      kind: 'dirtyCheckout';
      repoId: number;
      target: CheckoutTarget;
      label: string;
      paths: string[];
      canCarry: boolean;
    }
  | { kind: 'stashConflict'; repoId: number; paths: string[]; checkedOut: boolean }
  | { kind: 'stashRename'; repoId: number; stash: StashId; message: string };

interface RefDialogsStore {
  dialog: RefDialog | null;
  open: (dialog: RefDialog) => void;
  close: () => void;
}

export const useRefDialogs = create<RefDialogsStore>()((set) => ({
  dialog: null,
  open: (dialog) => {
    set({ dialog });
  },
  close: () => {
    set({ dialog: null });
  },
}));

export function openRefDialog(dialog: RefDialog): void {
  useRefDialogs.getState().open(dialog);
}
