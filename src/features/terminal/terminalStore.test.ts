import { beforeEach, describe, expect, it } from 'vitest';

import {
  clampTerminalHeight,
  hideTerminalPanel,
  repoTerminals,
  TERMINAL_HEIGHT,
  useTerminalStore,
} from './terminalStore';

const store = () => useTerminalStore.getState();

beforeEach(() => {
  useTerminalStore.setState({ height: TERMINAL_HEIGHT.default, repos: {} });
});

describe('terminal panel store', () => {
  it('is closed and empty for an unknown repository', () => {
    expect(repoTerminals(1)).toEqual({ open: false, tabs: [], activeId: null });
  });

  it('opens the panel on the terminal just added', () => {
    store().addTab(1, { id: 'a', title: '…' });
    store().addTab(1, { id: 'b', title: '…' });
    expect(repoTerminals(1)).toMatchObject({ open: true, activeId: 'b' });
    expect(repoTerminals(1).tabs.map((tab) => [tab.id, tab.status])).toEqual([
      ['a', 'starting'],
      ['b', 'starting'],
    ]);
  });

  it('keeps each repository apart', () => {
    store().addTab(1, { id: 'a', title: 'zsh' });
    store().addTab(2, { id: 'b', title: 'pwsh' });
    hideTerminalPanel(1);
    expect(repoTerminals(1).open).toBe(false);
    expect(repoTerminals(1).tabs).toHaveLength(1);
    expect(repoTerminals(2)).toMatchObject({ open: true, activeId: 'b' });
  });

  it('updates a terminal when its shell starts or exits', () => {
    store().addTab(1, { id: 'a', title: '…' });
    store().updateTab(1, 'a', { status: 'running', title: 'zsh' });
    store().updateTab(1, 'a', { status: 'exited', exitCode: 130 });
    expect(repoTerminals(1).tabs[0]).toMatchObject({
      title: 'zsh',
      status: 'exited',
      exitCode: 130,
    });
  });

  it('activates the neighbor of a closed terminal, and closes the panel with the last one', () => {
    for (const id of ['a', 'b', 'c']) store().addTab(1, { id, title: id });
    store().activate(1, 'b');
    store().removeTab(1, 'b');
    expect(repoTerminals(1).activeId).toBe('c');
    store().removeTab(1, 'c');
    expect(repoTerminals(1).activeId).toBe('a');
    // Closing an inactive terminal keeps the active one.
    store().addTab(1, { id: 'd', title: 'd' });
    store().removeTab(1, 'a');
    expect(repoTerminals(1).activeId).toBe('d');
    store().removeTab(1, 'd');
    expect(repoTerminals(1)).toEqual({ open: false, tabs: [], activeId: null });
  });

  it('ignores unknown terminals', () => {
    store().addTab(1, { id: 'a', title: 'a' });
    const before = repoTerminals(1);
    store().removeTab(1, 'zzz');
    store().activate(1, 'zzz');
    expect(repoTerminals(1)).toEqual(before);
  });

  it('forgets a closed repository', () => {
    store().addTab(1, { id: 'a', title: 'a' });
    store().forgetRepo(1);
    expect(store().repos[1]).toBeUndefined();
  });

  it('keeps a usable height', () => {
    store().setHeight(12);
    expect(store().height).toBe(TERMINAL_HEIGHT.min);
    store().setHeight(333.4);
    expect(store().height).toBe(333);
    expect(clampTerminalHeight(-5)).toBe(TERMINAL_HEIGHT.min);
  });
});
