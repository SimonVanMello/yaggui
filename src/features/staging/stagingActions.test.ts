import { afterEach, describe, expect, it, vi } from 'vitest';

import { useConfirmStore } from '../../app/errors/confirmStore';
import { queryClient } from '../../app/queryClient';
import { ipc, type DiffOptions, type FileDiff, type YagguiError } from '../../ipc';
import { useToastStore } from '../../ui/toastStore';
import { applyHunks } from './stagingActions';

const options: DiffOptions = {
  ignoreWhitespace: false,
  contextLines: 3,
  fullFile: false,
  force: false,
};

const diff: FileDiff = {
  path: 'src/a.ts',
  oldPath: null,
  oldId: 'old-blob',
  newId: 'new-blob',
  oldMode: 'regular',
  newMode: 'regular',
  content: { kind: 'conflict' },
};

const stale: YagguiError = {
  code: 'staleDiff',
  message: { en: 'stale', fr: 'périmé' },
  action: { kind: 'refresh' },
  detail: null,
  payload: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
  useConfirmStore.getState().settle(false);
});

describe('applyHunks', () => {
  it('sends the blob ids and options the diff was read with', async () => {
    const stage = vi
      .spyOn(ipc.commands, 'stageHunks')
      .mockResolvedValue({ status: 'ok', data: null });
    const hunks = [{ id: 'h0', lines: [1, 2] }];
    await expect(
      applyHunks({ repoId: 7, action: 'stage', diff, options, hunks, lineCount: 2 }),
    ).resolves.toBe(true);
    expect(stage).toHaveBeenCalledWith(7, {
      path: 'src/a.ts',
      oldPath: null,
      oldId: 'old-blob',
      newId: 'new-blob',
      options,
      hunks,
    });
  });

  it('refreshes the diff and warns on a stale diff', async () => {
    vi.spyOn(ipc.commands, 'unstageHunks').mockResolvedValue({ status: 'error', error: stale });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    await expect(
      applyHunks({
        repoId: 7,
        action: 'unstage',
        diff,
        options,
        hunks: [{ id: 'h0', lines: null }],
        lineCount: 3,
      }),
    ).resolves.toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['diff', 7, 'worktree'] });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ variant: 'warning' });
    expect(toasts[0]?.description).toContain('src/a.ts');
  });

  it('asks before discarding lines, and does nothing when declined', async () => {
    const discard = vi.spyOn(ipc.commands, 'discardHunks');
    const pending = applyHunks({
      repoId: 7,
      action: 'discard',
      diff,
      options,
      hunks: [{ id: 'h0', lines: [1] }],
      lineCount: 1,
    });
    expect(useConfirmStore.getState().pending?.danger).toBe(true);
    useConfirmStore.getState().settle(false);
    await expect(pending).resolves.toBe(false);
    expect(discard).not.toHaveBeenCalled();
  });

  it('sends nothing for an empty selection', async () => {
    const stage = vi.spyOn(ipc.commands, 'stageHunks');
    await expect(
      applyHunks({ repoId: 7, action: 'stage', diff, options, hunks: [], lineCount: 0 }),
    ).resolves.toBe(false);
    expect(stage).not.toHaveBeenCalled();
  });
});
