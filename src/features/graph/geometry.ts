/** Horizontal distance between two lanes, in CSS px. */
export const LANE_WIDTH = 16;
/** Space left of lane 0 and right of the last lane. */
export const GRAPH_PADDING = 12;
export const NODE_RADIUS = 5;
export const EDGE_WIDTH = 2;

/** Bounds of the auto-sized graph column. */
export const GRAPH_COLUMN_MIN = 48;
export const GRAPH_COLUMN_AUTO_MAX = 280;

export function laneX(lane: number): number {
  return GRAPH_PADDING + lane * LANE_WIDTH;
}

/** Width that shows `laneCount` lanes without clipping, within the auto bounds. */
export function autoGraphWidth(laneCount: number): number {
  const width = 2 * GRAPH_PADDING + Math.max(0, laneCount - 1) * LANE_WIDTH;
  return Math.min(GRAPH_COLUMN_AUTO_MAX, Math.max(GRAPH_COLUMN_MIN, width));
}

/**
 * Browsers clamp layout sizes (~33.5 M px in Chrome and WebKit). Above this height the
 * scroll area is scaled down: 1.3 M commits × 28 px would not fit.
 */
export const MAX_PHYSICAL_HEIGHT = 10_000_000;

/** Rows (inclusive) intersecting the viewport at a logical offset, ignoring the header row. */
export function visibleRows(
  offset: number,
  viewportHeight: number,
  rowHeight: number,
  headerHeight: number,
  totalRows: number,
): { first: number; last: number } {
  if (totalRows <= 0) return { first: 0, last: -1 };
  const first = Math.floor((offset - headerHeight) / rowHeight);
  const last = Math.floor((offset + viewportHeight - headerHeight - 1) / rowHeight);
  return {
    first: Math.min(totalRows - 1, Math.max(0, first)),
    last: Math.min(totalRows - 1, Math.max(0, last)),
  };
}
