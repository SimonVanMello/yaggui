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
  /** Pinned tabs come first in the strip, in their own order; welcome tabs are never pinned. */
  pinned: boolean;
}

/** A repository tab closed in this session, for "Reopen closed tab". */
export interface ClosedTab {
  repoId: number;
  /** Position in the strip when it was closed. */
  index: number;
  pinned: boolean;
}

/** Closed tabs remembered for "Reopen closed tab" (session only, never saved). */
export const CLOSED_TABS_KEPT = 10;

interface TabsStore {
  tabs: ShellTab[];
  activeTabId: string;
  /** Last closed repository tabs, most recent last. */
  closedTabs: ClosedTab[];
  /** Replaces every tab with the saved state (startup restoration). */
  hydrate: (saved: TabsState) => void;
  /** Opens a welcome tab at the end and activates it. Returns its id. */
  newTab: () => string;
  closeTab: (id: string) => void;
  /**
   * Closes several tabs at once, remembered so that reopening brings them back in place. The
   * active tab, if closed, gives way to `activateId` or else its nearest neighbor left open.
   */
  closeTabs: (ids: readonly string[], activateId?: string) => void;
  /** Closes every unpinned tab but `id`. */
  closeOtherTabs: (id: string) => void;
  /** Closes the unpinned tabs after `id`. */
  closeTabsToRight: (id: string) => void;
  /** Takes the most recently closed tab off the stack. */
  popClosedTab: () => ClosedTab | undefined;
  /** Pins or unpins a repository tab: it moves to the end of the pinned tabs, or right after them. */
  setPinned: (id: string, pinned: boolean) => void;
  /** Puts a reopened tab back: pinned or not, at `index` when that fits its group, else at its end. */
  placeReopened: (id: string, closed: ClosedTab) => void;
  activate: (id: string) => void;
  /** `⌘1…8` select by position, `⌘9` always selects the last tab (browser convention). */
  activateIndex: (index: number) => void;
  /** Cycles through tabs (`⌃Tab` / `⌃⇧Tab`). */
  activateRelative: (delta: number) => void;
  /** Moves a tab within its group: pinned tabs stay before the others. */
  moveTab: (id: string, toIndex: number) => void;
  /** `layout` replaces the tab's panels, sidebar and columns (the saved ones of the repository). */
  setRepo: (
    id: string,
    repoId: number | null,
    layout?: Pick<ShellTab, 'panels' | 'sidebar' | 'columns'>,
  ) => void;
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
    pinned: false,
  };
}

function pinnedCount(tabs: readonly ShellTab[]): number {
  return tabs.filter((tab) => tab.pinned).length;
}

/** Pinned tabs first, each group in its order (a save from before pinning, or a corrupted one). */
function pinnedFirst(tabs: ShellTab[]): ShellTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

/** Indexes `tab` may take in `tabs` (which holds it): its group's range. */
function groupRange(tabs: readonly ShellTab[], tab: ShellTab): [number, number] {
  const pinned = pinnedCount(tabs);
  return tab.pinned ? [0, pinned - 1] : [pinned, tabs.length - 1];
}

/** The closed repository tabs to remember, rightmost first: reopening brings the leftmost back first. */
function remember(
  stack: readonly ClosedTab[],
  tabs: readonly ShellTab[],
  ids: ReadonlySet<string>,
) {
  const closed: ClosedTab[] = [];
  tabs.forEach((tab, index) => {
    if (ids.has(tab.id) && tab.repoId !== null) {
      closed.unshift({ repoId: tab.repoId, index, pinned: tab.pinned });
    }
  });
  return [...stack, ...closed].slice(-CLOSED_TABS_KEPT);
}

export function createTabsStore() {
  const initial = welcomeTab();
  return create<TabsStore>()((set, get) => ({
    tabs: [initial],
    activeTabId: initial.id,
    closedTabs: [],

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
          pinned: tab.repoId !== null && tab.pinned === true,
        }));
      if (tabs.length === 0) return;
      const active = tabs.find((tab) => tab.id === saved.activeTabId) ?? tabs[0];
      set({ tabs: pinnedFirst(tabs), activeTabId: active?.id ?? get().activeTabId });
    },

    newTab: () => {
      const tab = welcomeTab();
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      return tab.id;
    },

    closeTab: (id) => {
      get().closeTabs([id]);
    },

    closeTabs: (ids, activateId) => {
      const { tabs, activeTabId, closedTabs } = get();
      const closing = new Set(ids.filter((id) => tabs.some((tab) => tab.id === id)));
      if (closing.size === 0) return;
      const remembered = remember(closedTabs, tabs, closing);
      const remaining = tabs.filter((tab) => !closing.has(tab.id));
      if (remaining.length === 0) {
        // The window always keeps a tab: closing the last one leaves a welcome screen.
        const tab = welcomeTab();
        set({ tabs: [tab], activeTabId: tab.id, closedTabs: remembered });
        return;
      }
      let nextActive = activeTabId;
      if (closing.has(activeTabId) && activateId !== undefined && !closing.has(activateId)) {
        nextActive = activateId;
      } else if (closing.has(activeTabId)) {
        // The nearest tab left open: to the right first, then to the left.
        const index = tabs.findIndex((tab) => tab.id === activeTabId);
        const right = tabs.slice(index + 1).find((tab) => !closing.has(tab.id));
        const left = tabs
          .slice(0, index)
          .reverse()
          .find((tab) => !closing.has(tab.id));
        nextActive = (right ?? left ?? remaining[0])?.id ?? activeTabId;
      }
      set({ tabs: remaining, activeTabId: nextActive, closedTabs: remembered });
    },

    closeOtherTabs: (id) => {
      const { tabs } = get();
      if (!tabs.some((tab) => tab.id === id)) return;
      const closing = tabs.filter((tab) => tab.id !== id && !tab.pinned).map((tab) => tab.id);
      get().closeTabs(closing, id);
    },

    closeTabsToRight: (id) => {
      const { tabs } = get();
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const closing = tabs.slice(index + 1).filter((tab) => !tab.pinned);
      get().closeTabs(
        closing.map((tab) => tab.id),
        id,
      );
    },

    popClosedTab: () => {
      const { closedTabs } = get();
      const last = closedTabs.at(-1);
      if (last) set({ closedTabs: closedTabs.slice(0, -1) });
      return last;
    },

    setPinned: (id, pinned) => {
      const { tabs } = get();
      const tab = tabs.find((t) => t.id === id);
      if (!tab || tab.repoId === null || tab.pinned === pinned) return;
      const others = tabs.filter((t) => t.id !== id);
      const next = [...others];
      // Pinning: after the pinned tabs. Unpinning: first of the unpinned ones.
      next.splice(pinnedCount(others), 0, { ...tab, pinned });
      set({ tabs: next });
    },

    placeReopened: (id, closed) => {
      const { tabs } = get();
      const tab = tabs.find((t) => t.id === id);
      if (!tab || tab.repoId === null) return;
      const others = tabs.filter((t) => t.id !== id);
      const pinned = pinnedCount(others);
      const [first, last] = closed.pinned ? [0, pinned] : [pinned, others.length];
      const index = closed.index >= first && closed.index <= last ? closed.index : last;
      const next = [...others];
      next.splice(index, 0, { ...tab, pinned: closed.pinned });
      set({ tabs: next });
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
      if (!tab) return;
      const [first, last] = groupRange(tabs, tab);
      const to = Math.max(first, Math.min(last, toIndex));
      if (from === to) return;
      const next = tabs.filter((t) => t.id !== id);
      next.splice(to, 0, tab);
      set({ tabs: next });
    },

    setRepo: (id, repoId, layout) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? { ...tab, ...layout, repoId, pinned: tab.pinned && repoId !== null }
            : tab,
        ),
        // A repository open again has nothing left to reopen.
        closedTabs:
          repoId === null ? state.closedTabs : state.closedTabs.filter((c) => c.repoId !== repoId),
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
      pinned: tab.pinned,
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
