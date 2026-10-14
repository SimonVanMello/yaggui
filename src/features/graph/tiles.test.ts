import { describe, expect, it } from 'vitest';

import { assignTiles, neededTiles } from './tiles';

describe('neededTiles', () => {
  it('covers the viewport and its margin, clamped to the content', () => {
    expect(neededTiles(0, 800, 200, 800, 100_000)).toEqual([0, 1]);
    expect(neededTiles(1000, 800, 200, 800, 100_000)).toEqual([1, 2]);
    expect(neededTiles(1500, 800, 200, 800, 100_000)).toEqual([1, 2, 3]);
    expect(neededTiles(99_500, 800, 200, 800, 100_000)).toEqual([124]);
    expect(neededTiles(0, 800, 200, 800, 0)).toEqual([]);
  });
});

describe('assignTiles', () => {
  it('fills empty slots first', () => {
    expect(assignTiles([null, null, null, null], [0, 1], false)).toEqual({
      tiles: [0, 1, null, null],
      redraw: [0, 1],
    });
  });

  it('keeps tiles still needed and only redraws the new ones', () => {
    expect(assignTiles([0, 1, 2, null], [1, 2, 3], false)).toEqual({
      tiles: [3, 1, 2, null],
      redraw: [0],
    });
    expect(assignTiles([3, 1, 2, null], [1, 2, 3], false).redraw).toEqual([]);
  });

  it('redraws every shown tile when forced', () => {
    expect(assignTiles([0, 1, null], [0, 1], true)).toEqual({
      tiles: [0, 1, null],
      redraw: [0, 1],
    });
  });
});
