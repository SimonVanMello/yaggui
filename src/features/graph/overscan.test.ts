import { describe, expect, it } from 'vitest';

import { directionalRange } from './overscan';

const range = (startIndex: number, endIndex: number, count = 100) => ({
  startIndex,
  endIndex,
  count,
  overscan: 0,
});

describe('directionalRange', () => {
  it('renders more rows in the scroll direction', () => {
    expect(directionalRange(range(10, 12), true, 3, 1)).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(directionalRange(range(10, 12), false, 3, 1)).toEqual([7, 8, 9, 10, 11, 12, 13]);
  });

  it('stays within the list', () => {
    expect(directionalRange(range(0, 2, 4), true, 5, 5)).toEqual([0, 1, 2, 3]);
    expect(directionalRange(range(0, -1, 0), true, 5, 5)).toEqual([]);
  });
});
