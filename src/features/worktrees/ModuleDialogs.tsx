import { useEffect } from 'react';

import { LfsTrackDialog } from '../lfs/LfsTrackDialog';
import { useLfsTrackDialog } from '../lfs/lfsOps';
import { useLfsNotice } from '../lfs/useLfsNotice';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useSubmoduleRefresh } from '../submodules/submoduleQueries';
import { CreateWorktreeDialog } from './CreateWorktreeDialog';
import { registerModuleActions } from './moduleActions';
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog';
import { useWorktreeDialogs } from './worktreeStore';

/** Submodule, worktree and LFS dialogs, palette actions and refreshes, mounted once by the shell. */
export function ModuleDialogs() {
  useEffect(registerModuleActions, []);
  useSubmoduleRefresh();
  useLfsNotice(useTabsStore((state) => selectActiveTab(state).repoId));
  const dialog = useWorktreeDialogs((state) => state.dialog);
  const lfsRepo = useLfsTrackDialog((state) => state.repoId);
  return (
    <>
      {dialog?.kind === 'create' && (
        <CreateWorktreeDialog
          key={`${String(dialog.repoId)}:${dialog.branch ?? ''}`}
          repoId={dialog.repoId}
          branch={dialog.branch}
        />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveWorktreeDialog key={dialog.path} repoId={dialog.repoId} path={dialog.path} />
      )}
      {lfsRepo !== null && <LfsTrackDialog repoId={lfsRepo} />}
    </>
  );
}
