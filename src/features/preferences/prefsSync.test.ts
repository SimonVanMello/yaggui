import { beforeEach, describe, expect, it } from 'vitest';

import { loadPreferences, STYLE_CACHE_KEY, THEME_CACHE_KEY } from '../../app/preferences';
import { initI18n, useI18nStore } from '../../i18n/i18n';
import { mockBackend } from '../../ipc/mockClient';
import { initTheme, useThemeStore } from '../../theme/themeStore';
import { applyPreferencesImport, startPreferencesImport, usePrefsSync } from './prefsSync';

function file(preferences: Record<string, unknown>): string {
  return JSON.stringify({ format: 'yaggui-preferences', version: 1, preferences });
}

beforeEach(async () => {
  mockBackend.reset();
  localStorage.clear();
  await loadPreferences();
  initTheme('light', 'standard');
  initI18n('en');
});

describe('applyPreferencesImport', () => {
  it('applies the imported theme, style and language without a restart', async () => {
    mockBackend.setPickedPreferencesFile(
      file({ theme: 'dark', style: 'terminal', locale: 'fr', fontSize: 15 }),
    );
    await startPreferencesImport();
    expect(usePrefsSync.getState().preview).not.toBeNull();

    await applyPreferencesImport();

    expect(usePrefsSync.getState().preview).toBeNull();
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'dark',
      style: 'terminal',
      theme: 'terminal',
    });
    expect(document.documentElement.dataset.theme).toBe('terminal');
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe('dark');
    expect(localStorage.getItem(STYLE_CACHE_KEY)).toBe('terminal');
    expect(useI18nStore.getState()).toMatchObject({ locale: 'fr', preference: 'fr' });
    expect(document.documentElement.lang).toBe('fr');
  });

  it('goes back to the system language when the file follows the OS', async () => {
    initI18n('fr');
    mockBackend.setPickedPreferencesFile(file({ locale: null, theme: 'light' }));
    await startPreferencesImport();
    await applyPreferencesImport();
    expect(useI18nStore.getState().preference).toBeNull();
    expect(useThemeStore.getState().theme).toBe('paper');
  });
});
