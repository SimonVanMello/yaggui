import { beforeEach, describe, expect, it } from 'vitest';

import { mockBackend } from '../../ipc/mockClient';
import { registerAction } from '../palette/actionRegistry';
import { registerBuiltinBindings } from './builtinBindings';
import { useKeybindings } from './keybindingsStore';
import {
  bindingConflicts,
  defaultShortcutOf,
  findGlobalBinding,
  listBindings,
  matchBinding,
  resolvedShortcut,
  runBinding,
} from './registry';

const key = (k: string, code: string, mods: object = {}) => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('keybindings registry', () => {
  let ran: string[];
  let unregister: (() => void)[];

  beforeEach(async () => {
    mockBackend.reset();
    await useKeybindings.getState().resetAll();
    ran = [];
    unregister = [
      registerBuiltinBindings(),
      registerAction({
        id: 'test.go',
        title: 'palette.action.tab.new',
        group: 'tabs',
        shortcut: 'Mod+Shift+9',
        run: () => ran.push('go'),
      }),
      registerAction({
        id: 'test.noshortcut',
        title: 'palette.action.tab.close',
        group: 'tabs',
        run: () => ran.push('plain'),
      }),
    ];
    return () => {
      for (const off of unregister) off();
    };
  });

  it('lists the palette actions and the shortcut-only commands', () => {
    const ids = listBindings().map((b) => b.id);
    expect(ids).toEqual(
      expect.arrayContaining(['test.go', 'test.noshortcut', 'app.palette', 'graph.search']),
    );
    expect(defaultShortcutOf('test.go')).toBe('Mod+Shift+9');
    expect(defaultShortcutOf('test.noshortcut')).toBeNull();
  });

  it('runs a command from its default shortcut, then from the rebound one only', async () => {
    expect(findGlobalBinding(key('9', 'Digit9', { shiftKey: true }))).toBe('test.go');
    await useKeybindings.getState().set('test.go', 'Mod+Alt+G');
    expect(resolvedShortcut('test.go')).toBe('Mod+Alt+G');
    expect(findGlobalBinding(key('9', 'Digit9', { shiftKey: true }))).toBeNull();
    const id = findGlobalBinding(key('g', 'KeyG', { altKey: true }));
    expect(id).toBe('test.go');
    runBinding('test.go');
    expect(ran).toEqual(['go']);
  });

  it('lets any palette action get a shortcut', async () => {
    await useKeybindings.getState().set('test.noshortcut', 'F6');
    expect(findGlobalBinding(key('F6', 'F6', { ctrlKey: false }))).toBe('test.noshortcut');
  });

  it('removing a shortcut unbinds it, and the default comes back on reset', async () => {
    await useKeybindings.getState().set('test.go', null);
    expect(resolvedShortcut('test.go')).toBeNull();
    expect(findGlobalBinding(key('9', 'Digit9', { shiftKey: true }))).toBeNull();
    await useKeybindings.getState().reset('test.go');
    expect(resolvedShortcut('test.go')).toBe('Mod+Shift+9');
  });

  it('context shortcuts are matched by their owner, not by the global handler', async () => {
    const copy = key('c', 'KeyC');
    expect(matchBinding(copy, 'graph.copySha')).toBe(true);
    expect(findGlobalBinding(copy)).toBeNull();
    await useKeybindings.getState().set('graph.copySha', 'Mod+Alt+C');
    expect(matchBinding(copy, 'graph.copySha')).toBe(false);
    expect(matchBinding(key('c', 'KeyC', { altKey: true }), 'graph.copySha')).toBe(true);
  });

  it('reports shortcuts shared by two commands', async () => {
    expect(bindingConflicts().size).toBe(0);
    await useKeybindings.getState().set('test.noshortcut', 'Mod+Shift+9');
    const shared = [...bindingConflicts().values()];
    expect(shared).toHaveLength(1);
    expect(shared[0]).toEqual(expect.arrayContaining(['test.go', 'test.noshortcut']));
  });

  it('persists to keybindings.json through the backend', async () => {
    await useKeybindings.getState().set('test.go', 'Mod+Alt+G');
    const file = await mockBackend.commands.getKeybindings();
    expect(file).toMatchObject({
      status: 'ok',
      data: { overrides: [{ action: 'test.go', shortcut: 'Mod+Alt+G' }] },
    });
    useKeybindings.setState({ overrides: {} });
    await useKeybindings.getState().load();
    expect(useKeybindings.getState().overrides).toEqual({ 'test.go': 'Mod+Alt+G' });
  });

  it('puts the previous bindings back when the backend refuses', async () => {
    await useKeybindings.getState().set('test.go', 'Hyper+G');
    expect(useKeybindings.getState().overrides).toEqual({});
  });
});

describe('actions that answer while disabled', () => {
  it('runs them from the keyboard even when the palette lists them greyed out', () => {
    const ran: string[] = [];
    const off = registerAction({
      id: 'test.blocked',
      title: 'palette.action.edit.undo',
      group: 'git',
      enabled: () => false,
      runWhenDisabled: true,
      run: () => ran.push('answered'),
    });
    const off2 = registerAction({
      id: 'test.off',
      title: 'palette.action.edit.redo',
      group: 'git',
      enabled: () => false,
      run: () => ran.push('ran'),
    });
    expect(runBinding('test.blocked')).toBe(true);
    expect(runBinding('test.off')).toBe(false);
    expect(ran).toEqual(['answered']);
    off();
    off2();
  });
});
