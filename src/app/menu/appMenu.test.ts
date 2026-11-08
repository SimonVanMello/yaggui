import { describe, expect, it } from 'vitest';

import { getAction } from '../../features/palette/actionRegistry';
import { registerBuiltinActions } from '../../features/palette/builtinActions';
import { toAccelerator, type KnownRepo, type MenuEntry, type MenuSection } from '../../ipc';
import { isShellAction } from '../shellActions';
import {
  buildAppMenu,
  menuShortcuts,
  RECENT_PREFIX,
  REGISTRY_ITEMS,
  REPO_ITEMS,
  type MenuContext,
} from './appMenu';
import { recentRepos, RECENT_MAX } from './recentRepos';

function entries(locale: 'en' | 'fr', section: number, context?: MenuContext): MenuEntry[] {
  return buildAppMenu(locale, context)[section]?.entries ?? [];
}

function section(menu: MenuSection[], label: string): MenuEntry[] {
  return menu.find((candidate) => candidate.label === label)?.entries ?? [];
}

function actions(list: MenuEntry[]): Extract<MenuEntry, { kind: 'action' }>[] {
  return list.flatMap((entry) => {
    if (entry.kind === 'action') return [entry];
    if (entry.kind === 'submenu') return actions(entry.entries);
    return [];
  });
}

function known(id: number, name: string, extra: Partial<KnownRepo> = {}): KnownRepo {
  return {
    id,
    path: `/work/${String(id)}/${name}`,
    name,
    favorite: false,
    lastOpenedAt: 1000 + id,
    exists: true,
    ...extra,
  };
}

function openRecent(context: MenuContext): MenuEntry[] {
  const file = entries('en', 1, context);
  const submenu = file.find((entry) => entry.kind === 'submenu');
  return submenu?.kind === 'submenu' ? submenu.entries : [];
}

describe('macOS app menu', () => {
  it('has the standard menus', () => {
    expect(buildAppMenu('en').map((section) => section.label)).toEqual([
      'yaggui',
      'File',
      'Edit',
      'Repository',
      'View',
      'Window',
      'Help',
    ]);
    expect(buildAppMenu('fr').map((section) => section.label)).toEqual([
      'yaggui',
      'Fichier',
      'Édition',
      'Dépôt',
      'Présentation',
      'Fenêtre',
      'Aide',
    ]);
  });

  it('routes ⌘T, ⌘O and ⌘W to the yaggui tabs, never to the window', () => {
    const file = entries('en', 1);
    expect(file).toContainEqual({
      kind: 'action',
      id: 'newTab',
      label: 'New Tab',
      shortcut: 'Mod+T',
    });
    expect(file).toContainEqual({
      kind: 'action',
      id: 'closeTab',
      label: 'Close Tab',
      shortcut: 'Mod+W',
    });
    const all = buildAppMenu('en').flatMap((section) => section.entries);
    expect(all.some((entry) => entry.kind === 'native' && entry.item === 'Maximize')).toBe(true);
    // No native "Close Window" (⌘W) and no accelerator on ⌘1…9 (⌘0 is Actual Size).
    expect(JSON.stringify(all)).not.toContain('CloseWindow');
    expect(
      all.some((entry) => entry.kind === 'action' && /^Mod\+[1-9]$/.test(entry.shortcut ?? '')),
    ).toBe(false);
  });

  it('keeps native clipboard items in Edit', () => {
    const items = entries('fr', 2).flatMap((entry) =>
      entry.kind === 'native' ? [entry.item] : [],
    );
    expect(items).toEqual(['Cut', 'Copy', 'Paste', 'SelectAll']);
    expect(entries('fr', 2)).toContainEqual({ kind: 'native', item: 'Copy', label: 'Copier' });
  });

  it('only references shell actions, palette actions and recent repositories', () => {
    const off = registerBuiltinActions();
    const menu = buildAppMenu('en', { recents: [known(1, 'alpha')], hasRepo: true });
    for (const entry of actions(menu.flatMap((candidate) => candidate.entries))) {
      const listed =
        isShellAction(entry.id) ||
        getAction(entry.id) !== undefined ||
        entry.id.startsWith(RECENT_PREFIX);
      expect(listed, entry.id).toBe(true);
    }
    for (const id of REGISTRY_ITEMS) expect(getAction(id), id).toBeDefined();
    off();
  });

  it('lists the recent repositories under File › Open Recent, missing folders greyed out', () => {
    const recents = [known(3, 'api'), known(2, 'web', { exists: false }), known(1, 'api')];
    const items = actions(openRecent({ recents, hasRepo: false }));
    expect(items.map((item) => item.id)).toEqual(recents.map((repo) => `recent:${repo.path}`));
    expect(items.map((item) => item.enabled)).toEqual([true, false, true]);
    // Two repositories with the same name show their path.
    expect(items[0]?.label).toBe('api — /work/3/api');
    expect(items[1]?.label).toBe('web');
    // After Init, before Close Tab.
    const file = entries('en', 1, { recents, hasRepo: false });
    const at = file.findIndex((entry) => entry.kind === 'submenu');
    expect(file[at - 1]).toMatchObject({ id: 'initRepo' });
    expect(file[at]).toMatchObject({ label: 'Open Recent' });
  });

  it('shows a greyed out placeholder when there is no recent repository', () => {
    expect(openRecent({ recents: [], hasRepo: false })).toEqual([
      { kind: 'action', id: 'recent', label: 'No Recent Repositories', enabled: false },
    ]);
  });

  it('keeps the 10 most recently opened repositories, favorites or not', () => {
    const list = Array.from({ length: 14 }, (_, i) => known(i + 1, `r${String(i + 1)}`));
    const imported = known(99, 'imported', { lastOpenedAt: 0 });
    const favorite = known(50, 'old', { lastOpenedAt: 1, favorite: true });
    const recents = recentRepos([imported, favorite, ...list]);
    expect(recents).toHaveLength(RECENT_MAX);
    expect(recents.map((repo) => repo.name)).toEqual([
      'r14',
      'r13',
      'r12',
      'r11',
      'r10',
      'r9',
      'r8',
      'r7',
      'r6',
      'r5',
    ]);
  });

  it('has a Repository menu, greyed out without a repository', () => {
    const items = (hasRepo: boolean) =>
      actions(section(buildAppMenu('en', { recents: [], hasRepo }), 'Repository'));
    expect(items(true).map((item) => item.id)).toEqual(REPO_ITEMS);
    expect(items(false).every((item) => item.enabled === false)).toBe(true);
    expect(items(true).every((item) => item.enabled === true)).toBe(true);
    expect(items(true).map((item) => item.label)).toEqual([
      'Fetch',
      'Pull',
      'Push',
      'New Branch…',
      'New Tag…',
      'Stash',
      'Pop Stash',
      'Open in Terminal',
      'Open in Editor',
      'Open in File Manager',
      'Operation History',
    ]);
    const shortcuts = Object.fromEntries(items(true).map((item) => [item.id, item.shortcut]));
    expect(shortcuts).toMatchObject({
      fetch: 'Mod+Shift+F',
      pull: 'Mod+Shift+L',
      push: 'Mod+Shift+P',
      createBranch: 'Mod+B',
      stash: 'Mod+Shift+S',
      stashPop: 'Mod+Shift+Alt+S',
      createTag: undefined,
      opHistory: undefined,
    });
  });

  it('zooms from the View menu with ⌘=, ⌘- and ⌘0', () => {
    const view = actions(section(buildAppMenu('fr'), 'Présentation'));
    expect(view).toEqual(
      expect.arrayContaining([
        { kind: 'action', id: 'zoomIn', label: 'Zoom avant', shortcut: 'Mod+=' },
        { kind: 'action', id: 'zoomOut', label: 'Zoom arrière', shortcut: 'Mod+-' },
        { kind: 'action', id: 'zoomReset', label: 'Taille réelle', shortcut: 'Mod+0' },
      ]),
    );
  });

  it('owns no shortcut where there is no native menu', () => {
    expect(menuShortcuts().size).toBe(0);
  });

  it('converts shortcuts to accelerators', () => {
    expect(toAccelerator('Mod+Alt+B')).toBe('CmdOrCtrl+Alt+B');
    expect(toAccelerator('Mod+Shift+P')).toBe('CmdOrCtrl+Shift+P');
  });
});
