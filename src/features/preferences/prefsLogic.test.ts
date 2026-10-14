import { describe, expect, it } from 'vitest';

import {
  addProtectedBranch,
  canAddProtectedBranch,
  clampInt,
  gitStatus,
  removeProtectedBranch,
  setConfirmation,
} from './prefsLogic';

describe('protected branches', () => {
  const list = ['main', 'release/*'];
  it('adds a trimmed pattern at the end', () => {
    expect(addProtectedBranch(list, '  hotfix/* ')).toEqual(['main', 'release/*', 'hotfix/*']);
  });
  it('ignores empty, duplicated or spaced entries', () => {
    expect(addProtectedBranch(list, '  ')).toEqual(list);
    expect(addProtectedBranch(list, 'main')).toEqual(list);
    expect(addProtectedBranch(list, 'my branch')).toEqual(list);
    expect(canAddProtectedBranch(list, 'main')).toBe(false);
    expect(canAddProtectedBranch(list, 'dev')).toBe(true);
  });
  it('removes a pattern', () => {
    expect(removeProtectedBranch(list, 'main')).toEqual(['release/*']);
    expect(removeProtectedBranch(list, 'nope')).toEqual(list);
  });
});

describe('setConfirmation', () => {
  it('turns a confirmation off and on', () => {
    expect(setConfirmation([], 'dropStash', false)).toEqual(['dropStash']);
    expect(setConfirmation(['dropStash'], 'dropStash', false)).toEqual(['dropStash']);
    expect(setConfirmation(['dropStash', 'deleteTag'], 'dropStash', true)).toEqual(['deleteTag']);
  });
  it('never turns the force push confirmation off', () => {
    expect(setConfirmation([], 'forcePush', false)).toEqual([]);
    expect(setConfirmation(['forcePush', 'deleteTag'], 'forcePush', false)).toEqual(['deleteTag']);
  });
});

describe('clampInt', () => {
  it('clamps and falls back', () => {
    expect(clampInt('999', 1, 240, 10)).toBe(240);
    expect(clampInt('0', 1, 240, 10)).toBe(1);
    expect(clampInt(' 15 ', 1, 240, 10)).toBe(15);
    expect(clampInt('abc', 1, 240, 10)).toBe(10);
  });
});

describe('gitStatus', () => {
  const base = { path: '/usr/bin/git', minVersion: '2.30', error: null };
  it('is ok for a supported version', () => {
    expect(gitStatus({ ...base, version: '2.47.1', supported: true })).toEqual({
      kind: 'ok',
      version: '2.47.1',
      path: '/usr/bin/git',
    });
  });
  it('warns below the minimum', () => {
    expect(gitStatus({ ...base, version: '2.25.1', supported: false })).toEqual({
      kind: 'old',
      version: '2.25.1',
      path: '/usr/bin/git',
      min: '2.30',
    });
  });
  it('tells a missing Git from a broken one', () => {
    const none = { ...base, version: null, supported: false };
    expect(gitStatus({ ...none, error: { code: 'gitNotFound' } })).toEqual({
      kind: 'error',
      reason: 'notFound',
    });
    expect(gitStatus({ ...none, error: { code: 'gitBinaryInvalid' } })).toEqual({
      kind: 'error',
      reason: 'invalid',
    });
  });
});
