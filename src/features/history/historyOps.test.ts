import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToastStore } from '../../ui/toastStore';
import type { YagguiError } from '../../ipc';
import { useHistoryDialogs } from './historyDialogsStore';

vi.mock('../graph/graphSource', () => ({
  asYagguiError: (error: unknown) => error,
  getGraphSource: () => ({ selectWip: vi.fn() }),
  invalidateGraph: vi.fn(),
}));

const { abortCommand, reportHistoryError } = await import('./historyOps');

function error(code: YagguiError['code'], payload: YagguiError['payload'] = null): YagguiError {
  return {
    code,
    message: { en: `en:${code}`, fr: `fr:${code}` },
    action: null,
    detail: null,
    payload,
  };
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useHistoryDialogs.setState({ dialog: null });
});

const toasts = () => useToastStore.getState().toasts;

describe('reportHistoryError', () => {
  it('turns a conflict stop into a warning that shows the conflicts, not an error', () => {
    reportHistoryError(
      1,
      error('conflicts', {
        kind: 'conflicts',
        operation: { kind: 'merge', squash: false },
        paths: ['a', 'b'],
      }),
      { op: 'merge' },
    );
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.variant).toBe('warning');
    expect(toasts()[0]?.description).toContain('2');
    expect(toasts()[0]?.action?.label).toBe('Show conflicts');
  });

  it('opens the parent dialog when a merge needs its mainline', () => {
    reportHistoryError(1, error('mainlineRequired'), {
      op: 'revert',
      onMainlineRequired: () => {
        useHistoryDialogs
          .getState()
          .open({ kind: 'parent', repoId: 1, op: 'revert', shas: ['a'], target: null });
      },
    });
    expect(useHistoryDialogs.getState().dialog).toMatchObject({ kind: 'parent', op: 'revert' });
    expect(toasts()).toHaveLength(0);
  });

  it('offers to skip an empty commit', () => {
    reportHistoryError(1, error('emptyCommit'), { op: 'cherryPick' });
    expect(toasts()[0]?.action?.label).toBe('Skip');
  });

  it('offers a merge commit after a refused fast-forward', () => {
    const onNotFastForward = vi.fn();
    reportHistoryError(1, error('notFastForward'), { op: 'merge', onNotFastForward });
    const action = toasts()[0]?.action;
    expect(action?.label).toBe('Merge instead…');
    action?.onClick();
    expect(onNotFastForward).toHaveBeenCalled();
  });

  it('points at the banner when an operation is already running', () => {
    reportHistoryError(1, error('operationInProgress'), { op: 'merge' });
    expect(toasts()[0]).toMatchObject({ variant: 'warning' });
    expect(toasts()[0]?.description).toContain('banner');
  });

  it('lists the files that block a dirty working tree', () => {
    reportHistoryError(
      1,
      error('dirtyWorktree', {
        kind: 'dirtyWorktree',
        paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        canCarry: false,
      }),
      { op: 'rebase' },
    );
    expect(toasts()[0]?.description).toContain('a.ts, b.ts, c.ts…');
  });

  it('falls back to the generic typed error toast', () => {
    reportHistoryError(1, error('internal'), { op: 'reset' });
    expect(toasts()[0]).toMatchObject({ variant: 'error', title: 'Reset failed' });
  });
});

describe('abortCommand', () => {
  it('shows the reset a squash merge really runs', () => {
    expect(abortCommand({ kind: 'merge', squash: true })).toBe('git reset -q --merge');
    expect(abortCommand({ kind: 'merge', squash: false })).toBe('git merge --abort');
  });
});
