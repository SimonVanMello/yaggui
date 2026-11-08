import { translate, useI18nStore, type Locale, type MessageKey } from '../../i18n/i18n';
import { useKeybindings } from '../../features/keybindings/keybindingsStore';
import { runAction } from '../../features/palette/actionRegistry';
import { openRepoPath } from '../../features/repo/repoSessions';
import {
  nativeMenu,
  type KnownRepo,
  type MenuEntry,
  type MenuSection,
  type NativeMenuItem,
} from '../../ipc';
import { forwardToTextEntry } from '../../features/undo/textUndo';
import {
  isShellAction,
  modalOpen,
  runShellAction,
  shortcutOf,
  type ShellAction,
} from '../shellActions';
import { selectActiveTab, useTabsStore } from '../tabs/tabsStore';
import { watchRecentRepos } from './recentRepos';

/**
 * Shell actions that carry their shortcut as a menu accelerator. ⌘1…9 and ⌃Tab stay keyboard
 * only: nine "Tab n" items would clutter the menu, and macOS menus do not reliably catch ⌃Tab.
 */
const ACCELERATED: ReadonlySet<ShellAction> = new Set([
  'newTab',
  'openRepo',
  'closeTab',
  'toggleLog',
  'toggleSidebar',
  'toggleDetails',
  'undo',
  'redo',
  // Repository menu.
  'fetch',
  'pull',
  'push',
  'createBranch',
  'stash',
  'stashPop',
  // View › zoom.
  'zoomIn',
  'zoomOut',
  'zoomReset',
]);

/** Palette actions the menu runs by id (see `builtinActions.ts`). */
export const REGISTRY_ITEMS = ['repo.terminal', 'repo.editor', 'repo.fileManager'] as const;

/** Items of the Repository menu: greyed out while the active tab has no repository. */
export const REPO_ITEMS: readonly string[] = [
  'fetch',
  'pull',
  'push',
  'createBranch',
  'createTag',
  'stash',
  'stashPop',
  ...REGISTRY_ITEMS,
  'opHistory',
];

/** Id of an Open Recent item: the prefix, then the repository's path. */
export const RECENT_PREFIX = 'recent:';
const NO_RECENT = 'recent';

export interface MenuContext {
  /** Open Recent, most recently opened first (already cut to its length). */
  recents: readonly KnownRepo[];
  /** Whether the active tab has a repository (Repository menu enabled). */
  hasRepo: boolean;
}

const EMPTY_CONTEXT: MenuContext = { recents: [], hasRepo: false };

/** The Open Recent items: the name, and the path where two repositories share a name. */
function recentEntries(recents: readonly KnownRepo[], t: (key: MessageKey) => string) {
  if (recents.length === 0) {
    const empty: MenuEntry = {
      kind: 'action',
      id: NO_RECENT,
      label: t('menu.openRecent.empty'),
      enabled: false,
    };
    return [empty];
  }
  return recents.map((repo): MenuEntry => ({
    kind: 'action',
    id: `${RECENT_PREFIX}${repo.path}`,
    label: recents.some((other) => other !== repo && other.name === repo.name)
      ? `${repo.name} — ${repo.path}`
      : repo.name,
    // A moved or deleted folder cannot open; the welcome screen offers to locate it.
    enabled: repo.exists,
  }));
}

/** Standard macOS menu bar: yaggui, File, Edit, Repository, View, Window, Help (spec §6.9). */
export function buildAppMenu(locale: Locale, context: MenuContext = EMPTY_CONTEXT): MenuSection[] {
  const t = (key: MessageKey) => translate(locale, key);
  const action = (id: ShellAction, key: MessageKey): MenuEntry => ({
    kind: 'action',
    id,
    label: t(key),
    shortcut: ACCELERATED.has(id) ? shortcutOf(id) : undefined,
  });
  const repoAction = (id: ShellAction | (typeof REGISTRY_ITEMS)[number], key: MessageKey) => {
    const entry: MenuEntry = isShellAction(id)
      ? action(id, key)
      : { kind: 'action', id, label: t(key) };
    return { ...entry, enabled: context.hasRepo };
  };
  const native = (item: NativeMenuItem, key: MessageKey): MenuEntry => ({
    kind: 'native',
    item,
    label: t(key),
  });
  const separator: MenuEntry = { kind: 'separator' };

  return [
    {
      // macOS titles the first menu with the app name, whatever its label.
      label: 'yaggui',
      entries: [
        native('About', 'menu.about'),
        separator,
        action('preferences', 'menu.preferences'),
        action('terminalSettings', 'menu.terminal'),
        separator,
        native('Services', 'menu.services'),
        separator,
        native('Hide', 'menu.hide'),
        native('HideOthers', 'menu.hideOthers'),
        native('ShowAll', 'menu.showAll'),
        separator,
        native('Quit', 'menu.quit'),
      ],
    },
    {
      label: t('menu.file'),
      entries: [
        action('newTab', 'menu.newTab'),
        action('openRepo', 'menu.open'),
        action('cloneRepo', 'menu.clone'),
        action('initRepo', 'menu.init'),
        {
          kind: 'submenu',
          label: t('menu.openRecent'),
          entries: recentEntries(context.recents, t),
        },
        separator,
        action('closeTab', 'menu.closeTab'),
      ],
    },
    {
      // Native items: copy, paste and select all keep working in text fields. Undo and redo are
      // ours: the native ones would swallow ⌘Z, which then never reaches the app (F-240).
      label: t('menu.edit'),
      entries: [
        action('undo', 'menu.undo'),
        action('redo', 'menu.redo'),
        separator,
        native('Cut', 'menu.cut'),
        native('Copy', 'menu.copy'),
        native('Paste', 'menu.paste'),
        native('SelectAll', 'menu.selectAll'),
      ],
    },
    {
      label: t('menu.repository'),
      entries: [
        repoAction('fetch', 'menu.fetch'),
        repoAction('pull', 'menu.pull'),
        repoAction('push', 'menu.push'),
        separator,
        repoAction('createBranch', 'menu.newBranch'),
        repoAction('createTag', 'menu.newTag'),
        repoAction('stash', 'menu.stash'),
        repoAction('stashPop', 'menu.stashPop'),
        separator,
        repoAction('repo.terminal', 'menu.openTerminal'),
        repoAction('repo.editor', 'menu.openEditor'),
        repoAction('repo.fileManager', 'menu.openFileManager'),
        separator,
        repoAction('opHistory', 'menu.opHistory'),
      ],
    },
    {
      label: t('menu.view'),
      entries: [
        action('toggleSidebar', 'menu.toggleSidebar'),
        action('toggleDetails', 'menu.toggleDetails'),
        action('toggleLog', 'menu.commandLog'),
        separator,
        action('zoomIn', 'menu.zoomIn'),
        action('zoomOut', 'menu.zoomOut'),
        action('zoomReset', 'menu.actualSize'),
        separator,
        native('Fullscreen', 'menu.fullscreen'),
      ],
    },
    {
      label: t('menu.window'),
      role: 'window',
      entries: [
        native('Minimize', 'menu.minimize'),
        native('Maximize', 'menu.zoom'),
        separator,
        action('nextTab', 'menu.nextTab'),
        action('previousTab', 'menu.previousTab'),
        separator,
        native('BringAllToFront', 'menu.bringAllToFront'),
      ],
    },
    {
      label: t('menu.help'),
      role: 'help',
      entries: [
        action('changelog', 'menu.changelog'),
        action('toggleLog', 'menu.commandLog'),
        separator,
        action('reportBug', 'menu.reportBug'),
        action('openLogs', 'menu.openLogs'),
      ],
    },
  ];
}

let menuInstalled = false;

/** Shortcuts the installed menu handles, which the keyboard handler must leave alone. */
export function menuShortcuts(): ReadonlySet<string> {
  if (!menuInstalled) return new Set();
  return new Set([...ACCELERATED].map(shortcutOf).filter((shortcut) => shortcut !== undefined));
}

/** The active tab when it is a welcome tab (it receives the repository), else a new tab. */
function welcomeTabId(): string | undefined {
  const tab = selectActiveTab(useTabsStore.getState());
  return tab.repoId === null ? tab.id : undefined;
}

function onMenuAction(id: string): void {
  if (isShellAction(id)) {
    // In a text field the menu item is the field's own undo: the app's applies elsewhere only.
    if ((id === 'undo' || id === 'redo') && forwardToTextEntry(id)) return;
    runShellAction(id);
    return;
  }
  if (modalOpen()) return;
  // Opens the repository, or activates its tab if it is open (as from the welcome screen).
  if (id.startsWith(RECENT_PREFIX))
    void openRepoPath(id.slice(RECENT_PREFIX.length), welcomeTabId());
  else runAction(id);
}

const hasRepo = () => selectActiveTab(useTabsStore.getState()).repoId !== null;

/** A burst of changes (language, shortcuts, recents) makes one rebuild. */
const REBUILD_DELAY_MS = 100;

let recents: readonly KnownRepo[] = [];
/** State of the Repository items in the installed menu (`null`: none installed yet). */
let menuHasRepo: boolean | null = null;

async function install(): Promise<void> {
  const built = hasRepo();
  await nativeMenu.install(
    buildAppMenu(useI18nStore.getState().locale, { recents, hasRepo: built }),
    onMenuAction,
  );
  menuHasRepo = built;
  // The active tab may have changed while the menu was being built.
  syncRepoItems();
}

/** Greys out or enables the Repository menu when the active tab gains or loses a repository. */
function syncRepoItems(): void {
  const current = hasRepo();
  if (menuHasRepo === null || menuHasRepo === current) return;
  menuHasRepo = current;
  // A few items changed in place: cheaper than rebuilding the whole menu on every tab switch.
  nativeMenu.setEnabled(REPO_ITEMS, current).catch((error: unknown) => {
    console.warn('Could not update the Repository menu', error);
  });
}

let watching = false;
let recentsWatched = false;

/**
 * Installs the macOS menu and rebuilds it when the UI language, a shortcut or the recent
 * repositories change; keeps the Repository menu in step with the active tab.
 */
export async function installAppMenu(): Promise<void> {
  if (!nativeMenu.supported) return;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      // A failed rebuild keeps the previous menu, with the same accelerators.
      install().catch((error: unknown) => {
        console.warn('Could not rebuild the menu', error);
      });
    }, REBUILD_DELAY_MS);
  };
  if (!recentsWatched) {
    recentsWatched = true;
    recents = await watchRecentRepos((next) => {
      recents = next;
      rebuild();
    });
  }
  await install();
  // Set once the menu is really in place: until then (or if it failed) the keyboard handles all.
  menuInstalled = true;
  if (watching) return;
  watching = true;
  useI18nStore.subscribe((state, previous) => {
    if (state.locale !== previous.locale) rebuild();
  });
  // Rebinding a menu shortcut (F-281) changes its accelerator.
  useKeybindings.subscribe((state, previous) => {
    if (state.overrides !== previous.overrides) rebuild();
  });
  useTabsStore.subscribe(syncRepoItems);
}
