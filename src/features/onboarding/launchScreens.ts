import { currentPreferences } from '../../app/preferences';
import { queryClient, queryKeys } from '../../app/queryClient';
import { useShellStore } from '../../app/shellStore';
import { ipc, type Preferences } from '../../ipc';
import { savePreferenceOrToast } from '../preferences/savePreference';
import { checkForUpdatesAtStartup } from '../updates/updates';

/**
 * The update check of this launch, held while the first-launch screen is open: the screen asks
 * the same question, and an answer there must not be followed by the one-time toast.
 */
let updateCheckPending = false;

/** What "What's new" does at a launch of `version`. */
export function whatsNewAtLaunch(
  prefs: Pick<Preferences, 'lastSeenVersion' | 'showWhatsNew'>,
  version: string,
  firstRun: boolean,
): { open: boolean; record: boolean } {
  const record = prefs.lastSeenVersion !== version;
  // Never seen: a fresh install, or the first launch with this feature. Neither is an update.
  const open =
    record && (prefs.lastSeenVersion ?? null) !== null && prefs.showWhatsNew !== false && !firstRun;
  return { open, record };
}

async function appVersion(): Promise<string | null> {
  try {
    const info = await queryClient.query({
      queryKey: queryKeys.appInfo,
      queryFn: () => ipc.commands.appInfo(),
      staleTime: Infinity,
    });
    return info.appVersion;
  } catch (error) {
    console.warn('App version unavailable', error);
    return null;
  }
}

/**
 * Runs once per launch, after the tabs are back: the first-launch screen on a fresh config,
 * else the update check and, after an update, "What's new" once.
 */
export async function runLaunchScreens(): Promise<void> {
  const firstRun = !currentPreferences().onboarded;
  if (firstRun) {
    updateCheckPending = true;
    useShellStore.getState().setFirstRunOpen(true);
  } else {
    checkForUpdatesAtStartup();
  }
  const version = await appVersion();
  if (version === null) return;
  const { open, record } = whatsNewAtLaunch(currentPreferences(), version, firstRun);
  if (open) useShellStore.getState().setChangelogOpen(true);
  if (record) savePreferenceOrToast({ lastSeenVersion: version });
}

/** The palette action and the preferences: the screen again, with the current choices. */
export function showFirstRun(): void {
  const shell = useShellStore.getState();
  shell.setPreferencesOpen(false);
  shell.setFirstRunOpen(true);
}

/** The screen closed, by any means: it never opens on its own again. */
export function closeFirstRun(): void {
  useShellStore.getState().setFirstRunOpen(false);
  if (!currentPreferences().onboarded) savePreferenceOrToast({ onboarded: true });
  if (updateCheckPending) {
    updateCheckPending = false;
    // Left untouched, the question is still open: the usual one-time toast asks it.
    checkForUpdatesAtStartup();
  }
}

/** Tests only: forgets the held update check. */
export function resetLaunchScreens(): void {
  updateCheckPending = false;
}
