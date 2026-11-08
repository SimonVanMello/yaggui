import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentPreferences, loadPreferences, savePreferences } from '../../app/preferences';
import { queryClient } from '../../app/queryClient';
import { useShellStore } from '../../app/shellStore';
import { mockClient, mockBackend } from '../../ipc/mockClient';
import { useToastStore } from '../../ui/toastStore';
import {
  closeFirstRun,
  resetLaunchScreens,
  runLaunchScreens,
  whatsNewAtLaunch,
} from './launchScreens';

/** The mock's installed version (`mockAppInfo`). */
const VERSION = '0.3.0';

async function stored() {
  const result = await mockClient.commands.getPreferences();
  if (result.status !== 'ok') throw new Error('preferences unavailable');
  return result.data;
}

/** Waits for the queued preference saves to reach the mock. */
async function settled() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockBackend.reset();
  queryClient.clear();
  resetLaunchScreens();
  useToastStore.setState({ toasts: [] });
  useShellStore.setState({ firstRunOpen: false, changelogOpen: false });
});

afterEach(() => {
  savePreferences({ checkUpdates: null, onboarded: false, lastSeenVersion: null });
});

describe('whatsNewAtLaunch', () => {
  const prefs = (lastSeenVersion: string | null, showWhatsNew = true) => ({
    lastSeenVersion,
    showWhatsNew,
  });

  it('records the version of a first launch without opening anything', () => {
    expect(whatsNewAtLaunch(prefs(null), VERSION, false)).toEqual({ open: false, record: true });
  });

  it('opens once after an update, unless turned off or on the first-launch screen', () => {
    expect(whatsNewAtLaunch(prefs('0.2.0'), VERSION, false)).toEqual({ open: true, record: true });
    expect(whatsNewAtLaunch(prefs('0.2.0', false), VERSION, false)).toEqual({
      open: false,
      record: true,
    });
    expect(whatsNewAtLaunch(prefs('0.2.0'), VERSION, true)).toEqual({ open: false, record: true });
    expect(whatsNewAtLaunch(prefs(VERSION), VERSION, false)).toEqual({
      open: false,
      record: false,
    });
  });
});

describe('runLaunchScreens', () => {
  it('leaves an existing installation alone: no screen, the version recorded', async () => {
    // Known repositories: the mock settles `onboarded` on its first read, like the store.
    mockBackend.seedPreferences({ onboarded: false, lastSeenVersion: null });
    await loadPreferences(mockClient, null);
    expect(currentPreferences().onboarded).toBe(true);
    await runLaunchScreens();
    expect(useShellStore.getState().firstRunOpen).toBe(false);
    expect(useShellStore.getState().changelogOpen).toBe(false);
    await settled();
    expect((await stored()).lastSeenVersion).toBe(VERSION);
  });

  it('opens "What\'s new" after an update, then never again for that version', async () => {
    mockBackend.previousVersion('0.2.0');
    await loadPreferences(mockClient, null);
    await runLaunchScreens();
    expect(useShellStore.getState().changelogOpen).toBe(true);
    await settled();
    expect((await stored()).lastSeenVersion).toBe(VERSION);

    useShellStore.setState({ changelogOpen: false });
    await loadPreferences(mockClient, null);
    await runLaunchScreens();
    expect(useShellStore.getState().changelogOpen).toBe(false);
  });

  it('shows the first-launch screen on a fresh install and holds the update question', async () => {
    mockBackend.freshInstall();
    await loadPreferences(mockClient, null);
    expect(currentPreferences().onboarded).toBe(false);
    await runLaunchScreens();
    expect(useShellStore.getState().firstRunOpen).toBe(true);
    // Same launch as the screen: the version is recorded, "What's new" stays closed.
    expect(useShellStore.getState().changelogOpen).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(0);

    closeFirstRun();
    expect(useShellStore.getState().firstRunOpen).toBe(false);
    // Left untouched on the screen: the usual one-time question follows.
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Check for updates at startup?',
    ]);
    await settled();
    const after = await stored();
    expect(after.onboarded).toBe(true);
    expect(after.lastSeenVersion).toBe(VERSION);
  });

  it('asks nothing more when the screen answered the update question', async () => {
    mockBackend.freshInstall();
    await loadPreferences(mockClient, null);
    await runLaunchScreens();
    savePreferences({ checkUpdates: false });
    closeFirstRun();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(mockBackend.updateChecks).toBe(0);
  });

  it('reopened later, closing it does not ask about updates again', async () => {
    await loadPreferences(mockClient, null);
    await runLaunchScreens();
    useToastStore.setState({ toasts: [] });
    useShellStore.getState().setFirstRunOpen(true);
    closeFirstRun();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
