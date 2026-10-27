import { catalogs } from '../i18n/i18n';
import type { YagguiClient, YagguiCommands, YagguiError } from '../ipc';
import { toast } from '../ui/toastStore';

import { translateNow } from './translateNow';

// Built on call: this module is loaded by `ipc`, which the i18n module itself depends on.
function desktopOnly(): YagguiError {
  return {
    code: 'notImplemented',
    message: { en: catalogs.en['demo.desktopOnly'], fr: catalogs.fr['demo.desktopOnly'] },
    action: null,
    detail: null,
    payload: null,
  };
}

const unavailable = () => Promise.resolve({ status: 'error' as const, error: desktopOnly() });

/** The folder picker reports a cancellation, so its callers stay silent and the toast says why. */
const pickerUnavailable = () => {
  toast({ variant: 'info', title: translateNow('demo.desktopOnly') });
  return Promise.resolve({ status: 'ok' as const, data: null });
};

/** Commands that need the OS (native tools, folder access, network, updates). */
const overrides: Partial<YagguiCommands> = {
  openInEditor: unavailable,
  openTerminal: unavailable,
  revealPath: unavailable,
  runDiffTool: unavailable,
  pickRepoFolder: pickerUnavailable,
  cloneRepo: unavailable,
  checkForUpdate: unavailable,
  installUpdate: unavailable,
  avatar: unavailable,
  // No provider to call from a browser demo, and no key to keep.
  aiGenerateCommitMessage: unavailable,
  aiTestProvider: unavailable,
  aiSetApiKey: unavailable,
};

/** Wraps the mock backend of the demo: what cannot work in a browser says so instead of faking. */
export function demoClient(client: YagguiClient): YagguiClient {
  const appInfo: YagguiCommands['appInfo'] = async () => ({
    ...(await client.commands.appInfo()),
    appVersion: import.meta.env.VITE_APP_VERSION ?? 'demo',
  });
  return { ...client, commands: { ...client.commands, ...overrides, appInfo } };
}
