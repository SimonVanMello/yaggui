import { describe, expect, it } from 'vitest';

import { autoGraphWidth, GRAPH_COLUMN_AUTO_MAX, GRAPH_COLUMN_MIN, visibleRows } from './geometry';

describe('visibleRows', () => {
  it('accounts for the WIP row above row 0', () => {
    expect(visibleRows(0, 280, 28, 28, 100)).toEqual({ first: 0, last: 8 });
    expect(visibleRows(28 * 10, 280, 28, 28, 100)).toEqual({ first: 9, last: 18 });
  });

  it('clamps to the rows of the graph', () => {
    expect(visibleRows(28 * 95, 280, 28, 0, 100)).toEqual({ first: 95, last: 99 });
    expect(visibleRows(0, 280, 28, 0, 0)).toEqual({ first: 0, last: -1 });
  });
});

describe('autoGraphWidth', () => {
  it('fits the lanes within bounds', () => {
    expect(autoGraphWidth(1)).toBe(GRAPH_COLUMN_MIN);
    expect(autoGraphWidth(6)).toBe(24 + 5 * 16);
    expect(autoGraphWidth(48)).toBe(GRAPH_COLUMN_AUTO_MAX);
  });
});
