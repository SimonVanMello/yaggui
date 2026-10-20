import { afterEach, describe, expect, it, vi } from 'vitest';

import { useConfirmStore } from '../../app/errors/confirmStore';
import { ipc, type YagguiError } from '../../ipc';
import { useToastStore } from '../../ui/toastStore';
import { useRefDialogs } from './refDialogsStore';
import { checkout, createBranch, deleteBranch, stashDrop, stashPop } from './refOps';

function error(code: YagguiError['code'], payload: YagguiError['payload'] = null): YagguiError {
  return { code, message: { en: code, fr: code }, action: null, detail: null, payload };
}

const fail = (e: YagguiError) => ({ status: 'error' as const, error: e });

afterEach(() => {
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
  useRefDialogs.getState().close();
  useConfirmStore.getState().settle(false);
});

describe('checkout', () => {
  it('opens the dirty-tree dialog with the files and what carrying allows', async () => {
    vi.spyOn(ipc.commands, 'checkout').mockResolvedValue(
      fail(error('dirtyWorktree', { kind: 'dirtyWorktree', paths: ['a.ts'], canCarry: false })),
    );
    await expect(checkout(1, { kind: 'branch', name: 'dev' })).resolves.toBe(false);
    expect(useRefDialogs.getState().dialog).toEqual({
      kind: 'dirtyCheckout',
      repoId: 1,
      target: { kind: 'branch', name: 'dev' },
      label: 'dev',
      paths: ['a.ts'],
      canCarry: false,
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('explains a stash conflict instead of toasting it', async () => {
    vi.spyOn(ipc.commands, 'checkout').mockResolvedValue(
      fail(
        error('stashConflict', {
          kind: 'stashConflict',
          paths: ['b.ts'],
          stashSha: 'abc',
          checkedOut: true,
        }),
      ),
    );
    await checkout(1, { kind: 'branch', name: 'dev' }, 'stashAndPop');
    expect(useRefDialogs.getState().dialog).toEqual({
      kind: 'stashConflict',
      repoId: 1,
      paths: ['b.ts'],
      checkedOut: true,
    });
  });

  it('asks for the requested mode and reports success', async () => {
    const spy = vi.spyOn(ipc.commands, 'checkout').mockResolvedValue({
      status: 'ok',
      data: { branch: 'dev', created: true, fastForwarded: null },
    });
    await expect(checkout(1, { kind: 'remote', name: 'origin/dev' }, 'carry')).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith(1, { kind: 'remote', name: 'origin/dev' }, 'carry');
    expect(useToastStore.getState().toasts[0]?.variant).toBe('success');
  });

  it('says when the local branch was brought up to the remote one', async () => {
    vi.spyOn(ipc.commands, 'checkout').mockResolvedValue({
      status: 'ok',
      data: { branch: 'dev', created: false, fastForwarded: 'origin/dev' },
    });
    await checkout(1, { kind: 'remote', name: 'origin/dev' });
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.title).toBe('Switched to dev');
    expect(toast?.description).toBe('Updated to origin/dev, which it was behind.');
  });
});

describe('stale lists', () => {
  it('warns instead of failing when a stash changed under the user', async () => {
    vi.spyOn(ipc.commands, 'stashPop').mockResolvedValue(fail(error('staleRefs')));
    await expect(stashPop(1, { index: 0, sha: 'old' })).resolves.toBe(false);
    const [toast] = useToastStore.getState().toasts;
    expect(toast?.variant).toBe('warning');
  });
});

describe('createBranch', () => {
  it('hands name errors back to the dialog without a toast', async () => {
    vi.spyOn(ipc.commands, 'createBranch').mockResolvedValue(fail(error('refExists')));
    const result = await createBranch(1, 'main', { kind: 'head' }, true);
    expect(result).toMatchObject({ ok: false, handled: false });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe('stashDrop', () => {
  it('does nothing unless confirmed', async () => {
    const drop = vi.spyOn(ipc.commands, 'stashDrop');
    const pending = stashDrop(1, { index: 0, sha: 's' }, 'WIP');
    expect(useConfirmStore.getState().pending?.danger).toBe(true);
    useConfirmStore.getState().settle(false);
    await expect(pending).resolves.toBe(false);
    expect(drop).not.toHaveBeenCalled();
  });
});

describe('deleteBranch', () => {
  it('warns when only the remote deletion failed', async () => {
    vi.spyOn(ipc.commands, 'deleteBranch').mockResolvedValue({
      status: 'ok',
      data: {
        local: { fullName: 'refs/heads/x', sha: 'abcdef123' },
        remote: null,
        remoteError: error('gitFailed'),
      },
    });
    const result = await deleteBranch(1, { name: 'x', force: false, deleteRemote: true });
    expect(result.ok).toBe(true);
    expect(useToastStore.getState().toasts[0]?.variant).toBe('warning');
  });
});
