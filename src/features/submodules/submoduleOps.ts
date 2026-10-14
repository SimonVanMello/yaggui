import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type SubmoduleStatus, type SubmoduleUpdateRequest } from '../../ipc';
import { openRepoPath } from '../repo/repoSessions';
import { runModuleOp } from './moduleOps';
import { submoduleKeys } from './submoduleQueries';

/** `git submodule update` (F-260): queued, with progress and cancellation in the status bar. */
export async function updateSubmodules(
  repoId: number,
  request: SubmoduleUpdateRequest,
): Promise<boolean> {
  const result = await runModuleOp(
    repoId,
    () => unwrap(ipc.commands.updateSubmodules(repoId, request)),
    { success: 'submodule.updated' },
  );
  void queryClient.invalidateQueries({ queryKey: submoduleKeys.status(repoId) });
  return result.ok;
}

/** Opens an initialized submodule as a repository of its own, in a new tab. */
export function openSubmodule(status: SubmoduleStatus): Promise<boolean> {
  return openRepoPath(status.absolutePath);
}
