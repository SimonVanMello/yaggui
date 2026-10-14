import { useCommitTools } from './commitToolsStore';
import { GitignoreDialog } from './GitignoreDialog';
import { ProfilesDialog } from './ProfilesDialog';
import { StashFilesDialog } from './StashFilesDialog';
import { TemplatesDialog } from './TemplatesDialog';

/** Renders the open dialog of the commit panel tools, if any (M4-7a). */
export function CommitToolsDialogs() {
  const dialog = useCommitTools((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'templates':
      return <TemplatesDialog repoId={dialog.repoId} />;
    case 'profiles':
      return <ProfilesDialog repoId={dialog.repoId} />;
    case 'gitignore':
      return (
        <GitignoreDialog
          key={`${String(dialog.repoId)}:${dialog.path}`}
          repoId={dialog.repoId}
          path={dialog.path}
        />
      );
    case 'stashFiles':
      return <StashFilesDialog repoId={dialog.repoId} files={dialog.files} />;
  }
}
