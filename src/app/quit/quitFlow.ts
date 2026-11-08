import { useFileEditStore } from '../../features/diff/fileEditStore';
import { useRebaseStore } from '../../features/rebase/rebaseStore';
import { useOpsStore } from '../../features/repo/opsStore';
import { useRepoSessions } from '../../features/repo/repoSessions';
import { ipc, nativeWindow, type CloseRequest } from '../../ipc';
import { confirmLeave, currentPendingWork } from './quitGuard';

/** Writes the pending saves before the app goes; set by `installQuitGuard`. */
let flush: () => Promise<void> = () => Promise.resolve();
let quitting: Promise<void> | null = null;

/** Tells the backend the request arrived: the next one waits for this webview again. */
function acknowledge(): void {
  void ipc.commands.acknowledgeQuitRequest().catch((error: unknown) => {
    console.warn('Could not acknowledge the quit request', error);
  });
}

/**
 * Quits the app: the guard first (a confirmation when something is in progress), then the
 * pending saves, then the backend exits. A second request while one runs joins it.
 */
export function requestQuit(): Promise<void> {
  quitting ??= (async () => {
    try {
      if (!(await confirmLeave())) return;
      await flush();
      await ipc.commands.quitApp();
    } catch (error) {
      console.warn('Could not quit', error);
    } finally {
      quitting = null;
    }
  })();
  return quitting;
}

/** The window's close (its button, Alt+F4): same guard; the browser's unload cannot wait. */
export async function windowCloseRequested(request: CloseRequest): Promise<boolean> {
  if (request.vetoable) {
    acknowledge();
    if (!(await confirmLeave())) return false;
  }
  await flush();
  return true;
}

/**
 * Keeps the backend told whether a native quit (⌘Q, the macOS Dock) must ask first: without
 * anything in progress it quits at once, without a round trip through the webview.
 */
function syncBackendGuard(): () => void {
  let active: boolean | null = null;
  const sync = () => {
    const next = currentPendingWork().length > 0;
    if (next === active) return;
    active = next;
    void ipc.commands.setQuitGuard(next).catch((error: unknown) => {
      console.warn('Could not update the quit guard', error);
    });
  };
  sync();
  const unsubscribe = [
    useOpsStore.subscribe((state, previous) => {
      if (state.running !== previous.running) sync();
    }),
    useRebaseStore.subscribe(sync),
    useFileEditStore.subscribe((state, previous) => {
      if (state.unsaved !== previous.unsaved) sync();
    }),
    useRepoSessions.subscribe(sync),
  ];
  return () => {
    for (const off of unsubscribe) off();
  };
}

/** Runs once at startup: the window's close, the native quit requests and the backend flag. */
export function installQuitGuard(options: { flush: () => Promise<void> }): () => void {
  flush = options.flush;
  const offClose = nativeWindow.onCloseRequested(windowCloseRequested);
  const offQuit = ipc.events.subscribe('quitRequested', () => {
    acknowledge();
    void requestQuit();
  });
  const offSync = syncBackendGuard();
  return () => {
    offClose();
    offQuit();
    offSync();
  };
}
