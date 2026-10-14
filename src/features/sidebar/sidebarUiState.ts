/** Per-tab state of the refs sidebar, saved with the tab (opaque `uiState` JSON). */
export interface SidebarUiState {
  /** Expanded (`true`) or collapsed (`false`) nodes the user toggled; others use defaults. */
  open: Record<string, boolean>;
  /** Branches as a flat list instead of a tree by prefix (F-041). */
  flat: boolean;
  /** Branch names picked last (most recent first), listed first by the branch selector. */
  recent: string[];
}

export const DEFAULT_SIDEBAR_UI: SidebarUiState = { open: {}, flat: false, recent: [] };

/** Bounds what a long-lived tab accumulates in its saved state. */
export const MAX_RECENT = 12;
const MAX_OPEN_KEYS = 500;

/** Reads the `sidebar` part of a saved tab state; tolerant to old or bad data. */
export function parseSidebarUiState(json: string | null): SidebarUiState {
  if (!json) return DEFAULT_SIDEBAR_UI;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || !('sidebar' in value)) {
      return DEFAULT_SIDEBAR_UI;
    }
    const sidebar: unknown = value.sidebar;
    if (typeof sidebar !== 'object' || sidebar === null) return DEFAULT_SIDEBAR_UI;
    const open: Record<string, boolean> = {};
    if ('open' in sidebar && typeof sidebar.open === 'object' && sidebar.open !== null) {
      for (const [key, expanded] of Object.entries(sidebar.open)) {
        if (typeof expanded === 'boolean') open[key] = expanded;
      }
    }
    const recent =
      'recent' in sidebar && Array.isArray(sidebar.recent)
        ? sidebar.recent.filter((name): name is string => typeof name === 'string')
        : [];
    return {
      open,
      flat: 'flat' in sidebar && sidebar.flat === true,
      recent: recent.slice(0, MAX_RECENT),
    };
  } catch {
    return DEFAULT_SIDEBAR_UI;
  }
}

export function setNodeOpen(state: SidebarUiState, key: string, open: boolean): SidebarUiState {
  // Re-inserting last keeps the map in toggle order; the oldest toggles go when it grows too much.
  const entries = [...Object.entries(state.open).filter(([k]) => k !== key), [key, open] as const];
  return { ...state, open: Object.fromEntries(entries.slice(-MAX_OPEN_KEYS)) };
}

export function pushRecent(state: SidebarUiState, name: string): SidebarUiState {
  const recent = [name, ...state.recent.filter((n) => n !== name)].slice(0, MAX_RECENT);
  return { ...state, recent };
}
