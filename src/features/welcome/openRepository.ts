import { useShellStore } from '../../app/shellStore';
import { translate, useI18nStore } from '../../i18n/i18n';
import { ipc, unwrap } from '../../ipc';
import { openRepoPath } from '../repo/repoSessions';

let picking = false;

/** Asks for a folder with the native picker; `null` when cancelled (or already picking). */
export async function pickRepoFolder(): Promise<string | null> {
  if (picking) return null;
  picking = true;
  try {
    const title = translate(useI18nStore.getState().locale, 'openDialog.pickerTitle');
    return await unwrap(ipc.commands.pickRepoFolder(title));
  } finally {
    picking = false;
  }
}

/**
 * "Open a repository" (F-001): native folder picker, then opens the folder in `targetTabId`
 * (a welcome tab) or a new tab. If the picker is unavailable, falls back to the path dialog.
 */
export async function pickAndOpenRepo(targetTabId: string | null): Promise<void> {
  let path: string | null;
  try {
    path = await pickRepoFolder();
  } catch (error) {
    console.warn('Folder picker unavailable, falling back to the path dialog', error);
    useShellStore.getState().showOpenDialog(targetTabId);
    return;
  }
  if (path) await openRepoPath(path, targetTabId ?? undefined);
}
