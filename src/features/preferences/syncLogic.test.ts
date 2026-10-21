import { describe, expect, it } from 'vitest';

import type { PreferencesImportPreview } from '../../ipc';
import { formatPrefValue, hasChanges, ignoredKeys, preferenceLabel } from './syncLogic';

const words = { none: 'default', yes: 'on', no: 'off', empty: 'none' };

describe('formatPrefValue', () => {
  it('shows scalars as a person reads them', () => {
    expect(formatPrefValue('true', words)).toBe('on');
    expect(formatPrefValue('false', words)).toBe('off');
    expect(formatPrefValue('null', words)).toBe('default');
    expect(formatPrefValue('14', words)).toBe('14');
    expect(formatPrefValue('"dark"', words)).toBe('dark');
    expect(formatPrefValue('""', words)).toBe('none');
  });
  it('joins lists and objects', () => {
    expect(formatPrefValue('["main","release/*"]', words)).toBe('main, release/*');
    expect(formatPrefValue('[]', words)).toBe('none');
    expect(formatPrefValue('{"wrap":true,"contextLines":3}', words)).toBe(
      'wrap: on, contextLines: 3',
    );
  });
  it('keeps text that is not JSON', () => {
    expect(formatPrefValue('{oops', words)).toBe('{oops');
  });
});

describe('preview helpers', () => {
  const preview: PreferencesImportPreview = {
    path: '/tmp/p.json',
    changes: [],
    keybindingChanges: [],
    ignored: [
      { key: 'gitPath', reason: 'machineSpecific' },
      { key: 'later', reason: 'unknown' },
      { key: 'editor', reason: 'machineSpecific' },
    ],
  };
  it('groups the left-out keys by reason', () => {
    expect(ignoredKeys(preview, 'machineSpecific')).toEqual(['gitPath', 'editor']);
    expect(ignoredKeys(preview, 'unknown')).toEqual(['later']);
  });
  it('tells when the file changes nothing', () => {
    expect(hasChanges(preview)).toBe(false);
    expect(
      hasChanges({ ...preview, changes: [{ key: 'theme', before: '"a"', after: '"b"' }] }),
    ).toBe(true);
  });
  it('knows the label of a setting', () => {
    expect(preferenceLabel('fontSize')).toBe('prefs.sync.key.fontSize');
    expect(preferenceLabel('nope')).toBeNull();
  });
});
