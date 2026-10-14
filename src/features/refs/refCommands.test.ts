import { describe, expect, it } from 'vitest';

import type { RefTarget } from '../sidebar/sidebarRows';
import { branchStartOf, checkoutTargetOf } from './refCommands';

const local: RefTarget = {
  kind: 'local',
  branch: {
    name: 'feat/x',
    fullName: 'refs/heads/feat/x',
    sha: 'a1',
    isHead: false,
    upstream: null,
    row: 3,
  },
};
const remote: RefTarget = {
  kind: 'remote',
  remote: 'origin',
  branch: { name: 'origin/feat/x', fullName: 'refs/remotes/origin/feat/x', sha: 'a1', row: 3 },
};
const tag: RefTarget = {
  kind: 'tag',
  tag: { name: 'v1', fullName: 'refs/tags/v1', sha: 'b2', annotated: false, message: null, row: 1 },
};
const stash: RefTarget = {
  kind: 'stash',
  stash: {
    index: 2,
    name: 'stash@{2}',
    message: 'WIP',
    sha: 'c3',
    baseSha: 'd4',
    untrackedSha: null,
    row: null,
  },
};

describe('checkoutTargetOf', () => {
  it('maps each checkable ref to its checkout target', () => {
    expect(checkoutTargetOf(local)).toEqual({ kind: 'branch', name: 'feat/x' });
    expect(checkoutTargetOf(remote)).toEqual({ kind: 'remote', name: 'origin/feat/x' });
    expect(checkoutTargetOf(tag)).toEqual({ kind: 'detached', rev: 'v1' });
  });

  it('leaves stashes and unborn HEADs alone', () => {
    expect(checkoutTargetOf(stash)).toBeNull();
    expect(checkoutTargetOf({ kind: 'head', head: { kind: 'unborn', name: 'main' } })).toBeNull();
  });
});

describe('branchStartOf', () => {
  it('starts from the full ref name, so a remote branch becomes tracked', () => {
    expect(branchStartOf(remote)?.from).toEqual({
      kind: 'ref',
      fullName: 'refs/remotes/origin/feat/x',
    });
    expect(branchStartOf(tag)?.from).toEqual({ kind: 'ref', fullName: 'refs/tags/v1' });
  });

  it('starts from the stash id, which guards against a stale list', () => {
    expect(branchStartOf(stash)?.from).toEqual({
      kind: 'stash',
      stash: { index: 2, sha: 'c3' },
    });
  });

  it('has no start for a branchless HEAD', () => {
    expect(branchStartOf({ kind: 'head', head: { kind: 'unborn', name: 'main' } })).toBeNull();
  });
});
