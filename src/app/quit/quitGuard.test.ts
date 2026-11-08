import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keepDraft, setEditorDirty, stopEditing } from '../../features/diff/fileEditStore';
import {
  openInteractiveRebase,
  setRebaseEdited,
  setRebaseStop,
  useRebaseStore,
} from '../../features/rebase/rebaseStore';
import { useOpsStore } from '../../features/repo/opsStore';
import { useRepoSessions } from '../../features/repo/repoSessions';
import { translate } from '../../i18n/i18n';
import { useConfirmStore } from '../errors/confirmStore';
import {
  confirmLeave,
  currentPendingWork,
  pendingWork,
  pendingWorkLabel,
  type PendingWork,
} from './quitGuard';

const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params);
const fr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('fr', key, params);

const names: Record<number, string> = { 1: 'api-backoffice', 2: 'web' };
const repoName = (repoId: number) => names[repoId] ?? null;

function openSession(repoId: number) {
  useRepoSessions.setState((state) => ({
    sessions: { ...state.sessions, [repoId]: { status: 'opening', name: names[repoId] ?? null } },
  }));
}

function startOp(repoId: number, kind: 'push' | 'fetch', opId = repoId) {
  useOpsStore.getState().started({ opId, repoId, kind, cancellable: true });
}

beforeEach(() => {
  useOpsStore.setState(useOpsStore.getInitialState());
  useRebaseStore.setState(useRebaseStore.getInitialState());
  useRepoSessions.setState({ sessions: {} });
  useConfirmStore.setState({ pending: null });
});

afterEach(() => {
  stopEditing(1, 'src/app.ts');
  stopEditing(2, 'README.md');
  stopEditing(3, 'gone.txt');
});

describe('pendingWork', () => {
  it('lists running operations, edited rebases and unsaved files, in that order', () => {
    const work = pendingWork({
      running: [{ repoId: 1, kind: 'push' }],
      editedRebases: [2],
      unsavedFiles: [{ repoId: 1, path: 'src/app.ts' }],
      repoName,
    });
    expect(work).toEqual<PendingWork[]>([
      { kind: 'op', op: 'push', repo: 'api-backoffice' },
      { kind: 'rebase', repo: 'web' },
      { kind: 'file', path: 'src/app.ts', repo: 'api-backoffice' },
    ]);
  });

  it('is empty when nothing is in progress: the app quits at once', () => {
    expect(pendingWork({ running: [], editedRebases: [], unsavedFiles: [], repoName })).toEqual([]);
  });

  it('keeps an operation of an unknown repository, not the edits of a closed one', () => {
    const work = pendingWork({
      running: [{ repoId: 0, kind: 'fetch' }],
      editedRebases: [9],
      unsavedFiles: [{ repoId: 9, path: 'a.txt' }],
      repoName,
    });
    expect(work).toEqual<PendingWork[]>([{ kind: 'op', op: 'fetch', repo: null }]);
  });
});

describe('pendingWorkLabel', () => {
  it('names what is in progress and where, in both languages', () => {
    const push: PendingWork = { kind: 'op', op: 'push', repo: 'api-backoffice' };
    expect(pendingWorkLabel(push, en)).toBe('Push running in api-backoffice');
    expect(pendingWorkLabel(push, fr)).toBe('Push en cours dans api-backoffice');
    expect(pendingWorkLabel({ kind: 'op', op: 'config', repo: null }, en)).toBe(
      'Configuration running',
    );
    expect(pendingWorkLabel({ kind: 'rebase', repo: 'web' }, en)).toBe(
      'The interactive rebase of web has unsaved changes',
    );
    expect(pendingWorkLabel({ kind: 'file', path: 'a.ts', repo: 'web' }, fr)).toBe(
      'Modifications non enregistrées de a.ts dans web',
    );
  });
});

describe('currentPendingWork', () => {
  it('reads the operations, the rebase sessions and the file editors', () => {
    openSession(1);
    openSession(2);
    startOp(1, 'push');
    openInteractiveRebase(2, 'abc');
    setRebaseEdited(2, true);
    setEditorDirty(1, 'src/app.ts', true);
    keepDraft(2, 'README.md', { text: 'draft', version: 'v1' });
    expect(currentPendingWork()).toEqual<PendingWork[]>([
      { kind: 'op', op: 'push', repo: 'api-backoffice' },
      { kind: 'rebase', repo: 'web' },
      { kind: 'file', path: 'src/app.ts', repo: 'api-backoffice' },
      { kind: 'file', path: 'README.md', repo: 'web' },
    ]);
  });

  it('ignores an untouched rebase, a saved file and a finished operation', () => {
    openSession(1);
    startOp(1, 'push');
    useOpsStore.getState().finished(1, {
      opId: 1,
      kind: 'push',
      outcome: 'success',
      finishedAt: 0,
    });
    openInteractiveRebase(1, null);
    setEditorDirty(1, 'src/app.ts', true);
    setEditorDirty(1, 'src/app.ts', false);
    expect(currentPendingWork()).toEqual([]);
  });

  it('ignores a rebase that already started: nothing is lost by leaving it', () => {
    openSession(1);
    openInteractiveRebase(1, 'abc');
    setRebaseEdited(1, true);
    setRebaseStop(1, { kind: 'conflicts' });
    expect(currentPendingWork()).toEqual([]);
  });
});

describe('confirmLeave', () => {
  it('lets a clean app go without asking', async () => {
    await expect(confirmLeave()).resolves.toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it('asks once, names the work, and follows the answer', async () => {
    openSession(1);
    startOp(1, 'push');
    const first = confirmLeave();
    const second = confirmLeave();
    const pending = useConfirmStore.getState().pending;
    expect(pending?.title).toBe('Quit yaggui?');
    expect(pending?.confirmLabel).toBe('Quit anyway');
    expect(pending?.items).toEqual([{ label: 'Push running in api-backoffice' }]);
    useConfirmStore.getState().settle(false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);

    const again = confirmLeave();
    useConfirmStore.getState().settle(true);
    await expect(again).resolves.toBe(true);
  });
});
