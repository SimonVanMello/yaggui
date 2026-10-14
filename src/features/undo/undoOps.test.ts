import { afterEach, describe, expect, it, vi } from 'vitest';

import { useConfirmStore } from '../../app/errors/confirmStore';
import { ipc, type YagguiError, type JournalEntry } from '../../ipc';
import { useToastStore } from '../../ui/toastStore';
import { runUndo } from './undoOps';

function error(code: YagguiError['code'], payload: YagguiError['payload'] = null): YagguiError {
  return { code, message: { en: code, fr: code }, action: null, detail: null, payload };
}

const fail = (e: YagguiError) => ({ status: 'error' as const, error: e });

const entry: JournalEntry = {
  id: 1,
  op: { kind: 'commit', sha: 'abc1234', summary: 'feat: login' },
  at: 1_000,
  undone: true,
  blocked: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
  useConfirmStore.getState().settle(false);
});

describe('runUndo', () => {
  it('toasts what was undone and redone', async () => {
    vi.spyOn(ipc.commands, 'undo').mockResolvedValue({ status: 'ok', data: entry });
    vi.spyOn(ipc.commands, 'redo').mockResolvedValue({ status: 'ok', data: entry });
    await expect(runUndo(1, 'undo')).resolves.toBe(true);
    await expect(runUndo(1, 'redo')).resolves.toBe(true);
    const titles = useToastStore.getState().toasts.map((toast) => toast.title);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toMatch(/^(Undone|Annulé).*feat: login/);
    expect(titles[1]).toMatch(/^(Redone|Rétabli).*feat: login/);
  });

  it('ignores a second undo while the first one runs', async () => {
    const spy = vi.spyOn(ipc.commands, 'undo').mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ status: 'ok', data: entry });
          }, 10);
        }),
    );
    const results = await Promise.all([runUndo(1, 'undo'), runUndo(1, 'undo')]);
    expect(results).toEqual([true, false]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('explains a blocked operation in a warning toast', async () => {
    vi.spyOn(ipc.commands, 'undo').mockResolvedValue(
      fail(error('undoBlocked', { kind: 'undoBlocked', reason: { kind: 'published' } })),
    );
    await expect(runUndo(1, 'undo')).resolves.toBe(false);
    expect(useToastStore.getState().toasts[0]?.variant).toBe('warning');
  });

  it('explains a divergence in a dialog listing refs and files', async () => {
    vi.spyOn(ipc.commands, 'undo').mockResolvedValue(
      fail(
        error('undoDiverged', {
          kind: 'undoChanges',
          refs: ['refs/heads/main'],
          paths: ['src/a.ts'],
        }),
      ),
    );
    const done = runUndo(1, 'undo');
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    const pending = useConfirmStore.getState().pending;
    expect(pending?.informational).toBe(true);
    expect(pending?.items?.map((item) => item.label)).toEqual(['main', 'src/a.ts']);
    useConfirmStore.getState().settle(true);
    await expect(done).resolves.toBe(false);
  });

  it('asks before stashing local changes in the way, then retries', async () => {
    const undo = vi
      .spyOn(ipc.commands, 'undo')
      .mockResolvedValueOnce(
        fail(error('undoWouldOverwrite', { kind: 'undoChanges', refs: [], paths: ['a.ts'] })),
      )
      .mockResolvedValueOnce({ status: 'ok', data: entry });
    const stash = vi
      .spyOn(ipc.commands, 'stashPush')
      .mockResolvedValue({ status: 'ok', data: { sha: 'abc1234', message: 'WIP' } });
    const done = runUndo(1, 'undo');
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.items?.[0]?.label).toBe('a.ts');
    });
    expect(stash).not.toHaveBeenCalled();
    useConfirmStore.getState().settle(true);
    await done;
    expect(stash).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(2);
  });

  it('leaves everything alone when the confirmation is declined', async () => {
    vi.spyOn(ipc.commands, 'undo').mockResolvedValue(
      fail(error('undoWouldOverwrite', { kind: 'undoChanges', refs: [], paths: ['a.ts'] })),
    );
    const stash = vi.spyOn(ipc.commands, 'stashPush');
    const done = runUndo(1, 'undo');
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    useConfirmStore.getState().settle(false);
    await done;
    expect(stash).not.toHaveBeenCalled();
  });
});
