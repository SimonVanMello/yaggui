import { useQuery } from '@tanstack/react-query';

import { localize, showError } from '../../app/errors/presentError';
import { queryClient, queryKeys } from '../../app/queryClient';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YagguiIpcError, ipc, unwrap, type RepoState } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { shortSha } from '../diff/format';
import { invalidateGraph } from '../graph/graphSource';
import { useCommitUi } from '../staging/commitUi';
import { refreshWorktree, reportWriteError } from '../staging/stagingActions';
import { openAutosquash } from './rebaseStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

export const autosquashKey = (repoId: number, base: string | null) =>
  ['rebase-autosquash', repoId, base] as const;

/** Why a fixup cannot be created now, from the cached state; `null` when it can. */
export function fixupBlock(state: RepoState | undefined): MessageKey | null {
  if (!state || state.head.kind === 'unborn') return 'fixup.disabled.noCommit';
  if (state.operation) return 'palette.disabled.operationRunning';
  if (state.dirty.staged === 0) return 'fixup.disabled.nothingStaged';
  return null;
}

/**
 * Commits the staged changes as `fixup! <summary>` of `sha` (F-147). A hook rejection shows
 * its output in the commit box, like a commit.
 */
export async function createFixup(repoId: number, sha: string): Promise<boolean> {
  useCommitUi.getState().setHook(repoId, null);
  try {
    const result = await unwrap(ipc.commands.commitFixup(repoId, sha));
    invalidateGraph(repoId);
    void queryClient.invalidateQueries({ queryKey: queryKeys.repoRefs(repoId) });
    toast({
      variant: 'success',
      title: t('fixup.created', { sha: shortSha(result.sha), target: shortSha(sha) }),
      duration: 5000,
      action: {
        label: t('fixup.autosquash'),
        onClick: () => void startAutosquash(repoId),
      },
    });
    return true;
  } catch (error) {
    if (error instanceof YagguiIpcError) {
      const { code, payload } = error.error;
      if (code === 'hookFailed' && payload?.kind === 'hook') {
        // The commit box shows the hook output; the toast says so wherever the user is.
        useCommitUi
          .getState()
          .setHook(repoId, { ...payload, message: localize(error.error.message) });
      }
      // Not toasted by `op-finished` for a commit: the commit box handles them there.
      if (code === 'hookFailed' || code === 'identityUnknown') {
        showError(error);
        return false;
      }
    }
    reportWriteError(error);
    return false;
  } finally {
    refreshWorktree(repoId);
  }
}

/** The arranged plan of `base..HEAD`; `null` base: the backend picks it. */
export function useAutosquashPlan(repoId: number, base: string | null, enabled: boolean) {
  return useQuery({
    queryKey: autosquashKey(repoId, base),
    queryFn: () => unwrap(ipc.commands.autosquashPlan(repoId, base)),
    enabled,
    staleTime: Infinity,
  });
}

/**
 * Opens the interactive rebase with the fixups of the current branch under their targets,
 * from the parent of the oldest target; says so when there is nothing to squash.
 */
export async function startAutosquash(repoId: number): Promise<void> {
  try {
    // Fresh: the view reads the same query from the cache.
    queryClient.removeQueries({ queryKey: autosquashKey(repoId, null) });
    const plan = await queryClient.query({
      queryKey: autosquashKey(repoId, null),
      queryFn: () => unwrap(ipc.commands.autosquashPlan(repoId, null)),
      staleTime: Infinity,
    });
    if (plan === null) {
      toast({ variant: 'info', title: t('fixup.nothingToSquash'), duration: 4000 });
      return;
    }
    openAutosquash(repoId, null);
  } catch (error) {
    showError(error);
  }
}

/** Forgets the arranged plans of a repository: stale once the view is left. */
export function forgetAutosquash(repoId: number): void {
  queryClient.removeQueries({ queryKey: ['rebase-autosquash', repoId] });
}
