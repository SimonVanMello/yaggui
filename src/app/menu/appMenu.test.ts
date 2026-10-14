import { describe, expect, it } from 'vitest';

import { toAccelerator, type MenuEntry } from '../../ipc';
import { isShellAction } from '../shellActions';
import { buildAppMenu, menuShortcuts } from './appMenu';

function entries(locale: 'en' | 'fr', section: number): MenuEntry[] {
  return buildAppMenu(locale)[section]?.entries ?? [];
}

describe('macOS app menu', () => {
  it('has the standard menus', () => {
    expect(buildAppMenu('en').map((section) => section.label)).toEqual([
      'yaggui',
      'File',
      'Edit',
      'View',
      'Window',
      'Help',
    ]);
    expect(buildAppMenu('fr').map((section) => section.label)).toEqual([
      'yaggui',
      'Fichier',
      'Édition',
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
    // No native "Close Window" (⌘W) and no accelerator on ⌘1…9.
    expect(JSON.stringify(all)).not.toContain('CloseWindow');
    expect(
      all.some((entry) => entry.kind === 'action' && /^Mod\+\d$/.test(entry.shortcut ?? '')),
    ).toBe(false);
  });

  it('keeps native clipboard items in Edit', () => {
    const items = entries('fr', 2).flatMap((entry) =>
      entry.kind === 'native' ? [entry.item] : [],
    );
    expect(items).toEqual(['Cut', 'Copy', 'Paste', 'SelectAll']);
    expect(entries('fr', 2)).toContainEqual({ kind: 'native', item: 'Copy', label: 'Copier' });
  });

  it('only references existing shell actions', () => {
    for (const entry of buildAppMenu('en').flatMap((section) => section.entries)) {
      if (entry.kind === 'action') expect(isShellAction(entry.id)).toBe(true);
    }
  });

  it('owns no shortcut where there is no native menu', () => {
    expect(menuShortcuts().size).toBe(0);
  });

  it('converts shortcuts to accelerators', () => {
    expect(toAccelerator('Mod+Alt+B')).toBe('CmdOrCtrl+Alt+B');
    expect(toAccelerator('Mod+Shift+P')).toBe('CmdOrCtrl+Shift+P');
  });
});
