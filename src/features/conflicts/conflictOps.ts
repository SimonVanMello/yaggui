import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, unwrap, type ConflictResolution } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { refreshHistory } from '../history/historyOps';
import { refreshConflictFiles } from './conflictQueries';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Runs a conflict write; its result, or `null` when it failed (reported). */
async function run<T>(repoId: number, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    showError(error);
    return null;
  } finally {
    // The banner's Continue (`operationDetail`), the list and the editor follow.
    refreshHistory(repoId);
    refreshConflictFiles(repoId);
  }
}

/**
 * Resolves files with one side or as they are (F-161), or one file with the 3-way editor's
 * result (F-162); the lists refresh either way.
 */
export async function resolveConflicts(
  repoId: number,
  paths: string[],
  resolution: ConflictResolution,
): Promise<boolean> {
  const done = await run(repoId, async () => {
    await unwrap(ipc.commands.resolveConflicts(repoId, paths, resolution));
    return true;
  });
  return done ?? false;
}

/**
 * Opens the file in the configured merge tool and waits for it to close (F-164). Returns
 * whether the file is resolved.
 */
export async function runMergeTool(repoId: number, path: string, tool: string): Promise<boolean> {
  const result = await run(repoId, () => unwrap(ipc.commands.runMergeTool(repoId, path)));
  // Failed or cancelled: already reported.
  if (result === null) return false;
  if (result.resolved) {
    toast({ variant: 'success', title: t('conflicts.editor.tool.resolved', { tool }) });
  } else {
    toast({
      variant: 'info',
      title: t('conflicts.editor.tool.unresolved', { tool }),
      description: t('conflicts.editor.tool.unresolvedHint'),
    });
  }
  return result.resolved;
}
