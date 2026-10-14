import { beforeEach, describe, expect, it } from 'vitest';

import { revealCommit, useGraphNavigation } from './graphNavigation';

const store = useGraphNavigation;

describe('graphNavigation', () => {
  beforeEach(() => {
    store.getState().clear(1);
    store.getState().clear(2);
  });

  it('selects the revealed commit and records the request', () => {
    revealCommit(1, 'abc', 12, 3);
    const state = store.getState();
    expect(state.selected[1]).toBe('abc');
    expect(state.reveal[1]).toMatchObject({ sha: 'abc', row: 12, version: 3 });
  });

  it('gives every request a new sequence number, even for the same commit', () => {
    revealCommit(1, 'abc', 12);
    const first = store.getState().reveal[1]?.seq ?? 0;
    revealCommit(1, 'abc', 12);
    expect(store.getState().reveal[1]?.seq).toBeGreaterThan(first);
  });

  it('keeps repositories apart', () => {
    revealCommit(1, 'abc', null);
    revealCommit(2, 'def', 4);
    expect(store.getState().selected).toMatchObject({ 1: 'abc', 2: 'def' });
    expect(store.getState().reveal[1]?.row).toBeNull();
  });

  it('selects without a reveal request, and clears', () => {
    store.getState().selectCommit(1, 'abc');
    expect(store.getState().selected[1]).toBe('abc');
    expect(store.getState().reveal[1]).toBeUndefined();
    store.getState().selectCommit(1, null);
    expect(store.getState().selected[1]).toBeUndefined();
    revealCommit(1, 'abc', 1);
    store.getState().clear(1);
    expect(store.getState().reveal[1]).toBeUndefined();
  });
});
