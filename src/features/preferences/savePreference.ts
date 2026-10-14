import { updatePreferences } from '../../app/preferences';
import { translate, useI18nStore } from '../../i18n/i18n';
import { YagguiIpcError, type Preferences } from '../../ipc';
import { toast } from '../../ui/toastStore';

/**
 * Applies a change on screen at once and saves it. If the backend refuses the value, the
 * previous preferences come back and the reason is shown.
 */
export function savePreferenceOrToast(patch: Partial<Preferences>): void {
  void (async () => {
    try {
      await updatePreferences(patch);
    } catch (failure) {
      const locale = useI18nStore.getState().locale;
      toast({
        variant: 'error',
        title: translate(locale, 'prefs.saveFailed'),
        description: failure instanceof YagguiIpcError ? failure.error.message[locale] : undefined,
      });
    }
  })();
}
