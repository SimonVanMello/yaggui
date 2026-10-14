import { describe, expect, it } from 'vitest';

import { KEEP_ALIVE_TABS, sameIds, touchRecent } from './keepAlive';

const all = (...ids: string[]) => new Set(ids);

describe('touchRecent', () => {
  it('puts the active tab first and keeps the previous ones in recency order', () => {
    let recent = touchRecent([], 'a', all('a', 'b', 'c'));
    recent = touchRecent(recent, 'b', all('a', 'b', 'c'));
    recent = touchRecent(recent, 'c', all('a', 'b', 'c'));
    expect(recent).toEqual(['c', 'b', 'a']);
    expect(touchRecent(recent, 'a', all('a', 'b', 'c'))).toEqual(['a', 'c', 'b']);
  });

  it('drops the least recently shown tab beyond the limit', () => {
    const recent = ['c', 'b', 'a'];
    expect(touchRecent(recent, 'd', all('a', 'b', 'c', 'd'), 3)).toEqual(['d', 'c', 'b']);
    expect(touchRecent(recent, 'd', all('a', 'b', 'c', 'd'), 2)).toEqual(['d', 'c']);
    expect(touchRecent(['a'], 'a', all('a'), 1)).toEqual(['a']);
  });

  it('forgets closed and non-keepable tabs, but always keeps the active one', () => {
    // `b` was closed; `w` (a welcome tab) is not keepable once hidden.
    expect(touchRecent(['w', 'b', 'a'], 'c', all('a', 'c'))).toEqual(['c', 'a']);
    expect(touchRecent(['a'], 'w', all('a'))).toEqual(['w', 'a']);
  });

  it('keeps three views by default', () => {
    expect(KEEP_ALIVE_TABS).toBe(3);
    const ids = all('a', 'b', 'c', 'd', 'e');
    let recent: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) recent = touchRecent(recent, id, ids);
    expect(recent).toEqual(['e', 'd', 'c']);
  });
});

describe('sameIds', () => {
  it('compares order and content', () => {
    expect(sameIds(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
  });
});
