import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAction,
  listActions,
  registerAction,
  registerActions,
  runAction,
  type PaletteAction,
} from './actionRegistry';

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function action(id: string, patch: Partial<PaletteAction> = {}): PaletteAction {
  return { id, title: 'palette.action.tab.new', group: 'tabs', run: () => undefined, ...patch };
}

describe('action registry', () => {
  it('registers, finds and unregisters an action by its stable id', () => {
    offs.push(registerAction(action('test.a')));
    expect(getAction('test.a')?.id).toBe('test.a');
    expect(listActions().map((a) => a.id)).toContain('test.a');
    offs.pop()?.();
    expect(getAction('test.a')).toBeUndefined();
  });

  it('replaces an action registered again under the same id', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerAction(action('test.b', { run: first }));
    offs.push(registerAction(action('test.b', { run: second })));
    runAction('test.b');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    // The stale unregister of the replaced action must not remove its successor.
    offFirst();
    expect(getAction('test.b')).toBeDefined();
  });

  it('does not run a disabled or unknown action', () => {
    const run = vi.fn();
    offs.push(registerAction(action('test.c', { enabled: () => false, run })));
    expect(runAction('test.c')).toBe(false);
    expect(runAction('test.unknown')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('evaluates enabled at run time', () => {
    let on = false;
    const run = vi.fn();
    offs.push(registerAction(action('test.d', { enabled: () => on, run })));
    expect(runAction('test.d')).toBe(false);
    on = true;
    expect(runAction('test.d')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('registers several actions at once', () => {
    offs.push(registerActions([action('test.e1'), action('test.e2')]));
    expect(getAction('test.e1')).toBeDefined();
    expect(getAction('test.e2')).toBeDefined();
  });
});
