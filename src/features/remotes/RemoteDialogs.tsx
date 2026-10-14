import { RemoteDialog } from './RemoteDialog';
import { useRemoteDialogs } from './remoteDialogsStore';
import { RemotesDialog } from './RemotesDialog';

/** Renders the open remote dialog. Mount once at the app root. */
export function RemoteDialogs() {
  const dialog = useRemoteDialogs((state) => state.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'manage':
      return <RemotesDialog key={`manage:${String(dialog.repoId)}`} {...dialog} />;
    case 'edit':
      return (
        <RemoteDialog
          key={`edit:${String(dialog.repoId)}:${dialog.remote?.name ?? ''}`}
          {...dialog}
        />
      );
  }
}
