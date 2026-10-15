import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentPreferences, savePreferences } from '../../app/preferences';
import type { InstallChannel, UpdateInfo } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { useToastStore } from '../../ui/toastStore';
import { checkForUpdatesAtStartup, checkForUpdatesNow, updateNotice } from './updates';

function release(channel: InstallChannel): UpdateInfo {
  return { currentVersion: '0.1.0', version: '0.2.0', notes: null, date: null, channel };
}

function toasts() {
  return useToastStore.getState().toasts;
}

beforeEach(() => {
  mockBackend.reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  savePreferences({ checkUpdates: null });
});

describe('updateNotice', () => {
  it('installs in place when the updater owns the copy', () => {
    const notice = updateNotice(release('selfUpdate'));
    expect(notice.title).toBe('yaggui 0.2.0 is available');
    expect(notice.action?.label).toBe('Update and restart');
    expect(notice.duration).toBe(Infinity);
  });

  it('hands the copies of a package manager to that package manager', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const brew = updateNotice(release('homebrew'));
    expect(brew.description).toContain('brew update && brew upgrade --cask yaggui');
    expect(brew.action?.label).toBe('Copy the command');
    brew.action?.onClick();
    expect(writeText).toHaveBeenCalledWith('brew update && brew upgrade --cask yaggui');
    await vi.waitFor(() => {
      expect(toasts().map((t) => t.title)).toContain('Command copied');
    });
    expect(updateNotice(release('aur')).description).toContain('yay -Syu yaggui-bin');
    vi.unstubAllGlobals();
  });

  it('sends the other installs to the release page', async () => {
    const notice = updateNotice(release('manual'));
    expect(notice.action?.label).toBe('Open the release page');
    notice.action?.onClick();
    await vi.waitFor(() => {
      expect(mockBackend.releasePageOpens).toBe(1);
    });
  });
});

describe('checkForUpdatesAtStartup', () => {
  it('asks once, and sends nothing before a yes', async () => {
    savePreferences({ checkUpdates: null });
    mockBackend.availableUpdate = release('selfUpdate');
    checkForUpdatesAtStartup();
    expect(currentPreferences().checkUpdates).toBe(false);
    const question = toasts().at(-1);
    expect(question?.title).toBe('Check for updates at startup?');
    expect(mockBackend.updateChecks).toBe(0);

    question?.action?.onClick();
    expect(currentPreferences().checkUpdates).toBe(true);
    await vi.waitFor(() => {
      expect(toasts().at(-1)?.title).toBe('yaggui 0.2.0 is available');
    });
    expect(mockBackend.updateChecks).toBe(1);
  });

  it('checks silently when on, and not at all when off', async () => {
    savePreferences({ checkUpdates: false });
    checkForUpdatesAtStartup();
    expect(mockBackend.updateChecks).toBe(0);
    expect(toasts()).toEqual([]);

    savePreferences({ checkUpdates: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockBackend.updateFailure = {
      code: 'updateCheckFailed',
      message: { en: 'Could not check for updates.', fr: 'Impossible.' },
      action: null,
      detail: 'offline',
      payload: null,
    };
    checkForUpdatesAtStartup();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    // Offline at startup: no message.
    expect(toasts()).toEqual([]);
    warn.mockRestore();
  });
});

describe('checkForUpdatesNow', () => {
  it('answers even when there is nothing new', async () => {
    await checkForUpdatesNow();
    expect(toasts().at(-1)).toMatchObject({ variant: 'success', title: 'yaggui is up to date' });
    mockBackend.availableUpdate = release('aur');
    await checkForUpdatesNow();
    expect(toasts().at(-1)?.title).toBe('yaggui 0.2.0 is available');
  });
});
