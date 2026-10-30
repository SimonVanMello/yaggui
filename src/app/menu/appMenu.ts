import { translate, useI18nStore, type Locale, type MessageKey } from '../../i18n/i18n';
import { useKeybindings } from '../../features/keybindings/keybindingsStore';
import { nativeMenu, type MenuEntry, type MenuSection, type NativeMenuItem } from '../../ipc';
import { forwardToTextEntry } from '../../features/undo/textUndo';
import { isShellAction, runShellAction, shortcutOf, type ShellAction } from '../shellActions';

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
]);

/** Standard macOS menu bar: yaggui, File, Edit, View, Window, Help (spec §6.9). */
export function buildAppMenu(locale: Locale): MenuSection[] {
  const t = (key: MessageKey) => translate(locale, key);
  const action = (id: ShellAction, key: MessageKey): MenuEntry => ({
    kind: 'action',
    id,
    label: t(key),
    shortcut: ACCELERATED.has(id) ? shortcutOf(id) : undefined,
  });
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
      label: t('menu.view'),
      entries: [
        action('toggleSidebar', 'menu.toggleSidebar'),
        action('toggleDetails', 'menu.toggleDetails'),
        action('toggleLog', 'menu.commandLog'),
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

/** Set once the menu is really in place: until then (or if it failed) the keyboard handles all. */
let menuInstalled = false;

/** Shortcuts the installed menu handles, which the keyboard handler must leave alone. */
export function menuShortcuts(): ReadonlySet<string> {
  if (!menuInstalled) return new Set();
  return new Set([...ACCELERATED].map(shortcutOf).filter((shortcut) => shortcut !== undefined));
}

function onMenuAction(id: string): void {
  if (!isShellAction(id)) return;
  // In a text field the menu item is the field's own undo: the app's applies elsewhere only.
  if ((id === 'undo' || id === 'redo') && forwardToTextEntry(id)) return;
  runShellAction(id);
}

let watching = false;

/** Installs the macOS menu and rebuilds it when the UI language changes. */
export async function installAppMenu(): Promise<void> {
  if (!nativeMenu.supported) return;
  await nativeMenu.install(buildAppMenu(useI18nStore.getState().locale), onMenuAction);
  // A failed rebuild later keeps the previous menu, with the same accelerators.
  menuInstalled = true;
  if (watching) return;
  watching = true;
  const rebuild = () => {
    void nativeMenu
      .install(buildAppMenu(useI18nStore.getState().locale), onMenuAction)
      .catch((error: unknown) => {
        console.warn('Could not rebuild the menu', error);
      });
  };
  useI18nStore.subscribe((state, previous) => {
    if (state.locale !== previous.locale) rebuild();
  });
  // Rebinding a menu shortcut (F-281) changes its accelerator.
  useKeybindings.subscribe((state, previous) => {
    if (state.overrides !== previous.overrides) rebuild();
  });
}
