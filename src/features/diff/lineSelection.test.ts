import { describe, expect, it } from 'vitest';

import type { TextDiff } from '../../ipc';
import { splitModel, unifiedModel } from './diffModel';
import {
  adjacentRow,
  applySelectionKey,
  rowRange,
  selectableRows,
  selectedLineCount,
  selectionToHunks,
} from './lineSelection';

const diff: TextDiff = {
  hunks: [
    {
      id: 'h0',
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      header: '',
      // hunk lines:     0    1    2    3    4    5
      kinds: ' --++ ',
      lines: ['a', 'old1', 'old2', 'new1', 'new2', 'b'],
    },
    {
      id: 'h1',
      oldStart: 20,
      oldLines: 2,
      newStart: 21,
      newLines: 3,
      header: '',
      kinds: ' +',
      lines: ['c', 'added'],
    },
  ],
  additions: 3,
  deletions: 2,
  oldEncoding: 'utf8',
  newEncoding: 'utf8',
  oldLineEnding: 'lf',
  newLineEnding: 'lf',
  oldMissingNewline: false,
  newMissingNewline: false,
  oldLineCount: 30,
  newLineCount: 31,
};

describe('line selection → hunk indexes', () => {
  it('maps unified rows to indexes in the hunk lines', () => {
    const { lines, hunks } = unifiedModel(diff);
    // rows: 0 a | 1 old1 | 2 old2 | 3 new1 | 4 new2 | 5 b | 6 c | 7 added
    expect(selectableRows(lines)).toEqual([1, 2, 3, 4, 7]);
    expect(selectionToHunks([2, 3], [lines], hunks)).toEqual([{ id: 'h0', lines: [2, 3] }]);
    expect(selectionToHunks([7, 1], [lines], hunks)).toEqual([
      { id: 'h0', lines: [1] },
      { id: 'h1', lines: [1] },
    ]);
  });

  it('ignores context rows and out-of-range rows', () => {
    const { lines, hunks } = unifiedModel(diff);
    expect(selectionToHunks([0, 5, 6, 99], [lines], hunks)).toEqual([]);
  });

  it('selects both sides of a split row', () => {
    const { left, right, hunks } = splitModel(diff);
    // rows: 0 a | 1 old1↔new1 | 2 old2↔new2 | 3 b | 4 c | 5 filler↔added
    expect(selectableRows(left, right)).toEqual([1, 2, 5]);
    expect(selectionToHunks([1], [left, right], hunks)).toEqual([{ id: 'h0', lines: [1, 3] }]);
    expect(selectionToHunks([5], [left, right], hunks)).toEqual([{ id: 'h1', lines: [1] }]);
  });

  it('counts the changed lines of a selection, whole hunks included', () => {
    const { hunks } = unifiedModel(diff);
    expect(selectedLineCount([{ id: 'h0', lines: [1, 4] }], hunks)).toBe(2);
    expect(selectedLineCount([{ id: 'h0', lines: null }], hunks)).toBe(4);
  });
});

describe('gutter ranges', () => {
  const selectable = new Set([1, 2, 3, 4, 7]);

  it('keeps the changed rows between the anchor and the focus, in any direction', () => {
    expect(rowRange(selectable, 2, 4)).toEqual([2, 3, 4]);
    expect(rowRange(selectable, 7, 3)).toEqual([3, 4, 7]);
    expect(rowRange(selectable, 5, 6)).toEqual([]);
  });
});

describe('keyboard selection', () => {
  const selectable = new Set([1, 2, 5, 8]);
  const ordered = [1, 2, 5, 8];
  const empty = { cursor: null, anchor: null, rows: new Set<number>() };

  it('moves over changed rows only, and stops at the ends', () => {
    expect(adjacentRow(ordered, null, 1)).toBe(1);
    expect(adjacentRow(ordered, null, -1)).toBe(8);
    expect(adjacentRow(ordered, 2, 1)).toBe(5);
    expect(adjacentRow(ordered, 5, -1)).toBe(2);
    expect(adjacentRow(ordered, 8, 1)).toBe(8);
    expect(adjacentRow(ordered, 1, -1)).toBe(1);
    expect(adjacentRow([], null, 1)).toBeNull();
  });

  it('toggles the row under the cursor', () => {
    const moved = applySelectionKey(selectable, ordered, empty, {
      kind: 'move',
      direction: 1,
      extend: false,
    });
    expect(moved).toMatchObject({ cursor: 1, anchor: 1 });
    expect(moved.rows.size).toBe(0);
    const on = applySelectionKey(selectable, ordered, moved, { kind: 'toggle' });
    expect([...on.rows]).toEqual([1]);
    const off = applySelectionKey(selectable, ordered, on, { kind: 'toggle' });
    expect(off.rows.size).toBe(0);
  });

  it('ignores Space without a cursor', () => {
    expect(applySelectionKey(selectable, ordered, empty, { kind: 'toggle' })).toBe(empty);
  });

  it('extends from the anchor over changed rows, skipping context', () => {
    let state = applySelectionKey(selectable, ordered, empty, {
      kind: 'move',
      direction: 1,
      extend: false,
    });
    state = applySelectionKey(selectable, ordered, state, { kind: 'toggle' });
    for (let i = 0; i < 2; i++) {
      state = applySelectionKey(selectable, ordered, state, {
        kind: 'move',
        direction: 1,
        extend: true,
      });
    }
    expect(state.cursor).toBe(5);
    expect([...state.rows]).toEqual([1, 2, 5]);
    state = applySelectionKey(selectable, ordered, state, {
      kind: 'move',
      direction: -1,
      extend: true,
    });
    expect([...state.rows]).toEqual([1, 2]);
  });

  it('a plain move keeps the selection and restarts the anchor', () => {
    const state = applySelectionKey(
      selectable,
      ordered,
      { cursor: 2, anchor: 1, rows: new Set([1, 2]) },
      { kind: 'move', direction: 1, extend: false },
    );
    expect(state).toMatchObject({ cursor: 5, anchor: 5 });
    expect([...state.rows]).toEqual([1, 2]);
  });
});
