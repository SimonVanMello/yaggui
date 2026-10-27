import { isDemo } from '../demo/isDemo';
import { openSampleRepo } from '../demo/startDemo';
import { useKeybindings } from '../features/keybindings/keybindingsStore';
import { checkForUpdatesAtStartup } from '../features/updates/updates';
import { startAutoFetch } from '../features/network/autoFetch';
import { openRepoPath, restoreRepoSession } from '../features/repo/repoSessions';
import { ipc, nativeWindow, unwrap } from '../ipc';
import { installAppMenu } from './menu/appMenu';
import { flushRepoLayouts, persistRepoLayouts } from './tabs/repoLayout';
import { selectActiveTab, toSavedTabs, useTabsStore, type ShellTab } from './tabs/tabsStore';

const SAVE_DELAY_MS = 300;
/** Longest wait for the pending saves before the window closes anyway. */
const FLUSH_TIMEOUT_MS = 1000;

/**
 * Whether the saved tabs were read: a session started on a failed read must not overwrite
 * the stored one (the next launch would restore a single welcome tab instead of it).
 */
let tabsHydrated = false;

/** Exported for the tests: `startup()` runs it once. */
export async function restoreTabs(): Promise<void> {
  try {
    useTabsStore.getState().hydrate(await unwrap(ipc.commands.getTabs()));
    tabsHydrated = true;
  } catch (error) {
    console.warn('Saved tabs unavailable, starting with a new tab', error);
  }
  const state = useTabsStore.getState();
  const active = selectActiveTab(state);
  let activeRestored: Promise<void> | undefined;
  for (const tab of state.tabs) {
    if (tab.repoId === null) continue;
    const restored = restoreRepoSession(tab.repoId);
    if (tab.id === active.id) activeRestored = restored;
  }
  // Only the visible tab delays the first display; the others finish in the background.
  await activeRestored;
}

/** `yaggui <path>` (F-001): opens the path in the active welcome tab, or a new tab. */
async function openLaunchPath(): Promise<void> {
  let path: string | null;
  try {
    path = await ipc.commands.launchPath();
  } catch (error) {
    console.warn('Launch path unavailable', error);
    return;
  }
  if (!path) return;
  const active = selectActiveTab(useTabsStore.getState());
  await openRepoPath(path, active.repoId === null ? active.id : undefined);
}

let tabsSaveTimer: ReturnType<typeof setTimeout> | undefined;
/** Saves run one after the other, each with the tabs as they are when it starts. */
let tabsSaving: Promise<void> = Promise.resolve();
let tabsSaveWarned = false;

function saveTabsNow(): Promise<void> {
  clearTimeout(tabsSaveTimer);
  tabsSaveTimer = undefined;
  tabsSaving = tabsSaving
    .then(() => ipc.commands.saveTabs(toSavedTabs(useTabsStore.getState())))
    .then((result) => {
      if (result.status === 'error' && !tabsSaveWarned) {
        tabsSaveWarned = true;
        console.warn('Tabs could not be saved', result.error);
      }
    });
  return tabsSaving;
}

/** A tab opened, closed, moved, given a repository or activated: what a restore must not miss. */
function tabsStructureChanged(
  state: { tabs: readonly ShellTab[]; activeTabId: string },
  previous: { tabs: readonly ShellTab[]; activeTabId: string },
): boolean {
  return (
    state.activeTabId !== previous.activeTabId ||
    state.tabs.length !== previous.tabs.length ||
    state.tabs.some((tab, index) => {
      const old = previous.tabs[index];
      return old === undefined || tab.id !== old.id || tab.repoId !== old.repoId;
    })
  );
}

/**
 * Saves the tabs after every change: at once when their structure changes (also covers a quit
 * that skips the close event, like ⌘Q on macOS), after a short delay for the panel sizes that
 * change on every pointer move. Exported for the tests: `startup()` runs it once.
 */
export function persistTabs(): () => void {
  return useTabsStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId) return;
    if (!tabsHydrated) return;
    if (tabsStructureChanged(state, previous)) {
      void saveTabsNow();
      return;
    }
    clearTimeout(tabsSaveTimer);
    tabsSaveTimer = setTimeout(() => void saveTabsNow(), SAVE_DELAY_MS);
  });
}

/** Writes the tab save still waiting for its delay, if any. */
export function flushTabs(): Promise<void> {
  return tabsSaveTimer === undefined ? tabsSaving : saveTabsNow();
}

/** Writes every save waiting for its delay (tabs, repository layouts) before the window closes. */
export function flushPersistence(): Promise<void> {
  return Promise.all([flushTabs(), flushRepoLayouts()]).then(() => undefined);
}

/** Closing the window waits for the pending saves, within reason. */
function flushOnClose(): void {
  nativeWindow.onCloseRequested(() => {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS));
    const flushed = flushPersistence().catch((error: unknown) => {
      console.warn('Could not save the session before closing', error);
    });
    return Promise.race([flushed, timeout]);
  });
}

/** Tests only: forgets the pending save and the hydration state. */
export function resetTabsPersistence({ hydrated = false }: { hydrated?: boolean } = {}): void {
  clearTimeout(tabsSaveTimer);
  tabsSaveTimer = undefined;
  tabsSaving = Promise.resolve();
  tabsHydrated = hydrated;
}

let started: Promise<void> | undefined;

/** Runs once per app launch (idempotent under React StrictMode). */
export function startup(): Promise<void> {
  started ??= (async () => {
    // Preferences are already applied by main.tsx, before the first render.
    // Read first: the menu's accelerators and every shortcut hint depend on the user's bindings.
    await useKeybindings.getState().load();
    // The menu goes up before the window shows: until then ⌘W, ⌘C… have no menu item.
    const menu = installAppMenu().catch((error: unknown) => {
      console.warn('Could not install the menu', error);
    });
    await restoreTabs();
    await menu;
    persistTabs();
    persistRepoLayouts(SAVE_DELAY_MS);
    flushOnClose();
    // After the restore: the restored repositories get their timer here, the ones opened
    // later get theirs when their session opens.
    startAutoFetch();
    await openLaunchPath();
    if (isDemo) {
      await openSampleRepo().catch((error: unknown) => {
        console.warn('Could not open the sample repository', error);
      });
    } else checkForUpdatesAtStartup();
  })();
  return started;
}
