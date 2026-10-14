import { showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { ipc } from '../../ipc';

/** Opens the configured terminal in the repository (F-266); failures become an error toast. */
export async function openTerminal(repoId: number): Promise<void> {
  const result = await ipc.commands.openTerminal(repoId);
  if (result.status === 'error') {
    showYagguiError(result.error, {
      title: translate(useI18nStore.getState().locale, 'toolbar.terminal.failed'),
      retry: () => void openTerminal(repoId),
    });
  }
}
