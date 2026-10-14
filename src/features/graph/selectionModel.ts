/**
 * Multi-selection of graph rows (F-143). Rows are numbered from the tip (row 0 is the newest
 * commit), so the graph order is ascending row and a cherry-pick applies descending rows.
 *
 * The model is pure: `GraphSource` owns the state and feeds it the lookups it has.
 */

export interface PickedCommit {
  sha: string;
  row: number;
}

export interface RowSelectionState {
  /** Every selected commit, by SHA. Empty when nothing (or the working copy) is selected. */
  picked: ReadonlyMap<string, number>;
  /** The commit the detail panel shows. */
  primary: PickedCommit | null;
  /** Fixed end of a shift-click range. */
  anchor: number | null;
}

export interface ClickModifiers {
  /** ⌘ / Ctrl: add or remove the clicked commit. */
  toggle: boolean;
  /** ⇧: select the rows between the anchor and the clicked one. */
  range: boolean;
}

/** Ranges beyond this many rows are cut: nobody picks thousands of commits by hand. */
export const MAX_RANGE_ROWS = 1000;

export const EMPTY_SELECTION: RowSelectionState = {
  picked: new Map(),
  primary: null,
  anchor: null,
};

export function singleSelection(hit: PickedCommit): RowSelectionState {
  return { picked: new Map([[hit.sha, hit.row]]), primary: hit, anchor: hit.row };
}

export interface ClickResult {
  state: RowSelectionState;
  /** Rows of a range whose commit is not loaded yet: the caller fetches them and retries. */
  missing: { from: number; to: number } | null;
}

/** `lookup` returns the SHA of a loaded row. */
export function clickSelection(
  state: RowSelectionState,
  hit: PickedCommit,
  modifiers: ClickModifiers,
  lookup: (row: number) => string | undefined,
): ClickResult {
  if (modifiers.range && state.anchor !== null) {
    return selectRange(state.anchor, hit, lookup, modifiers.toggle ? state.picked : null);
  }
  if (modifiers.toggle) {
    const picked = new Map(state.picked);
    if (picked.has(hit.sha)) {
      picked.delete(hit.sha);
      const last = [...picked].sort((a, b) => a[1] - b[1]).at(-1);
      const primary = last ? { sha: last[0], row: last[1] } : null;
      return { state: { picked, primary, anchor: hit.row }, missing: null };
    }
    picked.set(hit.sha, hit.row);
    return { state: { picked, primary: hit, anchor: hit.row }, missing: null };
  }
  return { state: singleSelection(hit), missing: null };
}

/** Rows `anchor..hit` (either direction); `base` keeps an earlier selection (⌘⇧-click). */
export function selectRange(
  anchor: number,
  hit: PickedCommit,
  lookup: (row: number) => string | undefined,
  base: ReadonlyMap<string, number> | null,
): ClickResult {
  const low = Math.min(anchor, hit.row);
  const high = Math.min(Math.max(anchor, hit.row), low + MAX_RANGE_ROWS - 1);
  const picked = new Map(base ?? []);
  let missingFrom = -1;
  let missingTo = -1;
  for (let row = low; row <= high; row += 1) {
    const sha = lookup(row);
    if (sha === undefined) {
      if (missingFrom < 0) missingFrom = row;
      missingTo = row;
    } else {
      picked.set(sha, row);
    }
  }
  // The anchor stays where the range started, so the next ⇧-click pivots around it.
  const primary = lookup(hit.row) === undefined ? null : hit;
  const missing = missingFrom < 0 ? null : { from: missingFrom, to: missingTo };
  return { state: { picked, primary, anchor }, missing };
}

/** Selected commits in graph order (newest first). */
export function graphOrder(state: RowSelectionState): PickedCommit[] {
  return [...state.picked].map(([sha, row]) => ({ sha, row })).sort((a, b) => a.row - b.row);
}

/** Order a cherry-pick applies them in: the oldest first. */
export function applyOrder(state: RowSelectionState): PickedCommit[] {
  return graphOrder(state).reverse();
}

/** Rows are renumbered when the graph is recomputed: keeps what could be located again. */
export function relocate(
  state: RowSelectionState,
  rows: ReadonlyMap<string, number | null>,
): RowSelectionState {
  const picked = new Map<string, number>();
  for (const sha of state.picked.keys()) {
    const row = rows.get(sha);
    if (row !== undefined && row !== null) picked.set(sha, row);
  }
  const primaryRow = state.primary ? rows.get(state.primary.sha) : undefined;
  const primary =
    state.primary && primaryRow !== undefined && primaryRow !== null
      ? { sha: state.primary.sha, row: primaryRow }
      : null;
  const anchorSha = [...state.picked].find(([, row]) => row === state.anchor)?.[0];
  const anchorRow = anchorSha === undefined ? undefined : rows.get(anchorSha);
  return { picked, primary, anchor: anchorRow ?? primary?.row ?? null };
}
