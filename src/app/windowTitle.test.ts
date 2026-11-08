import { describe, expect, it } from 'vitest';

import type { RepoState } from '../ipc';
import { formatWindowTitle, headLabel } from './windowTitle';

function state(head: RepoState['head'], operation: RepoState['operation'] = null): RepoState {
  return {
    head,
    upstream: null,
    dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    operation,
    indexLock: null,
  };
}

describe('formatWindowTitle', () => {
  it('names the repository and the branch, with the app name outside macOS', () => {
    const context = { repo: 'api-backoffice', branch: 'main' };
    expect(formatWindowTitle(context, 'mac')).toBe('api-backoffice · main');
    expect(formatWindowTitle(context, 'linux')).toBe('api-backoffice · main — yaggui');
    expect(formatWindowTitle(context, 'windows')).toBe('api-backoffice · main — yaggui');
  });

  it('is just "yaggui" without a repository (welcome tab)', () => {
    expect(formatWindowTitle(null, 'mac')).toBe('yaggui');
    expect(formatWindowTitle(null, 'linux')).toBe('yaggui');
  });

  it('shows the repository alone while its state loads', () => {
    expect(formatWindowTitle({ repo: 'yaggui', branch: null }, 'mac')).toBe('yaggui');
    expect(formatWindowTitle({ repo: 'web', branch: null }, 'linux')).toBe('web — yaggui');
  });
});

describe('headLabel', () => {
  it('is the branch, also an unborn one', () => {
    expect(headLabel(state({ kind: 'branch', name: 'feat/x', oid: 'a'.repeat(40) }))).toBe(
      'feat/x',
    );
    expect(headLabel(state({ kind: 'unborn', name: 'main' }))).toBe('main');
  });

  it('is the short SHA on a detached HEAD', () => {
    expect(headLabel(state({ kind: 'detached', oid: '0123456789abcdef' }))).toBe('0123456');
  });

  it('is the branch being rebased during a rebase', () => {
    const rebasing = state(
      { kind: 'detached', oid: '0123456789abcdef' },
      { kind: 'rebase', interactive: true, step: 1, total: 3, headName: 'feat/graph' },
    );
    expect(headLabel(rebasing)).toBe('feat/graph');
  });
});
