import { describe, expect, it } from 'vitest';

import { DEFAULT_PANELS, parseTabUiState, serializeTabUiState } from '../layout/panels';
import { CLOSED_TABS_KEPT, createTabsStore, selectActiveTab, toSavedTabs } from './tabsStore';

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

describe('closed tabs', () => {
  const tabAt = (store: ReturnType<typeof createTabsStore>, index: number) =>
    store.getState().tabs[index]?.id ?? '';

  it('remembers closed repository tabs, most recent last, and never welcome tabs', () => {
    const store = storeWithRepos(1, 2, 3);
    store.getState().newTab();
    store.getState().closeTab(tabAt(store, 3));
    store.getState().closeTab(tabAt(store, 0));
    store.getState().closeTab(tabAt(store, 1));
    expect(store.getState().closedTabs).toEqual([
      { repoId: 1, index: 0, pinned: false },
      { repoId: 3, index: 1, pinned: false },
    ]);
    expect(store.getState().popClosedTab()?.repoId).toBe(3);
    expect(store.getState().popClosedTab()?.repoId).toBe(1);
    expect(store.getState().popClosedTab()).toBeUndefined();
  });

  it(`keeps the last ${String(CLOSED_TABS_KEPT)} closed tabs`, () => {
    const ids = Array.from({ length: CLOSED_TABS_KEPT + 2 }, (_, i) => i + 1);
    const store = storeWithRepos(...ids);
    for (let i = 0; i < ids.length; i += 1) store.getState().closeTab(tabAt(store, 0));
    const closed = store.getState().closedTabs;
    expect(closed).toHaveLength(CLOSED_TABS_KEPT);
    expect(closed.at(-1)?.repoId).toBe(ids.at(-1));
    expect(closed[0]?.repoId).toBe(3);
  });

  it('brings tabs closed together back one by one, each at its former index', () => {
    const store = storeWithRepos(1, 2, 3, 4, 5);
    store.getState().closeOtherTabs(tabAt(store, 2));
    expect(repoOrder(store)).toEqual([3]);
    // Leftmost first: every former index is valid again when its turn comes.
    const order: (number | undefined)[] = [];
    for (
      let entry = store.getState().popClosedTab();
      entry;
      entry = store.getState().popClosedTab()
    ) {
      order.push(entry.repoId);
      const id = store.getState().newTab();
      store.getState().setRepo(id, entry.repoId);
      store.getState().placeReopened(id, entry);
    }
    expect(order).toEqual([1, 2, 4, 5]);
    expect(repoOrder(store)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reopens at the end of its group when the former index no longer fits', () => {
    const store = storeWithRepos(1, 2);
    const reopen = (repoId: number, index: number) => {
      const id = store.getState().newTab();
      store.getState().setRepo(id, repoId);
      store.getState().placeReopened(id, { repoId, index, pinned: false });
    };
    reopen(3, 9);
    expect(repoOrder(store)).toEqual([1, 2, 3]);
    // Pinned tabs now hold index 0: an unpinned tab goes after every tab instead.
    store.getState().setPinned(tabAt(store, 0), true);
    reopen(4, 0);
    expect(repoOrder(store)).toEqual([1, 2, 3, 4]);
    expect(store.getState().tabs.map((tab) => tab.pinned)).toEqual([true, false, false, false]);
  });

  it('forgets a closed tab whose repository opens again', () => {
    const store = storeWithRepos(1, 2);
    store.getState().closeTab(tabAt(store, 1));
    expect(store.getState().closedTabs).toHaveLength(1);
    store.getState().setRepo(store.getState().newTab(), 2);
    expect(store.getState().closedTabs).toEqual([]);
  });

  it('reopens a pinned tab among the pinned ones', () => {
    const store = storeWithRepos(1, 2, 3);
    store.getState().setPinned(tabAt(store, 0), true);
    store.getState().setPinned(tabAt(store, 1), true);
    store.getState().closeTab(tabAt(store, 1));
    const entry = store.getState().popClosedTab();
    expect(entry).toEqual({ repoId: 2, index: 1, pinned: true });
    const id = store.getState().newTab();
    store.getState().setRepo(id, 2);
    if (entry) store.getState().placeReopened(id, entry);
    expect(repoOrder(store)).toEqual([1, 2, 3]);
    expect(store.getState().tabs.map((tab) => tab.pinned)).toEqual([true, true, false]);
  });
});

describe('pinned tabs', () => {
  const tabAt = (store: ReturnType<typeof createTabsStore>, index: number) =>
    store.getState().tabs[index]?.id ?? '';
  const pinnedFlags = (store: ReturnType<typeof createTabsStore>) =>
    store.getState().tabs.map((tab) => tab.pinned);

  it('moves a pinned tab after the pinned ones, an unpinned one right after them', () => {
    const store = storeWithRepos(1, 2, 3, 4);
    store.getState().setPinned(tabAt(store, 2), true);
    expect(repoOrder(store)).toEqual([3, 1, 2, 4]);
    store.getState().setPinned(tabAt(store, 3), true);
    expect(repoOrder(store)).toEqual([3, 4, 1, 2]);
    expect(pinnedFlags(store)).toEqual([true, true, false, false]);
    store.getState().setPinned(tabAt(store, 0), false);
    expect(repoOrder(store)).toEqual([4, 3, 1, 2]);
    expect(pinnedFlags(store)).toEqual([true, false, false, false]);
  });

  it('never pins a welcome tab', () => {
    const store = createTabsStore();
    store.getState().setPinned(store.getState().activeTabId, true);
    expect(pinnedFlags(store)).toEqual([false]);
  });

  it('keeps drags and moves within the group', () => {
    const store = storeWithRepos(1, 2, 3, 4);
    store.getState().setPinned(tabAt(store, 0), true);
    store.getState().setPinned(tabAt(store, 1), true);
    // An unpinned tab cannot go before a pinned one.
    store.getState().moveTab(tabAt(store, 3), 0);
    expect(repoOrder(store)).toEqual([1, 2, 4, 3]);
    // A pinned tab cannot leave its group.
    store.getState().moveTab(tabAt(store, 0), 3);
    expect(repoOrder(store)).toEqual([2, 1, 4, 3]);
    store.getState().moveTab(tabAt(store, 1), 0);
    expect(repoOrder(store)).toEqual([1, 2, 4, 3]);
  });

  it('survives "close others" and "close to the right"; ⌘W still closes it', () => {
    const store = storeWithRepos(1, 2, 3, 4);
    store.getState().setPinned(tabAt(store, 3), true);
    expect(repoOrder(store)).toEqual([4, 1, 2, 3]);
    store.getState().closeTabsToRight(tabAt(store, 0));
    expect(repoOrder(store)).toEqual([4]);
    const reopened = storeWithRepos(1, 2, 3);
    reopened.getState().setPinned(tabAt(reopened, 2), true);
    reopened.getState().activateIndex(2);
    reopened.getState().closeOtherTabs(tabAt(reopened, 2));
    expect(repoOrder(reopened)).toEqual([3, 2]);
    expect(activeRepo(reopened)).toBe(2);
    reopened.getState().closeTab(tabAt(reopened, 0));
    expect(repoOrder(reopened)).toEqual([2]);
  });

  it('counts pinned tabs in ⌘1…9', () => {
    const store = storeWithRepos(1, 2, 3);
    store.getState().setPinned(tabAt(store, 2), true);
    store.getState().activateIndex(0);
    expect(activeRepo(store)).toBe(3);
    store.getState().activateIndex(1);
    expect(activeRepo(store)).toBe(1);
  });

  it('round-trips the pinned flag and restores pinned tabs first', () => {
    const store = storeWithRepos(1, 2);
    store.getState().setPinned(tabAt(store, 1), true);
    const saved = toSavedTabs(store.getState());
    expect(saved.tabs.map((tab) => tab.pinned)).toEqual([true, false]);

    const restored = createTabsStore();
    restored.getState().hydrate({
      tabs: [
        { id: 'a', repoId: 1, uiState: null },
        { id: 'b', repoId: 2, uiState: null, pinned: true },
        { id: 'c', repoId: null, uiState: null, pinned: true },
      ],
      activeTabId: 'a',
    });
    expect(repoOrder(restored)).toEqual([2, 1, null]);
    expect(pinnedFlags(restored)).toEqual([true, false, false]);
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
