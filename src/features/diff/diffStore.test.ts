import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, loadPreferences } from '../../app/preferences';
import { unwrap } from '../../ipc';
import { mockBackend, mockClient } from '../../ipc/mockClient';
import {
  DEFAULT_DIFF_OPTIONS,
  hunkOptions,
  resolveDiffOptions,
  setDiffOptions,
  useDiffStore,
} from './diffStore';

beforeEach(() => {
  mockBackend.reset();
  useDiffStore.setState({ options: null });
});

describe('diff options', () => {
  it('falls back to the defaults, then to the stored preference', async () => {
    expect(resolveDiffOptions(null)).toEqual(DEFAULT_DIFF_OPTIONS);
    await mockClient.commands.setPreferences({
      ...DEFAULT_PREFERENCES,
      diffOptions: { wrap: true, ignoreWhitespace: false, contextLines: 10, fullFile: false },
    });
    await loadPreferences(mockClient, null);
    expect(resolveDiffOptions(null)).toMatchObject({ wrap: true, contextLines: 10 });
  });

  it('persists each change and keeps the other options', async () => {
    await loadPreferences(mockClient, null);
    setDiffOptions({ wrap: true });
    setDiffOptions({ contextLines: 25 });
    expect(useDiffStore.getState().options).toEqual({
      ...DEFAULT_DIFF_OPTIONS,
      wrap: true,
      contextLines: 25,
    });
    await new Promise((resolve) => setTimeout(resolve));
    const stored = await unwrap(mockClient.commands.getPreferences());
    expect(stored.diffOptions).toEqual({
      ...DEFAULT_DIFF_OPTIONS,
      wrap: true,
      contextLines: 25,
    });
  });

  it('leaves out wrap from the options that decide the hunks', () => {
    expect(hunkOptions({ ...DEFAULT_DIFF_OPTIONS, wrap: true })).toEqual({
      ignoreWhitespace: false,
      contextLines: 3,
      fullFile: false,
    });
  });
});
