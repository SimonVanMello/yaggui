import { showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { ipc } from '../../ipc';

/** Opens the repository folder in the system file manager; failures become an error toast. */
export async function openRepoFolder(repoId: number): Promise<void> {
  const result = await ipc.commands.revealPath(repoId, null);
  if (result.status === 'error') {
    showYagguiError(result.error, {
      title: translate(useI18nStore.getState().locale, 'toolbar.fileManager.failed'),
      retry: () => void openRepoFolder(repoId),
    });
  }
}
