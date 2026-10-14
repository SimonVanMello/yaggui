import { showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { ipc } from '../../ipc';

/** Opens the repository (or one of its files) in the external editor (F-323). */
export async function openInEditor(repoId: number, path: string | null = null): Promise<void> {
  const result = await ipc.commands.openInEditor(repoId, path);
  if (result.status === 'error') {
    showYagguiError(result.error, {
      title: translate(useI18nStore.getState().locale, 'editor.failed'),
      retry: () => void openInEditor(repoId, path),
    });
  }
}
