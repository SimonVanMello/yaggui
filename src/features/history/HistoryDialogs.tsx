import { ContinueDialog } from './ContinueDialog';
import { useHistoryDialogs } from './historyDialogsStore';
import { MergeDialog } from './MergeDialog';
import { ParentDialog } from './ParentDialog';
import { RebaseDialog } from './RebaseDialog';
import { ResetDialog } from './ResetDialog';
import { RewordDialog } from './RewordDialog';

/** Renders the open merge / rebase / reset / revert / reword dialog. Mount once at the app root. */
export function HistoryDialogs() {
  const dialog = useHistoryDialogs((state) => state.dialog);
  if (!dialog) return null;
  // The key remounts the dialog (fresh form state) when another one replaces it.
  const key = `${dialog.kind}:${String(dialog.repoId)}`;
  switch (dialog.kind) {
    case 'merge':
      return <MergeDialog key={key} {...dialog} />;
    case 'rebase':
      return <RebaseDialog key={key} {...dialog} />;
    case 'reset':
      return <ResetDialog key={key} {...dialog} />;
    case 'parent':
      return <ParentDialog key={key} {...dialog} />;
    case 'reword':
      return <RewordDialog key={key} {...dialog} />;
    case 'continue':
      return <ContinueDialog key={key} {...dialog} />;
  }
}
