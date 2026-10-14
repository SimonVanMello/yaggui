import { create } from 'zustand';

/** Dialogs of the branch tools (M4-7b), one at a time, rendered by `BranchToolsDialogs`. */
export type BranchToolsDialog =
  | { kind: 'cleanup'; repoId: number }
  | { kind: 'compareBranches'; repoId: number; a: string | null };

export const useBranchTools = create<{ dialog: BranchToolsDialog | null }>(() => ({
  dialog: null,
}));

export function openBranchTools(dialog: BranchToolsDialog): void {
  useBranchTools.setState({ dialog });
}

export function closeBranchTools(): void {
  useBranchTools.setState({ dialog: null });
}
