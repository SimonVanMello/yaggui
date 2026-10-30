import { create } from 'zustand';

import { loadPreferences } from '../../app/preferences';
import { initI18n, translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { ipc, unwrap, YagguiIpcError, type PreferencesImportPreview } from '../../ipc';
import { initTheme } from '../../theme/themeStore';
import { toast } from '../../ui/toastStore';
import { useKeybindings } from '../keybindings/keybindingsStore';

interface PrefsSyncState {
  /** The file being reviewed; the dialog is open while it is set. */
  preview: PreferencesImportPreview | null;
  applying: boolean;
}

export const usePrefsSync = create<PrefsSyncState>()(() => ({ preview: null, applying: false }));

function t(key: MessageKey): string {
  return translate(useI18nStore.getState().locale, key);
}

function failureToast(title: MessageKey, failure: unknown): void {
  const locale = useI18nStore.getState().locale;
  const known = failure instanceof YagguiIpcError ? failure.error : null;
  toast({
    variant: 'error',
    title: t(title),
    description: known?.message[locale],
    detail: known?.detail ?? undefined,
  });
  if (!known) console.warn('Preferences file failed', failure);
}

/** Asks where to save, then writes the preferences and shortcuts file (F-326). */
export async function exportPreferencesFile(): Promise<void> {
  try {
    const path = await unwrap(ipc.commands.exportPreferences(t('prefs.sync.exportDialog')));
    if (path === null) return;
    toast({
      variant: 'success',
      title: t('prefs.sync.exported'),
      description: path,
      detail: t('prefs.sync.exported.hint'),
    });
  } catch (failure) {
    failureToast('prefs.sync.exportFailed', failure);
  }
}

/** Asks for a file and opens the review of what it would change; nothing is applied yet. */
export async function startPreferencesImport(): Promise<void> {
  try {
    const preview = await unwrap(
      ipc.commands.previewPreferencesImport(t('prefs.sync.importDialog')),
    );
    if (preview !== null) usePrefsSync.setState({ preview });
  } catch (failure) {
    failureToast('prefs.sync.importFailed', failure);
  }
}

export function closePreferencesImport(): void {
  if (!usePrefsSync.getState().applying) usePrefsSync.setState({ preview: null });
}

/** Applies the reviewed file in one step, then reloads what the screens read. */
export async function applyPreferencesImport(): Promise<void> {
  const { preview, applying } = usePrefsSync.getState();
  if (!preview || applying) return;
  usePrefsSync.setState({ applying: true });
  try {
    await unwrap(ipc.commands.applyPreferencesImport(preview.path));
    const [prefs] = await Promise.all([loadPreferences(), useKeybindings.getState().load()]);
    // The theme and language stores read the preferences only at startup (`main.tsx`): an
    // imported theme, style or language must reach them, and the theme cache, now.
    initTheme(prefs);
    initI18n(prefs.locale);
    usePrefsSync.setState({ preview: null, applying: false });
    toast({ variant: 'success', title: t('prefs.sync.applied') });
  } catch (failure) {
    usePrefsSync.setState({ preview: null, applying: false });
    failureToast('prefs.sync.importFailed', failure);
  }
}
