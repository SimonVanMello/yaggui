import { describe, expect, it } from 'vitest';

import {
  EMPTY_SELECTION,
  MAX_RANGE_ROWS,
  applyOrder,
  clickSelection,
  graphOrder,
  relocate,
  singleSelection,
  type ClickModifiers,
} from './selectionModel';

const sha = (row: number) => `sha${String(row)}`;
const lookup = (row: number) => (row >= 0 && row < 50 ? sha(row) : undefined);
const hit = (row: number) => ({ sha: sha(row), row });
const PLAIN: ClickModifiers = { toggle: false, range: false };
const TOGGLE: ClickModifiers = { toggle: true, range: false };
const RANGE: ClickModifiers = { toggle: false, range: true };

describe('graph multi-selection', () => {
  it('a plain click selects one commit and sets the anchor', () => {
    const { state } = clickSelection(EMPTY_SELECTION, hit(4), PLAIN, lookup);
    expect([...state.picked]).toEqual([[sha(4), 4]]);
    expect(state.primary).toEqual(hit(4));
    expect(state.anchor).toBe(4);
  });

  it('a plain click drops the previous multi-selection', () => {
    let { state } = clickSelection(EMPTY_SELECTION, hit(1), PLAIN, lookup);
    ({ state } = clickSelection(state, hit(3), TOGGLE, lookup));
    ({ state } = clickSelection(state, hit(7), PLAIN, lookup));
    expect(graphOrder(state).map((c) => c.row)).toEqual([7]);
  });

  it('⌘-click adds and removes commits, the last added one becomes primary', () => {
    let { state } = clickSelection(EMPTY_SELECTION, hit(2), PLAIN, lookup);
    ({ state } = clickSelection(state, hit(9), TOGGLE, lookup));
    ({ state } = clickSelection(state, hit(5), TOGGLE, lookup));
    expect(graphOrder(state).map((c) => c.row)).toEqual([2, 5, 9]);
    expect(state.primary?.row).toBe(5);
    ({ state } = clickSelection(state, hit(5), TOGGLE, lookup));
    expect(graphOrder(state).map((c) => c.row)).toEqual([2, 9]);
    expect(state.primary?.row).toBe(9);
  });

  it('removing the last selected commit leaves nothing selected', () => {
    let { state } = clickSelection(EMPTY_SELECTION, hit(2), PLAIN, lookup);
    ({ state } = clickSelection(state, hit(2), TOGGLE, lookup));
    expect(state.picked.size).toBe(0);
    expect(state.primary).toBeNull();
  });

  it('⇧-click selects the range from the anchor, in both directions', () => {
    let { state } = clickSelection(EMPTY_SELECTION, hit(10), PLAIN, lookup);
    ({ state } = clickSelection(state, hit(13), RANGE, lookup));
    expect(graphOrder(state).map((c) => c.row)).toEqual([10, 11, 12, 13]);
    expect(state.anchor).toBe(10);
    // The next ⇧-click pivots around the same anchor and replaces the range.
    ({ state } = clickSelection(state, hit(8), RANGE, lookup));
    expect(graphOrder(state).map((c) => c.row)).toEqual([8, 9, 10]);
  });

  it('⇧-click without an anchor behaves like a plain click', () => {
    const { state } = clickSelection(EMPTY_SELECTION, hit(6), RANGE, lookup);
    expect(graphOrder(state).map((c) => c.row)).toEqual([6]);
  });

  it('⌘⇧-click adds the range to the existing selection', () => {
    let { state } = clickSelection(EMPTY_SELECTION, hit(1), PLAIN, lookup);
    ({ state } = clickSelection(state, hit(20), TOGGLE, lookup));
    ({ state } = clickSelection(state, hit(22), { toggle: true, range: true }, lookup));
    expect(graphOrder(state).map((c) => c.row)).toEqual([1, 20, 21, 22]);
  });

  it('a range beyond the bound keeps the clicked commit and cuts at the anchor end', () => {
    const wide = (row: number) => (row >= 0 && row < 3000 ? sha(row) : undefined);
    let { state } = clickSelection(EMPTY_SELECTION, hit(0), PLAIN, wide);
    ({ state } = clickSelection(state, hit(1200), RANGE, wide));
    expect(state.picked.size).toBe(MAX_RANGE_ROWS);
    expect(state.picked.has(sha(1200))).toBe(true);
    expect(graphOrder(state).at(0)?.row).toBe(1200 - MAX_RANGE_ROWS + 1);
    expect(state.primary).toEqual(hit(1200));
    expect(state.anchor).toBe(0);
    // Upwards: cut below the anchor, the clicked (top) commit stays.
    ({ state } = clickSelection(EMPTY_SELECTION, hit(1200), PLAIN, wide));
    ({ state } = clickSelection(state, hit(0), RANGE, wide));
    expect(state.picked.size).toBe(MAX_RANGE_ROWS);
    expect(state.picked.has(sha(0))).toBe(true);
    expect(graphOrder(state).at(-1)?.row).toBe(MAX_RANGE_ROWS - 1);
    expect(state.primary).toEqual(hit(0));
  });

  it('reports rows of a range that are not loaded yet', () => {
    const partial = (row: number) => (row < 12 ? sha(row) : undefined);
    let { state } = clickSelection(EMPTY_SELECTION, hit(10), PLAIN, partial);
    const result = clickSelection(state, { sha: sha(14), row: 14 }, RANGE, partial);
    state = result.state;
    expect(result.missing).toEqual({ from: 12, to: 14 });
    expect(graphOrder(state).map((c) => c.row)).toEqual([10, 11]);
  });

  it('orders a cherry-pick oldest first, whatever the click order', () => {
    let { state } = clickSelection(EMPTY_SELECTION, hit(9), PLAIN, lookup);
    ({ state } = clickSelection(state, hit(2), TOGGLE, lookup));
    ({ state } = clickSelection(state, hit(5), TOGGLE, lookup));
    expect(applyOrder(state).map((c) => c.row)).toEqual([9, 5, 2]);
    expect(graphOrder(state).map((c) => c.row)).toEqual([2, 5, 9]);
  });

  it('keeps the commits it can locate after the graph is recomputed', () => {
    let { state } = clickSelection(EMPTY_SELECTION, hit(3), PLAIN, lookup);
    ({ state } = clickSelection(state, hit(6), TOGGLE, lookup));
    const next = relocate(
      state,
      new Map([
        [sha(3), 5],
        [sha(6), null],
      ]),
    );
    expect([...next.picked]).toEqual([[sha(3), 5]]);
    expect(next.primary).toBeNull();
  });

  it('singleSelection is a plain selection', () => {
    expect(singleSelection(hit(1)).anchor).toBe(1);
  });
});
