import { currentPreferences } from '../../app/preferences';
import { showYagguiError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, type UpdateInfo } from '../../ipc';
import { toast, useToastStore, type ToastInput } from '../../ui/toastStore';
import { savePreferenceOrToast } from '../preferences/savePreference';
import { startUpgrade } from './upgradeStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** The notice of a newer version: its action depends on how this copy was installed. */
export function updateNotice(info: UpdateInfo): ToastInput {
  const title = t('updates.available', { version: info.version });
  if (info.channel === 'selfUpdate') {
    return {
      title,
      description: t('updates.selfUpdate', { current: info.currentVersion }),
      action: {
        label: t('updates.install'),
        onClick: () => void installUpdate(info),
      },
      duration: Infinity,
    };
  }
  if (info.channel === 'aur' || info.channel === 'deb' || info.channel === 'rpm') {
    return {
      title,
      description: t(`updates.${info.channel}`, { current: info.currentVersion }),
      action: {
        label: t('updates.update'),
        onClick: () => {
          startUpgrade(info);
        },
      },
      duration: Infinity,
    };
  }
  return {
    title,
    description: t('updates.manual', { current: info.currentVersion }),
    action: {
      label: t('updates.download'),
      onClick: () => void openReleasePage(),
    },
    duration: Infinity,
  };
}

async function openReleasePage(): Promise<void> {
  const result = await ipc.commands.openReleasePage();
  if (result.status === 'error') showYagguiError(result.error);
}

/** Downloads and installs the update; the app restarts when it is done. */
export async function installUpdate(info: UpdateInfo): Promise<void> {
  const title = t('updates.downloading', { version: info.version });
  const id = toast({ title, duration: Infinity });
  const unsubscribe = ipc.events.subscribe('updateProgress', ({ percent }) => {
    useToastStore.getState().update(id, {
      description: percent === null ? undefined : t('updates.percent', { percent }),
    });
  });
  try {
    const result = await ipc.commands.installUpdate();
    // On success the app restarts: only macOS (while it exits) and the mock backend get here.
    if (result.status === 'error') {
      useToastStore.getState().dismiss(id);
      showYagguiError(result.error, { retry: () => void installUpdate(info) });
    }
  } finally {
    unsubscribe();
  }
}

/** Asks GitHub for a newer version at once (palette): every outcome gets an answer. */
export async function checkForUpdatesNow(): Promise<void> {
  const result = await ipc.commands.checkForUpdate();
  if (result.status === 'error') {
    showYagguiError(result.error, { retry: () => void checkForUpdatesNow() });
    return;
  }
  if (result.data) {
    toast(updateNotice(result.data));
  } else {
    toast({ variant: 'success', title: t('updates.upToDate') });
  }
}

/** The one-time question: the check is opt-in (SPEC §10), nothing is sent before a yes. */
function askOnce(): void {
  // Asked once: ignoring the question leaves the check off, the preferences can turn it on.
  savePreferenceOrToast({ checkUpdates: false });
  toast({
    title: t('updates.optIn'),
    description: t('updates.optIn.hint'),
    action: {
      label: t('updates.optIn.enable'),
      onClick: () => {
        savePreferenceOrToast({ checkUpdates: true });
        // The user asked for it just now: answer like a manual check, "up to date" included.
        void checkForUpdatesNow();
      },
    },
    duration: Infinity,
  });
}

/** A silent check: being offline at startup is not worth a message. */
async function checkAtStartup(): Promise<void> {
  const result = await ipc.commands.checkForUpdate();
  if (result.status === 'error') {
    console.warn('Update check failed', result.error);
    return;
  }
  if (result.data) toast(updateNotice(result.data));
}

/** Runs once per launch, after the tabs are back. */
export function checkForUpdatesAtStartup(): void {
  const { checkUpdates } = currentPreferences();
  if (checkUpdates === true) {
    void checkAtStartup();
  } else if (checkUpdates !== false) {
    askOnce();
  }
}
