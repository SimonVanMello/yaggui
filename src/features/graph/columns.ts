/** Resizable columns of the graph; the message column takes the remaining width. */
export type SizedColumn = 'graph' | 'author' | 'date' | 'sha';
export type HideableColumn = 'author' | 'date' | 'sha';

export const HIDEABLE_COLUMNS: readonly HideableColumn[] = ['author', 'date', 'sha'];

/** Column layout of one tab (F-021), persisted in the tab's UI state. */
export interface GraphColumns {
  /** `null`: sized from the lane count of the graph. */
  graph: number | null;
  author: number;
  date: number;
  sha: number;
  hidden: Record<HideableColumn, boolean>;
}

export const COLUMN_LIMITS: Record<SizedColumn, { min: number; max: number }> = {
  graph: { min: 48, max: 640 },
  // Under ~64 px only the avatar is shown.
  author: { min: 32, max: 320 },
  date: { min: 64, max: 240 },
  sha: { min: 56, max: 160 },
};

export const DEFAULT_COLUMNS: GraphColumns = {
  graph: null,
  author: 140,
  date: 124,
  sha: 76,
  hidden: { author: false, date: false, sha: false },
};

/** Width of the message column below which the side columns are hidden automatically. */
export const MESSAGE_MIN_WIDTH = 160;

export function clampColumn(column: SizedColumn, width: number): number {
  const { min, max } = COLUMN_LIMITS[column];
  return Math.round(Math.min(max, Math.max(min, width)));
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

/** Reads `graph.columns` from a tab's UI state JSON; tolerant to old or bad data. */
export function parseGraphColumns(json: string | null): GraphColumns {
  if (!json) return DEFAULT_COLUMNS;
  try {
    const root: unknown = JSON.parse(json);
    const graph: unknown =
      typeof root === 'object' && root !== null ? (root as Record<string, unknown>).graph : null;
    const columns: unknown =
      typeof graph === 'object' && graph !== null
        ? (graph as Record<string, unknown>).columns
        : null;
    if (typeof columns !== 'object' || columns === null) return DEFAULT_COLUMNS;
    const record = columns as Record<string, unknown>;
    const hiddenValue = record.hidden;
    const hidden = { ...DEFAULT_COLUMNS.hidden };
    if (typeof hiddenValue === 'object' && hiddenValue !== null) {
      for (const column of HIDEABLE_COLUMNS) {
        const flag = (hiddenValue as Record<string, unknown>)[column];
        if (typeof flag === 'boolean') hidden[column] = flag;
      }
    }
    const graphWidth = readNumber(columns, 'graph');
    const sized = (column: Exclude<SizedColumn, 'graph'>) => {
      const width = readNumber(columns, column);
      return width === undefined ? DEFAULT_COLUMNS[column] : clampColumn(column, width);
    };
    return {
      graph: graphWidth === undefined ? null : clampColumn('graph', graphWidth),
      author: sized('author'),
      date: sized('date'),
      sha: sized('sha'),
      hidden,
    };
  } catch {
    return DEFAULT_COLUMNS;
  }
}

/**
 * Widths actually laid out for a view width: hidden columns get 0, and when the message
 * column would get narrower than `MESSAGE_MIN_WIDTH`, side columns drop out (date, then
 * author, then SHA) without changing the saved layout.
 */
export function fitColumns(
  columns: GraphColumns,
  graphWidth: number,
  viewWidth: number,
): { graph: number; author: number; date: number; sha: number } {
  const widths = {
    graph: graphWidth,
    author: columns.hidden.author ? 0 : columns.author,
    date: columns.hidden.date ? 0 : columns.date,
    sha: columns.hidden.sha ? 0 : columns.sha,
  };
  if (viewWidth <= 0) return widths;
  for (const column of ['date', 'author', 'sha'] as const) {
    const message = viewWidth - widths.graph - widths.author - widths.date - widths.sha;
    if (message >= MESSAGE_MIN_WIDTH) break;
    widths[column] = 0;
  }
  return widths;
}
