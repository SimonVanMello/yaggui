import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';

/** Items whose behavior is implemented by the OS (clipboard, window, app). */
export type NativeMenuItem =
  | 'About'
  | 'Services'
  | 'Hide'
  | 'HideOthers'
  | 'ShowAll'
  | 'Quit'
  | 'Undo'
  | 'Redo'
  | 'Cut'
  | 'Copy'
  | 'Paste'
  | 'SelectAll'
  | 'Minimize'
  | 'Maximize'
  | 'Fullscreen'
  | 'BringAllToFront';

export type MenuEntry =
  /**
   * Runs `onAction(id)`; `shortcut` uses the app notation (`Mod+Shift+K`). `enabled` defaults
   * to `true`; [`NativeMenu.setEnabled`] changes it without a rebuild.
   */
  | { kind: 'action'; id: string; label: string; shortcut?: string; enabled?: boolean }
  | { kind: 'native'; item: NativeMenuItem; label: string }
  | { kind: 'submenu'; label: string; entries: MenuEntry[] }
  | { kind: 'separator' };

export interface MenuSection {
  label: string;
  entries: MenuEntry[];
  /** macOS: the Window menu gets the window list, the Help menu the search field. */
  role?: 'window' | 'help';
}

/** Application menu bar. Only macOS has one (spec §6.9); elsewhere `install` does nothing. */
export interface NativeMenu {
  readonly supported: boolean;
  install: (sections: MenuSection[], onAction: (id: string) => void) => Promise<void>;
  /** Enables or greys out the action items of the installed menu that have one of `ids`. */
  setEnabled: (ids: readonly string[], enabled: boolean) => Promise<void>;
}

/** `Mod+Alt+B` → `CmdOrCtrl+Alt+B` (Tauri accelerator syntax). */
export function toAccelerator(shortcut: string): string {
  return shortcut
    .split('+')
    .map((key) => (key === 'Mod' ? 'CmdOrCtrl' : key))
    .join('+');
}

let installed: Menu | null = null;
/** Action items of the installed menu by id (an id can appear in two menus). */
let installedItems = new Map<string, MenuItem[]>();

type ItemsById = Map<string, MenuItem[]>;

async function createEntry(
  entry: MenuEntry,
  onAction: (id: string) => void,
  byId: ItemsById,
): Promise<MenuItem | PredefinedMenuItem | Submenu> {
  switch (entry.kind) {
    case 'separator':
      return PredefinedMenuItem.new({ item: 'Separator' });
    case 'native':
      return PredefinedMenuItem.new({
        item: entry.item === 'About' ? { About: null } : entry.item,
        text: entry.label,
      });
    case 'submenu':
      return Submenu.new({
        text: entry.label,
        items: await Promise.all(entry.entries.map((child) => createEntry(child, onAction, byId))),
      });
    case 'action': {
      const item = await MenuItem.new({
        id: entry.id,
        text: entry.label,
        enabled: entry.enabled ?? true,
        accelerator: entry.shortcut ? toAccelerator(entry.shortcut) : undefined,
        action: onAction,
      });
      byId.set(entry.id, [...(byId.get(entry.id) ?? []), item]);
      return item;
    }
  }
}

const tauriMenu: NativeMenu = {
  supported: /Mac/i.test(navigator.userAgent),
  async install(sections, onAction) {
    if (!this.supported) return;
    const byId: ItemsById = new Map();
    const submenus = await Promise.all(
      sections.map(async (section) => {
        const items = await Promise.all(
          section.entries.map((entry) => createEntry(entry, onAction, byId)),
        );
        const submenu = await Submenu.new({ text: section.label, items });
        if (section.role === 'window') await submenu.setAsWindowsMenuForNSApp();
        if (section.role === 'help') await submenu.setAsHelpMenuForNSApp();
        return submenu;
      }),
    );
    const menu = await Menu.new({ items: submenus });
    await menu.setAsAppMenu();
    // Rebuilt on every language, shortcut or recent repositories change: release the previous
    // native menu.
    const previous = installed;
    installed = menu;
    installedItems = byId;
    await previous?.close();
  },
  async setEnabled(ids, enabled) {
    const items = ids.flatMap((id) => installedItems.get(id) ?? []);
    await Promise.all(items.map((item) => item.setEnabled(enabled)));
  },
};

const browserMenu: NativeMenu = {
  supported: false,
  install: () => Promise.resolve(),
  setEnabled: () => Promise.resolve(),
};

export const nativeMenu: NativeMenu = import.meta.env.VITE_MOCK === '1' ? browserMenu : tauriMenu;
