import { describe, expect, it } from 'vitest';

import {
  COMMON_FIELDS,
  configValues,
  filterEntries,
  multiValuedKeys,
  normalizeConfigKey,
} from './gitConfigLogic';

describe('normalizeConfigKey', () => {
  it('lowercases the section and the variable, not the subsection', () => {
    expect(normalizeConfigKey('User.Name')).toBe('user.name');
    expect(normalizeConfigKey('init.defaultBranch')).toBe('init.defaultbranch');
    expect(normalizeConfigKey('branch.Feat/X.Remote')).toBe('branch.Feat/X.remote');
  });
});

describe('configValues', () => {
  it('keeps the last value and reads a bare key as true', () => {
    const values = configValues([
      { key: 'user.name', value: 'A' },
      { key: 'core.bare', value: null },
      { key: 'user.name', value: 'B' },
    ]);
    expect(values.get('user.name')).toBe('B');
    expect(values.get('core.bare')).toBe('true');
  });

  it('finds the common keys whatever the case Git printed', () => {
    const values = configValues([{ key: 'init.defaultbranch', value: 'main' }]);
    const field = COMMON_FIELDS.find((f) => f.key === 'init.defaultBranch');
    expect(values.get(normalizeConfigKey(field?.key ?? ''))).toBe('main');
  });
});

describe('multiValuedKeys', () => {
  it('lists the keys set more than once', () => {
    const multiple = multiValuedKeys([
      { key: 'remote.origin.fetch', value: 'a' },
      { key: 'user.name', value: 'x' },
      { key: 'remote.origin.fetch', value: 'b' },
    ]);
    expect([...multiple]).toEqual(['remote.origin.fetch']);
  });
});

describe('filterEntries', () => {
  const entries = [
    { key: 'user.name', value: 'Ada' },
    { key: 'core.bare', value: null },
    { key: 'alias.co', value: 'checkout' },
  ];
  it('matches keys and values, case-insensitively', () => {
    expect(filterEntries(entries, 'ADA')).toHaveLength(1);
    expect(filterEntries(entries, 'check')).toHaveLength(1);
    expect(filterEntries(entries, '')).toHaveLength(3);
    expect(filterEntries(entries, 'bare')).toEqual([{ key: 'core.bare', value: null }]);
  });
});

describe('common fields (F-325)', () => {
  it('cover identity, pull.rebase, core.autocrlf, init.defaultBranch and signing', () => {
    const keys = COMMON_FIELDS.map((f) => f.key);
    for (const key of [
      'user.name',
      'user.email',
      'pull.rebase',
      'core.autocrlf',
      'init.defaultBranch',
      'commit.gpgsign',
      'user.signingkey',
    ]) {
      expect(keys).toContain(key);
    }
  });
});
