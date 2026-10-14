import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_UI,
  MAX_RECENT,
  parseSidebarUiState,
  pushRecent,
  setNodeOpen,
} from './sidebarUiState';

describe('sidebarUiState', () => {
  it('falls back to defaults on missing or bad data', () => {
    expect(parseSidebarUiState(null)).toBe(DEFAULT_SIDEBAR_UI);
    expect(parseSidebarUiState('{nope')).toBe(DEFAULT_SIDEBAR_UI);
    expect(parseSidebarUiState('{"sidebar":3}')).toBe(DEFAULT_SIDEBAR_UI);
  });

  it('parses a saved state and drops invalid entries', () => {
    const json = JSON.stringify({
      sidebar: { open: { a: true, b: 'x' }, flat: true, recent: ['m', 4, 'n'] },
    });
    expect(parseSidebarUiState(json)).toEqual({
      open: { a: true },
      flat: true,
      recent: ['m', 'n'],
    });
  });

  it('setNodeOpen overrides a key and moves it last', () => {
    let state = setNodeOpen(DEFAULT_SIDEBAR_UI, 'a', true);
    state = setNodeOpen(state, 'b', false);
    state = setNodeOpen(state, 'a', false);
    expect(Object.entries(state.open)).toEqual([
      ['b', false],
      ['a', false],
    ]);
  });

  it('setNodeOpen bounds the map size', () => {
    let state = DEFAULT_SIDEBAR_UI;
    for (let i = 0; i < 600; i++) state = setNodeOpen(state, `k${i}`, true);
    expect(Object.keys(state.open)).toHaveLength(500);
    expect(state.open['k0']).toBeUndefined();
    expect(state.open['k599']).toBe(true);
  });

  it('pushRecent dedupes, puts the newest first and bounds the list', () => {
    let state = pushRecent(pushRecent(DEFAULT_SIDEBAR_UI, 'a'), 'b');
    state = pushRecent(state, 'a');
    expect(state.recent).toEqual(['a', 'b']);
    for (let i = 0; i < 30; i++) state = pushRecent(state, `x${i}`);
    expect(state.recent).toHaveLength(MAX_RECENT);
    expect(state.recent[0]).toBe('x29');
  });
});
