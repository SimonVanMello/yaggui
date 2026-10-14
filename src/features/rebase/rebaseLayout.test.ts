import { describe, expect, it } from 'vitest';

import {
  flipIndex,
  isNoopSlot,
  joinMessage,
  moveFocus,
  moveOnScreen,
  moveToSlot,
  rowsMatchPlan,
  slotAt,
  splitMessage,
} from './rebaseLayout';
import type { RebaseRow } from './rebaseModel';

function rows(count: number): RebaseRow[] {
  return Array.from({ length: count }, (_, i) => ({
    commit: {
      sha: `sha${String(i)}`,
      summary: `c${String(i)}`,
      message: `c${String(i)}`,
      authorName: 'a',
      authorEmail: 'a@b.c',
      authorTime: 0,
      merge: false,
      pushed: false,
    },
    action: 'pick',
    message: null,
  }));
}

const order = (list: readonly RebaseRow[]) => list.map((row) => row.commit.summary).join(',');

describe('index mapping', () => {
  it('flips between screen and todo order', () => {
    expect(flipIndex(0, 4)).toBe(3);
    expect(flipIndex(flipIndex(1, 4), 4)).toBe(1);
  });
});

describe('keyboard moves', () => {
  it('moves a row up (towards newer) and down, clamped', () => {
    const start = rows(4);
    const up = moveOnScreen(start, 1, 'up');
    expect(order(up.rows)).toBe('c0,c2,c1,c3');
    expect(up.index).toBe(2);
    const down = moveOnScreen(start, 1, 'down');
    expect(order(down.rows)).toBe('c1,c0,c2,c3');
    expect(down.index).toBe(0);
    expect(moveOnScreen(start, 3, 'up').index).toBe(3);
    expect(order(moveOnScreen(start, 0, 'down').rows)).toBe('c0,c1,c2,c3');
  });

  it('moves the focus on screen', () => {
    expect(moveFocus(2, 4, 'up')).toBe(3);
    expect(moveFocus(3, 4, 'up')).toBe(3);
    expect(moveFocus(0, 4, 'down')).toBe(0);
  });
});

describe('pointer drops', () => {
  it('finds the slot under the pointer', () => {
    expect(slotAt(5, [10, 30, 50])).toBe(0);
    expect(slotAt(35, [10, 30, 50])).toBe(2);
    expect(slotAt(90, [10, 30, 50])).toBe(3);
  });

  it('moves a row to a slot of the screen order', () => {
    // Screen order is c3, c2, c1, c0. Drag c0 (screen 3) above everything.
    const top = moveToSlot(rows(4), 0, 0);
    expect(order(top.rows)).toBe('c1,c2,c3,c0');
    expect(top.index).toBe(3);
    // Drag c3 (screen 0) below everything.
    const bottom = moveToSlot(rows(4), 3, 4);
    expect(order(bottom.rows)).toBe('c3,c0,c1,c2');
    expect(bottom.index).toBe(0);
    // Drag c3 into the gap between c1 and c0 (slot 3).
    expect(order(moveToSlot(rows(4), 3, 3).rows)).toBe('c0,c3,c1,c2');
  });

  it('knows the slots that change nothing', () => {
    expect(isNoopSlot(3, 0, 4)).toBe(true);
    expect(isNoopSlot(3, 1, 4)).toBe(true);
    expect(isNoopSlot(3, 2, 4)).toBe(false);
    expect(order(moveToSlot(rows(4), 3, 1).rows)).toBe('c0,c1,c2,c3');
  });
});

describe('messages', () => {
  it('splits and joins like the commit box', () => {
    expect(splitMessage('Title')).toEqual({ summary: 'Title', description: '' });
    expect(splitMessage('Title\n\nBody\n# kept')).toEqual({
      summary: 'Title',
      description: 'Body\n# kept',
    });
    expect(joinMessage('Title', '')).toBe('Title');
    expect(joinMessage('Title', 'Body\n\n  \n')).toBe('Title\n\nBody');
    expect(splitMessage(joinMessage('', 'only body'))).toEqual({
      summary: '',
      description: 'only body',
    });
  });
});

describe('rowsMatchPlan', () => {
  it('compares the commits regardless of the order', () => {
    const list = rows(3);
    const plan = { commits: [...list].reverse().map((row) => ({ sha: row.commit.sha })) };
    expect(rowsMatchPlan(list, plan)).toBe(true);
    expect(rowsMatchPlan(list.slice(1), plan)).toBe(false);
    expect(rowsMatchPlan(list, { commits: [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }] })).toBe(
      false,
    );
  });
});
