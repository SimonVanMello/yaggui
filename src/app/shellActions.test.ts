import { afterEach, describe, expect, it } from 'vitest';

import { runShellAction, shortcutApplies, SHORTCUTS } from './shellActions';
import { useShellStore } from './shellStore';

afterEach(() => {
  document.body.innerHTML = '';
  useShellStore.setState({ logOpen: false, terminalDialogOpen: false });
});

describe('shell actions', () => {
  it('runs an action', () => {
    expect(runShellAction('toggleLog')).toBe(true);
    expect(useShellStore.getState().logOpen).toBe(true);
  });

  it('is ignored while a modal dialog is open', () => {
    document.body.innerHTML = '<div role="dialog" data-state="open"></div>';
    expect(runShellAction('toggleLog')).toBe(false);
    expect(useShellStore.getState().logOpen).toBe(false);
  });

  it('binds each shortcut once', () => {
    const shortcuts = SHORTCUTS.map((binding) => binding.shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(SHORTCUTS.find((binding) => binding.shortcut === 'Mod+9')?.action).toBe('tab9');
  });
});

describe('undo shortcuts', () => {
  it('binds undo and redo', () => {
    expect(SHORTCUTS.find((b) => b.shortcut === 'Mod+Z')?.action).toBe('undo');
    expect(SHORTCUTS.find((b) => b.shortcut === 'Mod+Shift+Z')?.action).toBe('redo');
    // Ctrl+Y (not on macOS) is a second binding of the registry: `edit.redoAlt`.
  });

  it('leaves them to text fields and code editors', () => {
    document.body.innerHTML =
      '<input id="i"><textarea id="t"></textarea><div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div><button id="b"></button>';
    for (const action of ['undo', 'redo'] as const) {
      expect(shortcutApplies(action, document.querySelector('#i'))).toBe(false);
      expect(shortcutApplies(action, document.querySelector('#t'))).toBe(false);
      expect(shortcutApplies(action, document.querySelector('.cm-content'))).toBe(false);
      expect(shortcutApplies(action, document.querySelector('#b'))).toBe(true);
      expect(shortcutApplies(action, document.body)).toBe(true);
    }
  });

  it('does not restrict the other shortcuts', () => {
    expect(shortcutApplies('newTab', document.createElement('input'))).toBe(true);
  });
});
