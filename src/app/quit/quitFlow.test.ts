import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setEditorDirty, stopEditing } from '../../features/diff/fileEditStore';
import { useOpsStore } from '../../features/repo/opsStore';
import { useRepoSessions } from '../../features/repo/repoSessions';
import { mockBackend } from '../../ipc/mockClient';
import { useConfirmStore } from '../errors/confirmStore';
import { installQuitGuard, requestQuit, windowCloseRequested } from './quitFlow';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

let flush = vi.fn(() => Promise.resolve());
let uninstall: (() => void) | undefined;

function startPush() {
  useRepoSessions.setState({ sessions: { 1: { status: 'opening', name: 'api-backoffice' } } });
  useOpsStore.getState().started({ opId: 7, repoId: 1, kind: 'push', cancellable: true });
}

beforeEach(() => {
  mockBackend.reset();
  useOpsStore.setState(useOpsStore.getInitialState());
  useRepoSessions.setState({ sessions: {} });
  useConfirmStore.setState({ pending: null });
  flush = vi.fn(() => Promise.resolve());
  uninstall = installQuitGuard({ flush });
});

afterEach(() => {
  uninstall?.();
  stopEditing(1, 'a.ts');
});

describe('closing the window', () => {
  it('closes at once after the saves when nothing is in progress', async () => {
    await expect(windowCloseRequested({ vetoable: true })).resolves.toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it('stays open when the user cancels the confirmation', async () => {
    startPush();
    const closing = windowCloseRequested({ vetoable: true });
    await flushPromises();
    expect(useConfirmStore.getState().pending?.items).toEqual([
      { label: 'Push running in api-backoffice' },
    ]);
    useConfirmStore.getState().settle(false);
    await expect(closing).resolves.toBe(false);
    expect(flush).not.toHaveBeenCalled();
  });

  it('closes after "Quit anyway"', async () => {
    startPush();
    const closing = windowCloseRequested({ vetoable: true });
    useConfirmStore.getState().settle(true);
    await expect(closing).resolves.toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('only saves on a page unload, which cannot wait for an answer', async () => {
    startPush();
    await expect(windowCloseRequested({ vetoable: false })).resolves.toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe('quitting', () => {
  it('saves then asks the backend to quit', async () => {
    await requestQuit();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(mockBackend.quits).toBe(1);
  });

  it('does not quit when the user cancels', async () => {
    startPush();
    const quitting = requestQuit();
    await flushPromises();
    useConfirmStore.getState().settle(false);
    await quitting;
    expect(mockBackend.quits).toBe(0);
  });

  it('runs the guard on a native quit request (⌘Q, the macOS Dock)', async () => {
    startPush();
    mockBackend.simulateQuitRequest();
    await flushPromises();
    expect(useConfirmStore.getState().pending?.title).toBe('Quit yaggui?');
    useConfirmStore.getState().settle(true);
    await flushPromises();
    await flushPromises();
    expect(mockBackend.quits).toBe(1);
  });
});

describe('backend guard flag', () => {
  it('follows what is in progress', () => {
    expect(mockBackend.quitGuard).toBe(false);
    startPush();
    expect(mockBackend.quitGuard).toBe(true);
    useOpsStore
      .getState()
      .finished(1, { opId: 7, kind: 'push', outcome: 'success', finishedAt: 0 });
    expect(mockBackend.quitGuard).toBe(false);
    setEditorDirty(1, 'a.ts', true);
    expect(mockBackend.quitGuard).toBe(true);
  });
});
