import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ipc, nativeWindow } from '../ipc';
import { mockBackend } from '../ipc/mockClient';
import { flushPersistence, persistTabs, resetTabsPersistence, restoreTabs } from './startup';
import { useTabsStore } from './tabs/tabsStore';

async function storedTabs() {
  const result = await mockBackend.commands.getTabs();
  if (result.status !== 'ok') throw new Error('getTabs failed');
  return result.data;
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: (() => void) | undefined;

beforeEach(() => {
  mockBackend.reset();
  useTabsStore.setState(useTabsStore.getInitialState());
  resetTabsPersistence({ hydrated: true });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('persistTabs', () => {
  it('saves a tab opened, moved or closed at once, without waiting for the delay', async () => {
    vi.useFakeTimers();
    stop = persistTabs();
    const second = useTabsStore.getState().newTab();
    await vi.advanceTimersByTimeAsync(0);
    expect((await storedTabs()).tabs.map((tab) => tab.id)).toContain(second);

    useTabsStore.getState().closeTab(second);
    await vi.advanceTimersByTimeAsync(0);
    expect((await storedTabs()).tabs.map((tab) => tab.id)).not.toContain(second);
  });

  it('delays a panel size change, and writes it when the window closes', async () => {
    vi.useFakeTimers();
    stop = persistTabs();
    const tabId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().setPanel(tabId, 'details', { size: 777 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await storedTabs()).tabs[0]?.uiState ?? '').not.toContain('777');

    await flushPersistence();
    expect((await storedTabs()).tabs[0]?.uiState).toContain('777');
  });

  it('keeps the stored session when it could not be read at startup', async () => {
    const before = await storedTabs();
    vi.spyOn(ipc.commands, 'getTabs').mockRejectedValueOnce(new Error('database locked'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetTabsPersistence();
    await restoreTabs();
    stop = persistTabs();
    useTabsStore.getState().newTab();
    await flushPromises();
    expect(await storedTabs()).toEqual(before);
  });
});

describe('nativeWindow.onCloseRequested (browser)', () => {
  it('runs the handler when the page unloads', () => {
    const handler = vi.fn(() => Promise.resolve());
    const unsubscribe = nativeWindow.onCloseRequested(handler);
    window.dispatchEvent(new Event('beforeunload'));
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    window.dispatchEvent(new Event('beforeunload'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
