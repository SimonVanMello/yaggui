/** Size (px) and visibility of a side panel of the repo view. */
export interface PanelState {
  size: number;
  collapsed: boolean;
}

export type PanelId = 'sidebar' | 'details';
export type TabPanels = Record<PanelId, PanelState>;

/** Bounds of each side panel, in px (spec §4: the three panels are resizable). */
export const PANEL_LIMITS: Record<PanelId, { min: number; max: number; default: number }> = {
  sidebar: { min: 160, max: 480, default: 232 },
  details: { min: 260, max: 600, default: 320 },
};

/** The graph keeps at least this width when side panels grow. */
export const CENTER_MIN_WIDTH = 320;

export const DEFAULT_PANELS: TabPanels = {
  sidebar: { size: PANEL_LIMITS.sidebar.default, collapsed: false },
  details: { size: PANEL_LIMITS.details.default, collapsed: false },
};

export function clampPanelSize(panel: PanelId, size: number): number {
  const { min, max } = PANEL_LIMITS[panel];
  return Math.round(Math.min(max, Math.max(min, size)));
}

function parsePanel(panel: PanelId, value: unknown): PanelState {
  const fallback = DEFAULT_PANELS[panel];
  if (typeof value !== 'object' || value === null) return fallback;
  const size = 'size' in value && typeof value.size === 'number' ? value.size : fallback.size;
  const collapsed =
    'collapsed' in value && typeof value.collapsed === 'boolean'
      ? value.collapsed
      : fallback.collapsed;
  return { size: clampPanelSize(panel, size), collapsed };
}

/** Reads the per-tab UI state stored by the backend as opaque JSON; tolerant to old/bad data. */
export function parseTabUiState(json: string | null): TabPanels {
  if (!json) return DEFAULT_PANELS;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || !('panels' in value)) return DEFAULT_PANELS;
    const panels: unknown = value.panels;
    if (typeof panels !== 'object' || panels === null) return DEFAULT_PANELS;
    return {
      sidebar: parsePanel('sidebar', 'sidebar' in panels ? panels.sidebar : undefined),
      details: parsePanel('details', 'details' in panels ? panels.details : undefined),
    };
  } catch {
    return DEFAULT_PANELS;
  }
}

/** `extra` holds the other features' slices of the tab state (e.g. `{ graph: { columns } }`). */
export function serializeTabUiState(
  panels: TabPanels,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ ...extra, panels });
}

/**
 * Displayed widths of the side panels for a given view width. The saved sizes are kept, but
 * when the window is too narrow the panels shrink (right panel first) down to their minimum so
 * the center keeps `CENTER_MIN_WIDTH`. `0` means collapsed.
 */
export function fitPanels(panels: TabPanels, viewWidth: number): Record<PanelId, number> {
  let sidebar = panels.sidebar.collapsed ? 0 : panels.sidebar.size;
  let details = panels.details.collapsed ? 0 : panels.details.size;
  // Before the first measure, show the saved sizes.
  if (viewWidth <= 0) return { sidebar, details };
  let excess = sidebar + details + CENTER_MIN_WIDTH - viewWidth;
  if (excess > 0 && details > 0) {
    const shrink = Math.min(excess, details - PANEL_LIMITS.details.min);
    details -= shrink;
    excess -= shrink;
  }
  if (excess > 0 && sidebar > 0) {
    sidebar -= Math.min(excess, sidebar - PANEL_LIMITS.sidebar.min);
  }
  return { sidebar, details };
}
