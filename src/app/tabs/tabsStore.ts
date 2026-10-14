import { create } from 'zustand';

import {
  DEFAULT_COLUMNS,
  parseGraphColumns,
  type GraphColumns,
} from '../../features/graph/columns';
import {
  DEFAULT_SIDEBAR_UI,
  parseSidebarUiState,
  type SidebarUiState,
} from '../../features/sidebar/sidebarUiState';
import type { TabsState } from '../../ipc';
import {
  DEFAULT_PANELS,
  parseTabUiState,
  serializeTabUiState,
  type PanelId,
  type PanelState,
  type TabPanels,
} from '../layout/panels';

export interface ShellTab {
  id: string;
  /** `null` for a new tab (welcome screen). */
  repoId: number | null;
  panels: TabPanels;
  sidebar: SidebarUiState;
  columns: GraphColumns;
}

interface TabsStore {
  tabs: ShellTab[];
  activeTabId: string;
  /** Replaces every tab with the saved state (startup restoration). */
  hydrate: (saved: TabsState) => void;
  /** Opens a welcome tab at the end and activates it. Returns its id. */
  newTab: () => string;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  activate: (id: string) => void;
  /** `⌘1…8` select by position, `⌘9` always selects the last tab (browser convention). */
  activateIndex: (index: number) => void;
  /** Cycles through tabs (`⌃Tab` / `⌃⇧Tab`). */
  activateRelative: (delta: number) => void;
  moveTab: (id: string, toIndex: number) => void;
  setRepo: (id: string, repoId: number | null) => void;
  setPanel: (id: string, panel: PanelId, patch: Partial<PanelState>) => void;
  /** Updates the refs sidebar state of a tab (expanded nodes, flat list, recent branches). */
  updateSidebar: (id: string, update: (state: SidebarUiState) => SidebarUiState) => void;
  setColumns: (id: string, columns: GraphColumns) => void;
}

let counter = 0;
function newTabId(): string {
  counter += 1;
  return `tab-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function welcomeTab(): ShellTab {
  return {
    id: newTabId(),
    repoId: null,
    panels: DEFAULT_PANELS,
    columns: DEFAULT_COLUMNS,
    sidebar: DEFAULT_SIDEBAR_UI,
  };
}

/** Tab to activate when `closing` is closed: its right neighbor, else its left one. */
function neighborOf(tabs: ShellTab[], closingIndex: number): ShellTab | undefined {
  return tabs[closingIndex + 1] ?? tabs[closingIndex - 1];
}

export function createTabsStore() {
  const initial = welcomeTab();
  return create<TabsStore>()((set, get) => ({
    tabs: [initial],
    activeTabId: initial.id,

    hydrate: (saved) => {
      // One tab per repository (F-004): drop duplicates a corrupted save could contain.
      const seen = new Set<number>();
      const tabs = saved.tabs
        .filter((tab) => {
          if (tab.repoId === null) return true;
          if (seen.has(tab.repoId)) return false;
          seen.add(tab.repoId);
          return true;
        })
        .map((tab) => ({
          id: tab.id || newTabId(),
          repoId: tab.repoId,
          panels: parseTabUiState(tab.uiState),
          sidebar: parseSidebarUiState(tab.uiState),
          columns: parseGraphColumns(tab.uiState),
        }));
      if (tabs.length === 0) return;
      const active = tabs.find((tab) => tab.id === saved.activeTabId) ?? tabs[0];
      set({ tabs, activeTabId: active?.id ?? get().activeTabId });
    },

    newTab: () => {
      const tab = welcomeTab();
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      return tab.id;
    },

    closeTab: (id) => {
      const { tabs, activeTabId } = get();
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const remaining = tabs.filter((tab) => tab.id !== id);
      if (remaining.length === 0) {
        // The window always keeps a tab: closing the last one leaves a welcome screen.
        const tab = welcomeTab();
        set({ tabs: [tab], activeTabId: tab.id });
        return;
      }
      const nextActive = activeTabId === id ? neighborOf(tabs, index)?.id : activeTabId;
      set({ tabs: remaining, activeTabId: nextActive ?? remaining[0]?.id ?? activeTabId });
    },

    closeOtherTabs: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab) set({ tabs: [tab], activeTabId: tab.id });
    },

    closeTabsToRight: (id) => {
      const { tabs, activeTabId } = get();
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const kept = tabs.slice(0, index + 1);
      set({ tabs: kept, activeTabId: kept.some((t) => t.id === activeTabId) ? activeTabId : id });
    },

    activate: (id) => {
      if (get().tabs.some((tab) => tab.id === id)) set({ activeTabId: id });
    },

    activateIndex: (index) => {
      const { tabs } = get();
      const tab = index >= 8 ? tabs.at(-1) : tabs[index];
      if (tab) set({ activeTabId: tab.id });
    },

    activateRelative: (delta) => {
      const { tabs, activeTabId } = get();
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      if (next) set({ activeTabId: next.id });
    },

    moveTab: (id, toIndex) => {
      const { tabs } = get();
      const from = tabs.findIndex((tab) => tab.id === id);
      const tab = tabs[from];
      const to = Math.max(0, Math.min(tabs.length - 1, toIndex));
      if (!tab || from === to) return;
      const next = tabs.filter((t) => t.id !== id);
      next.splice(to, 0, tab);
      set({ tabs: next });
    },

    setRepo: (id, repoId) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, repoId } : tab)),
      }));
    },

    setPanel: (id, panel, patch) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? { ...tab, panels: { ...tab.panels, [panel]: { ...tab.panels[panel], ...patch } } }
            : tab,
        ),
      }));
    },

    updateSidebar: (id, update) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id ? { ...tab, sidebar: update(tab.sidebar) } : tab,
        ),
      }));
    },
    setColumns: (id, columns) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, columns } : tab)),
      }));
    },
  }));
}

export const useTabsStore = createTabsStore();

export function toSavedTabs(state: Pick<TabsStore, 'tabs' | 'activeTabId'>): TabsState {
  return {
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      repoId: tab.repoId,
      uiState: serializeTabUiState(tab.panels, {
        graph: { columns: tab.columns },
        sidebar: tab.sidebar,
      }),
    })),
    activeTabId: state.activeTabId,
  };
}

export function selectActiveTab(state: Pick<TabsStore, 'tabs' | 'activeTabId'>): ShellTab {
  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  if (!tab) throw new Error('The tab store always holds at least one tab');
  return tab;
}

/**
 * `⌘T` / "+": opens a welcome tab, unless the active tab already is one; then its search field
 * gets the focus instead of stacking empty tabs.
 */
export function openNewTab(): void {
  const store = useTabsStore.getState();
  if (selectActiveTab(store).repoId === null) {
    document.querySelector<HTMLInputElement>('[data-welcome-search]')?.focus();
    return;
  }
  store.newTab();
}
