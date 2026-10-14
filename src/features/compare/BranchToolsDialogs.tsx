import { useBranchTools } from './branchToolsStore';
import { CleanupDialog } from './CleanupDialog';
import { CompareBranchesDialog } from './CompareBranchesDialog';

/** The open branch tools dialog (cleanup, comparison), if any. */
export function BranchToolsDialogs() {
  const dialog = useBranchTools((state) => state.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'cleanup':
      return <CleanupDialog key={dialog.repoId} repoId={dialog.repoId} />;
    case 'compareBranches':
      return <CompareBranchesDialog repoId={dialog.repoId} a={dialog.a} />;
  }
}
