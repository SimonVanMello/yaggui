import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { ipc, unwrap, YagguiIpcError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { copyText } from '../graph/CommitContextMenu';

function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/**
 * "Save as…": the backend asks where to save and writes the version of `path` stored in
 * `rev` (the native dialog asks before replacing a file). Nothing happens on cancel.
 */
export async function saveTreeVersion(repoId: number, rev: string, path: string): Promise<void> {
  const name = path.slice(path.lastIndexOf('/') + 1);
  try {
    const dest = await unwrap(
      ipc.commands.saveTreeFile(repoId, rev, path, t('tree.save.dialog', { name })),
    );
    if (dest === null) return;
    toast({ variant: 'success', title: t('tree.save.saved', { path: dest }), duration: 4000 });
  } catch (failure) {
    const known = failure instanceof YagguiIpcError ? failure.error : null;
    toast({
      variant: 'error',
      title: t('tree.save.failed'),
      description: known?.message[useI18nStore.getState().locale],
      detail: known?.detail ?? undefined,
    });
    if (!known) console.warn('Saving a tree file failed', failure);
  }
}

export function copyTreePath(path: string): void {
  copyText(path, t('tree.pathCopied'));
}
