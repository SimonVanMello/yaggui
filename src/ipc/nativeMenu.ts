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
  /** Runs `onAction(id)`; `shortcut` uses the app notation (`Mod+Shift+K`). */
  | { kind: 'action'; id: string; label: string; shortcut?: string }
  | { kind: 'native'; item: NativeMenuItem; label: string }
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
}

/** `Mod+Alt+B` → `CmdOrCtrl+Alt+B` (Tauri accelerator syntax). */
export function toAccelerator(shortcut: string): string {
  return shortcut
    .split('+')
    .map((key) => (key === 'Mod' ? 'CmdOrCtrl' : key))
    .join('+');
}

let installed: Menu | null = null;

async function createEntry(entry: MenuEntry, onAction: (id: string) => void) {
  switch (entry.kind) {
    case 'separator':
      return PredefinedMenuItem.new({ item: 'Separator' });
    case 'native':
      return PredefinedMenuItem.new({
        item: entry.item === 'About' ? { About: null } : entry.item,
        text: entry.label,
      });
    case 'action':
      return MenuItem.new({
        id: entry.id,
        text: entry.label,
        accelerator: entry.shortcut ? toAccelerator(entry.shortcut) : undefined,
        action: onAction,
      });
  }
}

const tauriMenu: NativeMenu = {
  supported: /Mac/i.test(navigator.userAgent),
  async install(sections, onAction) {
    if (!this.supported) return;
    const submenus = await Promise.all(
      sections.map(async (section) => {
        const items = await Promise.all(
          section.entries.map((entry) => createEntry(entry, onAction)),
        );
        const submenu = await Submenu.new({ text: section.label, items });
        if (section.role === 'window') await submenu.setAsWindowsMenuForNSApp();
        if (section.role === 'help') await submenu.setAsHelpMenuForNSApp();
        return submenu;
      }),
    );
    const menu = await Menu.new({ items: submenus });
    await menu.setAsAppMenu();
    // Rebuilt on every language change: release the previous native menu.
    const previous = installed;
    installed = menu;
    await previous?.close();
  },
};

const browserMenu: NativeMenu = {
  supported: false,
  install: () => Promise.resolve(),
};

export const nativeMenu: NativeMenu = import.meta.env.VITE_MOCK === '1' ? browserMenu : tauriMenu;
