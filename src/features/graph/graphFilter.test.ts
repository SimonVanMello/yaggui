import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTER,
  isFilterActive,
  isHidden,
  shortName,
  toggleHidden,
  toggleSolo,
} from './graphFilter';

describe('graph filter helpers', () => {
  it('hides and shows a ref again', () => {
    const hidden = toggleHidden(EMPTY_FILTER, 'refs/heads/a');
    expect(hidden.hidden).toEqual(['refs/heads/a']);
    expect(isHidden(hidden, 'refs/heads/a')).toBe(true);
    expect(isFilterActive(hidden)).toBe(true);
    expect(toggleHidden(hidden, 'refs/heads/a')).toEqual(EMPTY_FILTER);
  });

  it('solo replaces hiding the same ref, and toggles off', () => {
    const solo = toggleSolo(toggleHidden(EMPTY_FILTER, 'refs/heads/a'), 'refs/heads/a');
    expect(solo).toEqual({ ...EMPTY_FILTER, solo: 'refs/heads/a' });
    expect(toggleSolo(solo, 'refs/heads/a')).toEqual(EMPTY_FILTER);
    // Hiding the soloed ref leaves solo mode.
    expect(toggleHidden(solo, 'refs/heads/a').solo).toBeNull();
  });

  it('hides every remote branch at once', () => {
    const filter = { ...EMPTY_FILTER, hideRemotes: true };
    expect(isHidden(filter, 'refs/remotes/origin/main')).toBe(true);
    expect(isHidden(filter, 'refs/heads/main')).toBe(false);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it('shortens names', () => {
    expect(shortName('refs/remotes/origin/x')).toBe('origin/x');
    expect(shortName('refs/heads/feat/y')).toBe('feat/y');
    expect(shortName('HEAD')).toBe('HEAD');
  });
});
