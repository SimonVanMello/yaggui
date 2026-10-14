import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend, mockClient } from '../ipc/mockClient';
import type { YagguiClient } from '../ipc';
import {
  DEFAULT_PREFERENCES,
  LEGACY_LOCALE_KEY,
  LEGACY_THEME_KEY,
  loadPreferences,
  readLegacyPreferences,
  savePreferences,
} from './preferences';

beforeEach(() => {
  mockBackend.reset();
  localStorage.clear();
});

describe('readLegacyPreferences', () => {
  it('returns null without legacy keys', () => {
    expect(readLegacyPreferences(localStorage)).toBeNull();
    expect(readLegacyPreferences(null)).toBeNull();
  });

  it('keeps valid values and drops invalid ones', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'dark');
    localStorage.setItem(LEGACY_LOCALE_KEY, 'de');
    expect(readLegacyPreferences(localStorage)).toEqual({ theme: 'dark', locale: null });
  });
});

describe('loadPreferences', () => {
  it('reads the stored preferences', async () => {
    await mockClient.commands.setPreferences({
      ...DEFAULT_PREFERENCES,
      theme: 'light',
      locale: 'fr',
      terminal: null,
      diffView: 'split',
    });
    await expect(loadPreferences(mockClient, localStorage)).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'light',
      locale: 'fr',
      terminal: null,
      diffView: 'split',
    });
  });

  it('migrates localStorage values once, then removes them', async () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'dark');
    localStorage.setItem(LEGACY_LOCALE_KEY, 'fr');
    await expect(loadPreferences(mockClient, localStorage)).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
      locale: 'fr',
      terminal: null,
      diffView: 'split',
      diffOptions: DEFAULT_PREFERENCES.diffOptions,
      // The mock answered the update question, see DEFAULT_MOCK_PREFERENCES.
      checkUpdates: false,
    });
    expect(localStorage.getItem(LEGACY_THEME_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LOCALE_KEY)).toBeNull();
    await expect(mockClient.commands.getPreferences()).resolves.toMatchObject({
      data: { theme: 'dark', locale: 'fr' },
    });
  });

  it('falls back to defaults when the backend fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: YagguiClient = {
      ...mockClient,
      commands: { ...mockClient.commands, getPreferences: () => Promise.reject(new Error('down')) },
    };
    await expect(loadPreferences(broken, localStorage)).resolves.toEqual(DEFAULT_PREFERENCES);
    warn.mockRestore();
  });
});

describe('savePreferences', () => {
  it('merges the patch into the current preferences', async () => {
    await mockClient.commands.setPreferences({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
      locale: 'fr',
      terminal: null,
      diffView: 'split',
    });
    await loadPreferences(mockClient, localStorage);
    savePreferences({ locale: 'en' }, mockClient);
    await vi.waitFor(async () => {
      await expect(mockClient.commands.getPreferences()).resolves.toMatchObject({
        data: { theme: 'dark', locale: 'en' },
      });
    });
  });
});
