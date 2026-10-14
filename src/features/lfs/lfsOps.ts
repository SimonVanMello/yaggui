import { create } from 'zustand';

import { showYagguiError } from '../../app/errors/presentError';
import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type YagguiError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { runModuleOp, tr } from '../submodules/moduleOps';
import { lfsKeys } from './lfsQueries';

/** Not installed is not an error to dismiss: an explanation, like the one shown on open. */
function explainMissing(error: YagguiError | null): void {
  if (error?.code !== 'lfsNotInstalled') return;
  toast({
    variant: 'warning',
    title: tr('lfs.notInstalled.title'),
    description: tr('lfs.notInstalled.text'),
  });
}

/** `git lfs pull` (F-262): downloads the content of the pointers of the checkout. */
export async function lfsPull(repoId: number): Promise<void> {
  const result = await runModuleOp(repoId, () => unwrap(ipc.commands.lfsPull(repoId)), {
    success: 'lfs.pulled',
    report: false,
  });
  if (!result.ok) reportLfsError(result.error);
}

/** `git lfs track <pattern>`; `.gitattributes` changes (left for the user to commit). */
export async function lfsTrack(
  repoId: number,
  pattern: string,
): Promise<{ ok: boolean; error: YagguiError | null }> {
  const result = await runModuleOp(repoId, () => unwrap(ipc.commands.lfsTrack(repoId, pattern)), {
    report: false,
  });
  void queryClient.invalidateQueries({ queryKey: lfsKeys.status(repoId) });
  if (result.ok)
    toast({ variant: 'success', title: tr('lfs.tracked', { pattern: pattern.trim() }) });
  return result.ok ? { ok: true, error: null } : { ok: false, error: result.error };
}

function reportLfsError(error: YagguiError | null): void {
  if (error?.code === 'lfsNotInstalled') explainMissing(error);
  else if (error && error.code !== 'cancelled') showYagguiError(error);
}

export { explainMissing as explainLfsMissing };

interface LfsTrackStore {
  repoId: number | null;
  open: (repoId: number) => void;
  close: () => void;
}

export const useLfsTrackDialog = create<LfsTrackStore>()((set) => ({
  repoId: null,
  open: (repoId) => {
    set({ repoId });
  },
  close: () => {
    set({ repoId: null });
  },
}));
