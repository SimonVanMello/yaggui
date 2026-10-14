import { CreateBranchDialog } from './CreateBranchDialog';
import { CreateTagDialog } from './CreateTagDialog';
import { DeleteBranchDialog } from './DeleteBranchDialog';
import { DirtyCheckoutDialog } from './DirtyCheckoutDialog';
import { useRefDialogs } from './refDialogsStore';
import { RenameBranchDialog } from './RenameBranchDialog';
import { StashConflictDialog } from './StashConflictDialog';
import { StashRenameDialog } from './StashRenameDialog';
import { TagCheckoutDialog } from './TagCheckoutDialog';
import { UpstreamDialog } from './UpstreamDialog';

/** Renders the open branch / stash / tag dialog. Mount once at the app root. */
export function RefDialogs() {
  const dialog = useRefDialogs((state) => state.dialog);
  if (!dialog) return null;
  // The key remounts the dialog (fresh form state) when another one replaces it.
  const key = `${dialog.kind}:${String(dialog.repoId)}`;
  switch (dialog.kind) {
    case 'createBranch':
      return <CreateBranchDialog key={key} {...dialog} />;
    case 'renameBranch':
      return <RenameBranchDialog key={key} {...dialog} />;
    case 'deleteBranch':
      return <DeleteBranchDialog key={key} {...dialog} />;
    case 'upstream':
      return <UpstreamDialog key={key} {...dialog} />;
    case 'createTag':
      return <CreateTagDialog key={key} {...dialog} />;
    case 'dirtyCheckout':
      return <DirtyCheckoutDialog key={key} {...dialog} />;
    case 'stashConflict':
      return <StashConflictDialog key={key} {...dialog} />;
    case 'stashRename':
      return <StashRenameDialog key={key} {...dialog} />;
    case 'tagCheckout':
      return <TagCheckoutDialog key={key} {...dialog} />;
  }
}
