import { useKeybindings } from '../features/keybindings/keybindingsStore';
import { checkForUpdatesAtStartup } from '../features/updates/updates';
import { openRepoPath, restoreRepoSession } from '../features/repo/repoSessions';
import { ipc, unwrap } from '../ipc';
import { installAppMenu } from './menu/appMenu';
import { persistRepoLayouts } from './tabs/repoLayout';
import { selectActiveTab, toSavedTabs, useTabsStore } from './tabs/tabsStore';

const SAVE_DELAY_MS = 300;

async function restoreTabs(): Promise<void> {
  try {
    useTabsStore.getState().hydrate(await unwrap(ipc.commands.getTabs()));
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

/** Saves the tabs (order, active tab, panel sizes) shortly after every change. */
function persistTabs(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warned = false;
  useTabsStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void ipc.commands.saveTabs(toSavedTabs(useTabsStore.getState())).then((result) => {
        if (result.status === 'error' && !warned) {
          warned = true;
          console.warn('Tabs could not be saved', result.error);
        }
      });
    }, SAVE_DELAY_MS);
  });
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
    await openLaunchPath();
    checkForUpdatesAtStartup();
  })();
  return started;
}
