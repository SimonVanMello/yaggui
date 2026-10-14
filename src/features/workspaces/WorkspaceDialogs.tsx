import { useEffect } from 'react';

import { MissingRepoDialog } from './MissingRepoDialog';
import { ScanDialog } from './ScanDialog';
import { registerWorkspaceActions } from './workspaceActions';
import { WorkspacesDialog } from './WorkspacesDialog';

/** Workspace dialogs and palette actions, mounted once by the shell. */
export function WorkspaceDialogs() {
  useEffect(registerWorkspaceActions, []);
  return (
    <>
      <WorkspacesDialog />
      <ScanDialog />
      <MissingRepoDialog />
    </>
  );
}
