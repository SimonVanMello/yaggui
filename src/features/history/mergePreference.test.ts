import { beforeEach, describe, expect, it } from 'vitest';

import { rememberMergeMode, rememberedMergeMode } from './mergePreference';

beforeEach(() => {
  window.localStorage.clear();
});

describe('merge mode memory', () => {
  it('starts with fast-forward when possible', () => {
    expect(rememberedMergeMode()).toBe('fastForward');
  });

  it('proposes the mode chosen last', () => {
    rememberMergeMode('squash');
    expect(rememberedMergeMode()).toBe('squash');
    rememberMergeMode('noFastForward');
    expect(rememberedMergeMode()).toBe('noFastForward');
  });

  it('ignores a value it does not know, and the gesture-only mode', () => {
    window.localStorage.setItem('yaggui.history.mergeMode', 'fastForwardOnly');
    expect(rememberedMergeMode()).toBe('fastForward');
    window.localStorage.setItem('yaggui.history.mergeMode', 'nonsense');
    expect(rememberedMergeMode()).toBe('fastForward');
  });
});
