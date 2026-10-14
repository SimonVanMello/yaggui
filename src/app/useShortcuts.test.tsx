import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runUndo = vi.hoisted(() => vi.fn());
vi.mock('../features/undo/undoOps', () => ({ runUndo }));
vi.mock('../features/repo/repoSessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/repo/repoSessions')>()),
  activeRepoId: () => 7,
}));

import { registerBuiltinBindings } from '../features/keybindings/builtinBindings';
import { registerBuiltinActions } from '../features/palette/builtinActions';
import { useKeybindings } from '../features/keybindings/keybindingsStore';
import { shortcutOf } from './shellActions';
import { useShortcuts } from './useShortcuts';

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

let unregister: (() => void)[] = [];

beforeEach(() => {
  unregister = [registerBuiltinActions(), registerBuiltinBindings()];
});

afterEach(() => {
  for (const off of unregister) off();
  document.body.innerHTML = '';
  runUndo.mockClear();
});

describe('undo shortcuts', () => {
  it('undoes and redoes outside text fields', () => {
    renderHook(() => {
      useShortcuts();
    });
    const undo = press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(undo.defaultPrevented).toBe(true);
    expect(runUndo).toHaveBeenLastCalledWith(7, 'undo');
    press(document.body, { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    expect(runUndo).toHaveBeenLastCalledWith(7, 'redo');
    press(document.body, { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(runUndo).toHaveBeenLastCalledWith(7, 'redo');
    expect(runUndo).toHaveBeenCalledTimes(3);
  });

  it('never applies in a text field or a code editor', () => {
    renderHook(() => {
      useShortcuts();
    });
    document.body.innerHTML =
      '<input id="i"><textarea id="t"></textarea><div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>';
    for (const selector of ['#i', '#t', '.cm-content']) {
      const target = document.querySelector(selector);
      if (!target) throw new Error(selector);
      for (const init of [
        { key: 'z', code: 'KeyZ', ctrlKey: true },
        { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true },
        { key: 'y', code: 'KeyY', ctrlKey: true },
      ]) {
        // The field keeps the key: not prevented, nothing run.
        expect(press(target, init).defaultPrevented).toBe(false);
      }
    }
    expect(runUndo).not.toHaveBeenCalled();
  });

  it('follows a rebinding, still never in a text field, and the menu accelerator follows too', async () => {
    renderHook(() => {
      useShortcuts();
    });
    await useKeybindings.getState().set('edit.undo', 'Mod+Alt+U');
    expect(shortcutOf('undo')).toBe('Mod+Alt+U');
    expect(press(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(runUndo).not.toHaveBeenCalled();
    press(document.body, { key: 'u', code: 'KeyU', ctrlKey: true, altKey: true });
    expect(runUndo).toHaveBeenLastCalledWith(7, 'undo');
    document.body.innerHTML = '<input id="i">';
    const field = document.querySelector('#i');
    if (!field) throw new Error('#i');
    const inField = press(field, { key: 'u', code: 'KeyU', ctrlKey: true, altKey: true });
    expect(inField.defaultPrevented).toBe(false);
    expect(runUndo).toHaveBeenCalledTimes(1);
    await useKeybindings.getState().resetAll();
  });
});
