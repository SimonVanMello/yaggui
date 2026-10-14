import { showError, showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YagguiIpcError, type YagguiError } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { refreshRefs } from '../refs/refOps';

export function tr(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

export type ModuleResult<T> = { ok: true; data: T } | { ok: false; error: YagguiError | null };

/**
 * Runs a submodule, worktree or LFS write: refreshes the refs and lists afterwards (the
 * watcher skips `.git/modules` and `.git/worktrees`), toasts `success` when given. Failures
 * are returned for an inline display, or toasted when `report` is set; a cancellation is
 * already shown by the operation toast.
 */
export async function runModuleOp<T>(
  repoId: number,
  work: () => Promise<T>,
  { success, report = true }: { success?: MessageKey; report?: boolean } = {},
): Promise<ModuleResult<T>> {
  try {
    const data = await work();
    if (success) toast({ variant: 'success', title: tr(success) });
    return { ok: true, data };
  } catch (error) {
    if (!(error instanceof YagguiIpcError)) {
      showError(error);
      return { ok: false, error: null };
    }
    if (report && error.error.code !== 'cancelled') showYagguiError(error.error);
    return { ok: false, error: error.error };
  } finally {
    refreshRefs(repoId);
  }
}
