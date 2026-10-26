import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend, mockClient } from '../ipc/mockClient';
import { YagguiIpcError, type IpcResult, type Preferences, type YagguiClient } from '../ipc';
import {
  currentPreferences,
  DEFAULT_PREFERENCES,
  LEGACY_LOCALE_KEY,
  LEGACY_THEME_KEY,
  loadPreferences,
  readLegacyPreferences,
  savePreferences,
  updatePreferences,
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

describe('updatePreferences', () => {
  function deferredClient() {
    const pending: ((value: Preferences) => void)[] = [];
    const sent: Preferences[] = [];
    const client = {
      commands: {
        setPreferences: (prefs: Preferences) =>
          new Promise<IpcResult<Preferences>>((resolve) => {
            sent.push(prefs);
            pending.push((value) => {
              resolve({ status: 'ok', data: value });
            });
          }),
      },
    } as unknown as YagguiClient;
    return { client, sent, pending };
  }

  it('sends the saves one after the other, each with the latest values', async () => {
    const { client, sent, pending } = deferredClient();
    await loadPreferences(mockClient, localStorage);
    const first = updatePreferences({ fontSize: 14 }, client);
    const second = updatePreferences({ fontSize: 15 }, client);
    expect(currentPreferences().fontSize).toBe(15);
    await Promise.resolve();
    // Only one request in flight; it carries the value on screen (the last write wins).
    expect(sent).toHaveLength(1);
    expect(sent[0]?.fontSize).toBe(15);

    pending[0]?.(sent[0] as Preferences);
    await first;
    expect(currentPreferences().fontSize).toBe(15);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    pending[1]?.(sent[1] as Preferences);
    await second;
    expect(currentPreferences().fontSize).toBe(15);
  });

  it('goes on after a refused save', async () => {
    await loadPreferences(mockClient, localStorage);
    const failing = {
      commands: {
        setPreferences: () =>
          Promise.resolve({
            status: 'error',
            error: {
              code: 'invalidArgument',
              message: { en: 'no', fr: 'non' },
              action: null,
              detail: null,
              payload: null,
            },
          } satisfies IpcResult<Preferences>),
      },
    } as unknown as YagguiClient;
    await expect(updatePreferences({ fontSize: 14 }, failing)).rejects.toBeInstanceOf(
      YagguiIpcError,
    );
    expect(currentPreferences().fontSize).toBe(13);
    await expect(updatePreferences({ fontSize: 16 }, mockClient)).resolves.toMatchObject({
      fontSize: 16,
    });
  });
});
