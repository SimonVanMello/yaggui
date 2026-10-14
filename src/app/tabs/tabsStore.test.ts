import { describe, expect, it } from 'vitest';

import { DEFAULT_PANELS, parseTabUiState, serializeTabUiState } from '../layout/panels';
import { createTabsStore, selectActiveTab, toSavedTabs } from './tabsStore';

function storeWithRepos(...repoIds: number[]) {
  const store = createTabsStore();
  const first = store.getState().activeTabId;
  repoIds.forEach((repoId, index) => {
    const id = index === 0 ? first : store.getState().newTab();
    store.getState().setRepo(id, repoId);
  });
  return store;
}

const repoOrder = (store: ReturnType<typeof createTabsStore>) =>
  store.getState().tabs.map((tab) => tab.repoId);
const activeRepo = (store: ReturnType<typeof createTabsStore>) =>
  selectActiveTab(store.getState()).repoId;

describe('tabs store', () => {
  it('starts with a single welcome tab', () => {
    const store = createTabsStore();
    expect(store.getState().tabs).toHaveLength(1);
    expect(activeRepo(store)).toBeNull();
  });

  it('activates the right neighbor when closing the active tab, else the left one', () => {
    const store = storeWithRepos(1, 2, 3);
    store.getState().activateIndex(1);
    store.getState().closeTab(store.getState().activeTabId);
    expect(activeRepo(store)).toBe(3);
    store.getState().closeTab(store.getState().activeTabId);
    expect(activeRepo(store)).toBe(1);
  });

  it('keeps the active tab when closing another one', () => {
    const store = storeWithRepos(1, 2, 3);
    store.getState().activateIndex(0);
    store.getState().closeTab(store.getState().tabs[2]?.id ?? '');
    expect(activeRepo(store)).toBe(1);
  });

  it('replaces the last closed tab with a welcome tab', () => {
    const store = storeWithRepos(1);
    store.getState().closeTab(store.getState().activeTabId);
    expect(store.getState().tabs).toHaveLength(1);
    expect(activeRepo(store)).toBeNull();
  });

  it('selects the last tab with ⌘9 and cycles with ⌃Tab', () => {
    const store = storeWithRepos(1, 2, 3);
    store.getState().activateIndex(8);
    expect(activeRepo(store)).toBe(3);
    store.getState().activateRelative(1);
    expect(activeRepo(store)).toBe(1);
    store.getState().activateRelative(-1);
    expect(activeRepo(store)).toBe(3);
  });

  it('moves tabs within bounds', () => {
    const store = storeWithRepos(1, 2, 3);
    const first = store.getState().tabs[0]?.id ?? '';
    store.getState().moveTab(first, 2);
    expect(repoOrder(store)).toEqual([2, 3, 1]);
    store.getState().moveTab(first, 99);
    expect(repoOrder(store)).toEqual([2, 3, 1]);
    store.getState().moveTab(first, -5);
    expect(repoOrder(store)).toEqual([1, 2, 3]);
  });

  it('closes other tabs and tabs to the right', () => {
    const store = storeWithRepos(1, 2, 3, 4);
    store.getState().closeTabsToRight(store.getState().tabs[1]?.id ?? '');
    expect(repoOrder(store)).toEqual([1, 2]);
    store.getState().closeOtherTabs(store.getState().tabs[0]?.id ?? '');
    expect(repoOrder(store)).toEqual([1]);
  });

  it('round-trips through the saved state, dropping duplicate repositories', () => {
    const store = storeWithRepos(1, 2);
    store.getState().setPanel(store.getState().activeTabId, 'sidebar', { size: 300 });
    const saved = toSavedTabs(store.getState());

    const restored = createTabsStore();
    restored.getState().hydrate({
      ...saved,
      tabs: [...saved.tabs, { id: 'dup', repoId: 1, uiState: null }],
    });
    expect(repoOrder(restored)).toEqual([1, 2]);
    expect(restored.getState().activeTabId).toBe(saved.activeTabId);
    expect(selectActiveTab(restored.getState()).panels.sidebar.size).toBe(300);
  });

  it('ignores an empty saved state', () => {
    const store = createTabsStore();
    const before = store.getState().tabs;
    store.getState().hydrate({ tabs: [], activeTabId: null });
    expect(store.getState().tabs).toBe(before);
  });
});

describe('tab UI state parsing', () => {
  it('falls back to defaults on bad data', () => {
    expect(parseTabUiState(null)).toEqual(DEFAULT_PANELS);
    expect(parseTabUiState('not json')).toEqual(DEFAULT_PANELS);
    expect(parseTabUiState('{"panels":{"sidebar":{"size":"wide"}}}')).toEqual(DEFAULT_PANELS);
  });

  it('clamps sizes to the panel limits', () => {
    const json = serializeTabUiState({
      sidebar: { size: 5, collapsed: true },
      details: { size: 5000, collapsed: false },
    });
    expect(parseTabUiState(json)).toEqual({
      sidebar: { size: 160, collapsed: true },
      details: { size: 600, collapsed: false },
    });
  });
});

describe('fitPanels', () => {
  it('keeps saved sizes when they fit', async () => {
    const { fitPanels } = await import('../layout/panels');
    expect(fitPanels(DEFAULT_PANELS, 1400)).toEqual({ sidebar: 232, details: 320 });
  });

  it('shrinks the right panel first, then the left one, never below their minimum', async () => {
    const { fitPanels } = await import('../layout/panels');
    // 800 px: 72 px too many; the right panel gives 60 (down to 260), the left one 12.
    expect(fitPanels(DEFAULT_PANELS, 800)).toEqual({ sidebar: 220, details: 260 });
    expect(fitPanels(DEFAULT_PANELS, 600)).toEqual({ sidebar: 160, details: 260 });
  });

  it('ignores collapsed panels', async () => {
    const { fitPanels } = await import('../layout/panels');
    const panels = { ...DEFAULT_PANELS, details: { size: 320, collapsed: true } };
    expect(fitPanels(panels, 700)).toEqual({ sidebar: 232, details: 0 });
  });
});
