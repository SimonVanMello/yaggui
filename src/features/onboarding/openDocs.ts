import { showYagguiError } from '../../app/errors/presentError';
import { useI18nStore } from '../../i18n/i18n';
import { ipc } from '../../ipc';

/** Docs pages the app links to: their path under `/docs/` on the website. */
export const DOCS_PAGES = {
  home: '',
  installGit: 'start-here/install#requirements',
} as const;

/** Opens a page of the user documentation in the browser, in the language of the interface. */
export async function openDocs(page: string): Promise<void> {
  const result = await ipc.commands.openDocs(page, useI18nStore.getState().locale);
  if (result.status === 'error') showYagguiError(result.error);
}
