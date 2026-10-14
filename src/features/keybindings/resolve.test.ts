import { describe, expect, it } from 'vitest';

import {
  canonicalShortcut,
  captureShortcut,
  effectiveShortcut,
  findConflicts,
  shortcutKey,
} from './resolve';

function press(
  key: string,
  code: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe('canonicalShortcut', () => {
  it('orders modifiers and upper-cases letters', () => {
    expect(canonicalShortcut('Shift+Alt+Mod+k')).toBe('Mod+Alt+Shift+K');
    expect(canonicalShortcut('Mod+ArrowLeft')).toBe('Mod+ArrowLeft');
  });

  it('makes equivalent spellings compare equal', () => {
    expect(shortcutKey('Mod+Shift+Alt+S')).toBe(shortcutKey('Shift+Mod+Alt+s'));
  });
});

describe('effectiveShortcut', () => {
  it('prefers the override, including "no shortcut"', () => {
    expect(effectiveShortcut('a', 'Mod+A', {})).toBe('Mod+A');
    expect(effectiveShortcut('a', 'Mod+A', { a: 'Mod+B' })).toBe('Mod+B');
    expect(effectiveShortcut('a', 'Mod+A', { a: null })).toBeNull();
    expect(effectiveShortcut('a', null, { b: 'Mod+B' })).toBeNull();
  });
});

describe('captureShortcut', () => {
  it('maps ⌘ to Mod on macOS and Ctrl to Mod elsewhere', () => {
    const mac = captureShortcut(press('k', 'KeyK', { metaKey: true, shiftKey: true }), 'mac');
    expect(mac).toEqual({ kind: 'shortcut', shortcut: 'Mod+Shift+K' });
    const linux = captureShortcut(press('k', 'KeyK', { ctrlKey: true }), 'linux');
    expect(linux).toEqual({ kind: 'shortcut', shortcut: 'Mod+K' });
  });

  it('keeps the physical Control key on macOS', () => {
    const result = captureShortcut(press('Tab', 'Tab', { ctrlKey: true }), 'mac');
    expect(result).toEqual({ kind: 'shortcut', shortcut: 'Ctrl+Tab' });
  });

  it('waits on modifiers, cancels on Escape, refuses bare keys and the Windows key', () => {
    expect(captureShortcut(press('Meta', 'MetaLeft', { metaKey: true }), 'mac').kind).toBe(
      'pending',
    );
    expect(captureShortcut(press('Escape', 'Escape'), 'mac').kind).toBe('cancel');
    expect(captureShortcut(press('k', 'KeyK'), 'mac').kind).toBe('invalid');
    expect(captureShortcut(press('K', 'KeyK', { shiftKey: true }), 'mac').kind).toBe('invalid');
    expect(captureShortcut(press('k', 'KeyK', { metaKey: true }), 'linux').kind).toBe('invalid');
    expect(
      captureShortcut(press('+', 'Equal', { ctrlKey: true, shiftKey: true }), 'linux').kind,
    ).toBe('invalid');
  });

  it('accepts function keys alone and names the space bar', () => {
    expect(captureShortcut(press('F5', 'F5'), 'linux')).toEqual({
      kind: 'shortcut',
      shortcut: 'F5',
    });
    expect(captureShortcut(press(' ', 'Space', { ctrlKey: true }), 'linux')).toEqual({
      kind: 'shortcut',
      shortcut: 'Mod+Space',
    });
  });

  it('uses the key, not the layout character, for letters (Alt+letter on macOS)', () => {
    const result = captureShortcut(press('∫', 'KeyB', { metaKey: true, altKey: true }), 'mac');
    expect(result).toEqual({ kind: 'shortcut', shortcut: 'Mod+Alt+B' });
  });
});

describe('findConflicts', () => {
  it('groups commands that share a shortcut, whatever its spelling', () => {
    const conflicts = findConflicts(
      new Map<string, string | null>([
        ['a', 'Mod+Shift+K'],
        ['b', 'Shift+Mod+k'],
        ['c', 'Mod+K'],
        ['d', null],
        ['e', null],
      ]),
    );
    expect([...conflicts.values()]).toEqual([['a', 'b']]);
  });
});
