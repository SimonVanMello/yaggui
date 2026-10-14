import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { ipc, type HeadState, type RepoState } from '../../ipc';
import { useToastStore } from '../../ui/toastStore';
import type { RefTarget } from '../sidebar/sidebarRows';
import { branchStartOf, checkoutTargetOf, openCreateTagFromHead } from './refCommands';
import { useRefDialogs } from './refDialogsStore';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  useToastStore.setState({ toasts: [] });
  useRefDialogs.getState().close();
});

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

describe('openCreateTagFromHead', () => {
  const OID = '0123456789abcdef0123456789abcdef01234567';

  function withHead(head: HeadState) {
    const state: RepoState = {
      head,
      upstream: null,
      dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      operation: null,
      indexLock: null,
    };
    vi.spyOn(ipc.commands, 'repoState').mockResolvedValue({ status: 'ok', data: state });
  }

  it('targets the commit HEAD points to, labelled with the branch', async () => {
    withHead({ kind: 'branch', name: 'main', oid: OID });
    await openCreateTagFromHead(1);
    expect(useRefDialogs.getState().dialog).toEqual({
      kind: 'createTag',
      repoId: 1,
      target: OID,
      targetLabel: 'main',
    });
  });

  it('labels a detached HEAD with its short SHA', async () => {
    withHead({ kind: 'detached', oid: OID });
    await openCreateTagFromHead(1);
    expect(useRefDialogs.getState().dialog).toMatchObject({ target: OID, targetLabel: '0123456' });
  });

  it('opens nothing on an unborn HEAD and says why', async () => {
    withHead({ kind: 'unborn', name: 'main' });
    await openCreateTagFromHead(1);
    expect(useRefDialogs.getState().dialog).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
