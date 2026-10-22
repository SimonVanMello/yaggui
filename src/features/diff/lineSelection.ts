import type { HunkSelection } from '../../ipc';
import type { DiffLine, HunkView } from './diffModel';

/** Rendered rows that hold a change: the only ones a line selection can contain. */
export function selectableRows(left: readonly DiffLine[], right?: readonly DiffLine[]): number[] {
  const rows: number[] = [];
  left.forEach((line, row) => {
    const other = right?.[row];
    if (isChange(line) || (other && isChange(other))) rows.push(row);
  });
  return rows;
}

/**
 * Rendered rows with a line of the new version (the right column of a split view): what a
 * selection for the history of a line range can contain.
 */
export function newSideRows(sides: readonly (readonly DiffLine[])[]): number[] {
  const rows: number[] = [];
  sides[sides.length - 1]?.forEach((line, row) => {
    if (line.newNo !== null) rows.push(row);
  });
  return rows;
}

/**
 * The lines of the new version from the first to the last selected row, 1-based and
 * inclusive (`git log -L` takes one contiguous range); `null` when no row has one.
 */
export function newLineSpan(
  rows: ReadonlySet<number>,
  sides: readonly (readonly DiffLine[])[],
): { start: number; end: number } | null {
  const side = sides[sides.length - 1];
  let span: { start: number; end: number } | null = null;
  for (const row of rows) {
    const line = side?.[row]?.newNo;
    if (line == null) continue;
    span = span
      ? { start: Math.min(span.start, line), end: Math.max(span.end, line) }
      : { start: line, end: line };
  }
  return span;
}

function isChange(line: DiffLine): boolean {
  return line.kind === 'add' || line.kind === 'del';
}

/**
 * Rows touched by a click or a drag from `anchor` to `focus` in the gutter, limited to rows
 * that are changes (context rows between two changes are skipped).
 */
export function rowRange(selectable: ReadonlySet<number>, anchor: number, focus: number): number[] {
  const from = Math.min(anchor, focus);
  const to = Math.max(anchor, focus);
  const rows: number[] = [];
  for (let row = from; row <= to; row++) if (selectable.has(row)) rows.push(row);
  return rows;
}

/**
 * Backend selection for the selected rows: per hunk, the indexes (in the hunk's `kinds`) of
 * the changed lines. Split rows carry a removed line on the left and an added one on the
 * right; selecting the row selects both. Hunks come out in order, without duplicates.
 */
export function selectionToHunks(
  rows: Iterable<number>,
  sides: readonly (readonly DiffLine[])[],
  hunks: readonly HunkView[],
): HunkSelection[] {
  const perHunk = new Map<number, Set<number>>();
  for (const row of rows) {
    for (const side of sides) {
      const line = side[row];
      if (!line || !isChange(line) || line.hunkLine === null) continue;
      const set = perHunk.get(line.hunk) ?? new Set<number>();
      set.add(line.hunkLine);
      perHunk.set(line.hunk, set);
    }
  }
  const out: HunkSelection[] = [];
  for (const [index, set] of [...perHunk].sort((a, b) => a[0] - b[0])) {
    const hunk = hunks[index];
    if (hunk) out.push({ id: hunk.id, lines: [...set].sort((a, b) => a - b) });
  }
  return out;
}

/** Number of changed lines in a selection (`lines: null` counts the whole hunk). */
export function selectedLineCount(
  selection: readonly HunkSelection[],
  hunks: readonly HunkView[],
): number {
  let count = 0;
  for (const part of selection) {
    if (part.lines) {
      count += part.lines.length;
      continue;
    }
    const hunk = hunks.find((h) => h.id === part.id);
    if (hunk) count += hunk.hunk.kinds.replace(/ /g, '').length;
  }
  return count;
}

/** Selection of a whole hunk. */
export function wholeHunk(hunk: HunkView): HunkSelection[] {
  return [{ id: hunk.id, lines: null }];
}

/** Keyboard state of the line selection: the row cursor, the range anchor and the picked rows. */
export interface KeyboardSelection {
  cursor: number | null;
  anchor: number | null;
  rows: ReadonlySet<number>;
}

export type SelectionKey =
  /** ↑ / ↓; with `extend` (Shift) the selection grows from the anchor to the new row. */
  | { kind: 'move'; direction: 1 | -1; extend: boolean }
  /** Space: toggles the row under the cursor. */
  | { kind: 'toggle' };

/**
 * Next changed row from `cursor` in `direction`, skipping context rows. Without a cursor,
 * the first (down) or last (up) changed row. Stays put at either end.
 * `ordered` is the sorted list of selectable rows.
 */
export function adjacentRow(
  ordered: readonly number[],
  cursor: number | null,
  direction: 1 | -1,
): number | null {
  if (ordered.length === 0) return null;
  if (cursor === null) return (direction === 1 ? ordered[0] : ordered.at(-1)) ?? null;
  if (direction === 1) return ordered.find((row) => row > cursor) ?? cursor;
  return ordered.findLast((row) => row < cursor) ?? cursor;
}

/** Applies a key to the keyboard selection; the mouse selection uses the same anchor rules. */
export function applySelectionKey(
  selectable: ReadonlySet<number>,
  ordered: readonly number[],
  state: KeyboardSelection,
  key: SelectionKey,
): KeyboardSelection {
  if (key.kind === 'toggle') {
    const { cursor } = state;
    if (cursor === null || !selectable.has(cursor)) return state;
    const rows = new Set(state.rows);
    if (!rows.delete(cursor)) rows.add(cursor);
    return { cursor, anchor: cursor, rows };
  }
  const cursor = adjacentRow(ordered, state.cursor, key.direction);
  if (cursor === null) return state;
  if (!key.extend) return { cursor, anchor: cursor, rows: state.rows };
  const anchor = state.anchor ?? state.cursor ?? cursor;
  return { cursor, anchor, rows: new Set(rowRange(selectable, anchor, cursor)) };
}
